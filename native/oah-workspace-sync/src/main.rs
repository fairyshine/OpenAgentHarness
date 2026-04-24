use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs;
use std::future::Future;
use std::io::{self, BufRead, BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use aws_credential_types::Credentials;
use aws_sdk_s3::config::Region;
use aws_sdk_s3::primitives::ByteStream;
use aws_sdk_s3::types::{Delete, ObjectIdentifier};
use aws_sdk_s3::Client as S3Client;
use clap::{Parser, Subcommand};
use filetime::{set_file_mtime, FileTime};
use reqwest::header::{HeaderMap, HeaderName, HeaderValue, CONTENT_TYPE};
use reqwest::{Client as HttpClient, StatusCode, Url};
use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;
use sha1::{Digest, Sha1};
use time::{format_description::well_known::Rfc3339, OffsetDateTime};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::runtime::Builder as RuntimeBuilder;
use tokio::task::JoinSet;

const PROTOCOL_VERSION: u32 = 1;
const BINARY_NAME: &str = "oah-workspace-sync";
const BINARY_VERSION: &str = env!("CARGO_PKG_VERSION");
const OBJECT_MTIME_METADATA_KEY: &str = "oah-mtime-ms";
const INTERNAL_SYNC_MANIFEST_RELATIVE_PATH: &str = ".oah-sync-manifest.json";

#[derive(Parser)]
#[command(name = BINARY_NAME, version = BINARY_VERSION, about = "Open Agent Harness native workspace sync utilities.")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    Version,
    Serve,
    Fingerprint,
    FingerprintBatch,
    ScanLocalTree,
    PlanLocalToRemote,
    SyncLocalToRemote,
    PlanRemoteToLocal,
    SyncRemoteToLocal,
    PlanSeedUpload,
    SyncLocalToSandboxHttp,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct VersionResponse<'a> {
    ok: bool,
    protocol_version: u32,
    name: &'a str,
    version: &'a str,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct FingerprintRequest {
    root_dir: String,
    #[serde(default)]
    exclude_relative_paths: Vec<String>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct FingerprintBatchRequest {
    directories: Vec<FingerprintRequest>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FingerprintResponse {
    ok: bool,
    protocol_version: u32,
    fingerprint: String,
    file_count: usize,
    empty_directory_count: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FingerprintBatchResponse {
    ok: bool,
    protocol_version: u32,
    results: Vec<FingerprintBatchEntry>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FingerprintBatchEntry {
    root_dir: String,
    fingerprint: String,
    file_count: usize,
    empty_directory_count: usize,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SyncLocalToRemoteRequest {
    root_dir: String,
    remote_prefix: String,
    #[serde(default)]
    exclude_relative_paths: Vec<String>,
    #[serde(default)]
    max_concurrency: Option<usize>,
    object_store: NativeObjectStoreConfig,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SyncRemoteToLocalRequest {
    root_dir: String,
    remote_prefix: String,
    #[serde(default)]
    exclude_relative_paths: Vec<String>,
    #[serde(default)]
    preserve_top_level_names: Vec<String>,
    #[serde(default)]
    max_concurrency: Option<usize>,
    object_store: NativeObjectStoreConfig,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SyncLocalToSandboxHttpRequest {
    root_dir: String,
    remote_root_path: String,
    #[serde(default)]
    exclude_relative_paths: Vec<String>,
    #[serde(default)]
    max_concurrency: Option<usize>,
    sandbox: NativeSandboxHttpConfig,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeObjectStoreConfig {
    bucket: String,
    region: String,
    endpoint: Option<String>,
    force_path_style: Option<bool>,
    access_key: Option<String>,
    secret_key: Option<String>,
    session_token: Option<String>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeSandboxHttpConfig {
    base_url: String,
    sandbox_id: String,
    #[serde(default)]
    headers: HashMap<String, String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ErrorResponse {
    ok: bool,
    protocol_version: u32,
    code: &'static str,
    message: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkerRequest {
    request_id: String,
    command: String,
    payload: Option<Value>,
}

#[derive(Default)]
struct Snapshot {
    files: Vec<FileEntry>,
    directories: BTreeSet<String>,
    empty_directories: BTreeSet<String>,
    ignored_paths: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ScanLocalTreeResponse {
    ok: bool,
    protocol_version: u32,
    fingerprint: String,
    files: Vec<ScanFileEntry>,
    directories: Vec<String>,
    empty_directories: Vec<String>,
}

struct FileEntry {
    relative_path: String,
    absolute_path: String,
    size: u64,
    mtime_ms: u128,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ScanFileEntry {
    relative_path: String,
    absolute_path: String,
    size: u64,
    mtime_ms: u128,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlanLocalToRemoteRequest {
    root_dir: String,
    #[serde(default)]
    exclude_relative_paths: Vec<String>,
    #[serde(default)]
    preserve_top_level_names: Vec<String>,
    #[serde(default)]
    remote_entries: Vec<PlanRemoteEntry>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlanSeedUploadRequest {
    root_dir: String,
    remote_base_path: String,
    #[serde(default)]
    exclude_relative_paths: Vec<String>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlanRemoteEntry {
    relative_path: String,
    key: String,
    size: u64,
    #[allow(dead_code)]
    last_modified_ms: Option<u128>,
    is_directory: bool,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SyncManifestFileEntry {
    size: u64,
    mtime_ms: u128,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SyncManifestDocument {
    version: u32,
    files: BTreeMap<String, SyncManifestFileEntry>,
}

struct RemoteEntryListing {
    entries: Vec<PlanRemoteEntry>,
    has_sync_manifest: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PlanLocalToRemoteResponse {
    ok: bool,
    protocol_version: u32,
    fingerprint: String,
    upload_candidates: Vec<PlanUploadCandidate>,
    info_check_candidates: Vec<PlanUploadCandidate>,
    empty_directories_to_create: Vec<String>,
    keys_to_delete: Vec<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PlanUploadCandidate {
    relative_path: String,
    absolute_path: String,
    size: u64,
    mtime_ms: u128,
    remote_key: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PlanDownloadCandidate {
    relative_path: String,
    target_path: String,
    size: u64,
    remote_key: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PlanRemoteToLocalResponse {
    ok: bool,
    protocol_version: u32,
    remove_paths: Vec<String>,
    directories_to_create: Vec<String>,
    download_candidates: Vec<PlanDownloadCandidate>,
    info_check_candidates: Vec<PlanDownloadCandidate>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PlanSeedUploadResponse {
    ok: bool,
    protocol_version: u32,
    fingerprint: String,
    directories: Vec<String>,
    files: Vec<PlanSeedUploadFile>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PlanSeedUploadFile {
    relative_path: String,
    absolute_path: String,
    remote_path: String,
    size: u64,
    mtime_ms: u128,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SyncLocalToRemoteResponse {
    ok: bool,
    protocol_version: u32,
    local_fingerprint: String,
    uploaded_file_count: usize,
    deleted_remote_count: usize,
    created_empty_directory_count: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SyncRemoteToLocalResponse {
    ok: bool,
    protocol_version: u32,
    local_fingerprint: String,
    removed_path_count: usize,
    created_directory_count: usize,
    downloaded_file_count: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SyncLocalToSandboxHttpResponse {
    ok: bool,
    protocol_version: u32,
    local_fingerprint: String,
    created_directory_count: usize,
    uploaded_file_count: usize,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeSandboxHttpFileStat {
    kind: String,
    size: u64,
    mtime_ms: f64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeSandboxHttpEntryPage {
    items: Vec<NativeSandboxHttpEntry>,
    next_cursor: Option<String>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeSandboxHttpEntry {
    path: String,
    #[serde(rename = "type")]
    entry_type: String,
    size_bytes: Option<u64>,
    updated_at: Option<String>,
}

struct NativeSandboxHttpRemoteState {
    existing_directories: BTreeSet<String>,
    existing_file_stats: BTreeMap<String, NativeSandboxHttpFileStat>,
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            let payload = ErrorResponse {
                ok: false,
                protocol_version: PROTOCOL_VERSION,
                code: "native_workspace_sync_failed",
                message: error,
            };
            let rendered = serde_json::to_string(&payload).unwrap_or_else(|serialization_error| {
                format!(
                    "{{\"ok\":false,\"protocolVersion\":{},\"code\":\"native_workspace_sync_failed\",\"message\":\"{}\"}}",
                    PROTOCOL_VERSION, serialization_error
                )
            });
            eprintln!("{rendered}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<(), String> {
    let cli = Cli::parse();
    match cli.command {
        Command::Version => write_json_value(&handle_command("version", None, None)?),
        Command::Serve => serve(),
        Command::Fingerprint => {
            write_json_value(&handle_command("fingerprint", Some(read_json_stdin_value()?), None)?)
        }
        Command::FingerprintBatch => {
            write_json_value(&handle_command("fingerprint-batch", Some(read_json_stdin_value()?), None)?)
        }
        Command::ScanLocalTree => {
            write_json_value(&handle_command("scan-local-tree", Some(read_json_stdin_value()?), None)?)
        }
        Command::PlanLocalToRemote => {
            write_json_value(&handle_command("plan-local-to-remote", Some(read_json_stdin_value()?), None)?)
        }
        Command::SyncLocalToRemote => {
            let runtime = build_runtime()?;
            write_json_value(&handle_command(
                "sync-local-to-remote",
                Some(read_json_stdin_value()?),
                Some(&runtime),
            )?)
        }
        Command::PlanRemoteToLocal => {
            write_json_value(&handle_command("plan-remote-to-local", Some(read_json_stdin_value()?), None)?)
        }
        Command::SyncRemoteToLocal => {
            let runtime = build_runtime()?;
            write_json_value(&handle_command(
                "sync-remote-to-local",
                Some(read_json_stdin_value()?),
                Some(&runtime),
            )?)
        }
        Command::PlanSeedUpload => {
            write_json_value(&handle_command("plan-seed-upload", Some(read_json_stdin_value()?), None)?)
        }
        Command::SyncLocalToSandboxHttp => {
            let runtime = build_runtime()?;
            write_json_value(&handle_command(
                "sync-local-to-sandbox-http",
                Some(read_json_stdin_value()?),
                Some(&runtime),
            )?)
        }
    }
}

struct LocalToRemotePlan {
    upload_candidates: Vec<PlanUploadCandidate>,
    info_check_candidates: Vec<PlanUploadCandidate>,
    empty_directories_to_create: Vec<String>,
    keys_to_delete: Vec<String>,
}

struct RemoteToLocalPlan {
    remove_paths: Vec<String>,
    directories_to_create: Vec<String>,
    download_candidates: Vec<PlanDownloadCandidate>,
    info_check_candidates: Vec<PlanDownloadCandidate>,
}

struct SeedUploadPlan {
    directories: Vec<String>,
    files: Vec<PlanSeedUploadFile>,
}

fn build_runtime() -> Result<tokio::runtime::Runtime, String> {
    RuntimeBuilder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(|error| format!("Failed to initialize async runtime: {error}"))
}

fn read_json_stdin<T: for<'de> Deserialize<'de>>() -> Result<T, String> {
    let mut input = String::new();
    io::stdin()
        .read_to_string(&mut input)
        .map_err(|error| format!("Failed to read stdin: {error}"))?;
    serde_json::from_str::<T>(&input)
        .map_err(|error| format!("Failed to decode stdin JSON: {error}"))
}

fn read_json_stdin_value() -> Result<Value, String> {
    read_json_stdin::<Value>()
}

fn write_json<T: Serialize>(payload: &T) -> Result<(), String> {
    let rendered = serde_json::to_string(payload)
        .map_err(|error| format!("Failed to serialize JSON response: {error}"))?;
    println!("{rendered}");
    Ok(())
}

fn write_json_value(payload: &Value) -> Result<(), String> {
    write_json(payload)
}

fn parse_payload<T: DeserializeOwned>(payload: Option<Value>, command: &str) -> Result<T, String> {
    let payload = payload.ok_or_else(|| format!("Missing JSON payload for command {command}"))?;
    serde_json::from_value(payload)
        .map_err(|error| format!("Failed to decode JSON payload for command {command}: {error}"))
}

fn serialize_json_value<T: Serialize>(payload: &T) -> Result<Value, String> {
    serde_json::to_value(payload)
        .map_err(|error| format!("Failed to serialize command response: {error}"))
}

fn handle_command(
    command: &str,
    payload: Option<Value>,
    runtime: Option<&tokio::runtime::Runtime>,
) -> Result<Value, String> {
    match command {
        "version" => serialize_json_value(&VersionResponse {
            ok: true,
            protocol_version: PROTOCOL_VERSION,
            name: BINARY_NAME,
            version: BINARY_VERSION,
        }),
        "fingerprint" => {
            let request: FingerprintRequest = parse_payload(payload, command)?;
            let excludes = normalize_exclude_paths(request.exclude_relative_paths);
            let snapshot = collect_snapshot(&PathBuf::from(request.root_dir), &excludes)?;
            serialize_json_value(&FingerprintResponse {
                ok: true,
                protocol_version: PROTOCOL_VERSION,
                fingerprint: create_fingerprint(&snapshot),
                file_count: snapshot.files.len(),
                empty_directory_count: snapshot.empty_directories.len(),
            })
        }
        "fingerprint-batch" => {
            let request: FingerprintBatchRequest = parse_payload(payload, command)?;
            let mut results = Vec::with_capacity(request.directories.len());
            for directory in request.directories {
                let excludes = normalize_exclude_paths(directory.exclude_relative_paths);
                let snapshot = collect_snapshot(&PathBuf::from(&directory.root_dir), &excludes)?;
                results.push(FingerprintBatchEntry {
                    root_dir: directory.root_dir,
                    fingerprint: create_fingerprint(&snapshot),
                    file_count: snapshot.files.len(),
                    empty_directory_count: snapshot.empty_directories.len(),
                });
            }
            serialize_json_value(&FingerprintBatchResponse {
                ok: true,
                protocol_version: PROTOCOL_VERSION,
                results,
            })
        }
        "scan-local-tree" => {
            let request: FingerprintRequest = parse_payload(payload, command)?;
            let excludes = normalize_exclude_paths(request.exclude_relative_paths);
            let snapshot = collect_snapshot(&PathBuf::from(request.root_dir), &excludes)?;
            serialize_json_value(&ScanLocalTreeResponse {
                ok: true,
                protocol_version: PROTOCOL_VERSION,
                fingerprint: create_fingerprint(&snapshot),
                files: snapshot
                    .files
                    .into_iter()
                    .map(|file| ScanFileEntry {
                        relative_path: file.relative_path,
                        absolute_path: file.absolute_path,
                        size: file.size,
                        mtime_ms: file.mtime_ms,
                    })
                    .collect(),
                directories: snapshot.directories.into_iter().collect(),
                empty_directories: snapshot.empty_directories.into_iter().collect(),
            })
        }
        "plan-local-to-remote" => {
            let request: PlanLocalToRemoteRequest = parse_payload(payload, command)?;
            let excludes = normalize_exclude_paths(request.exclude_relative_paths);
            let snapshot = collect_snapshot(&PathBuf::from(request.root_dir), &excludes)?;
            let fingerprint = create_fingerprint(&snapshot);
            let plan = create_local_to_remote_plan(&snapshot, request.remote_entries);
            serialize_json_value(&PlanLocalToRemoteResponse {
                ok: true,
                protocol_version: PROTOCOL_VERSION,
                fingerprint,
                upload_candidates: plan.upload_candidates,
                info_check_candidates: plan.info_check_candidates,
                empty_directories_to_create: plan.empty_directories_to_create,
                keys_to_delete: plan.keys_to_delete,
            })
        }
        "sync-local-to-remote" => {
            let request: SyncLocalToRemoteRequest = parse_payload(payload, command)?;
            let runtime = runtime
                .ok_or_else(|| "Async runtime is required for sync-local-to-remote.".to_string())?;
            serialize_json_value(&runtime.block_on(sync_local_to_remote(request))?)
        }
        "plan-remote-to-local" => {
            let request: PlanLocalToRemoteRequest = parse_payload(payload, command)?;
            let excludes = normalize_exclude_paths(request.exclude_relative_paths);
            let root_dir = PathBuf::from(&request.root_dir);
            let snapshot = collect_snapshot(&root_dir, &excludes)?;
            let plan = create_remote_to_local_plan(
                &root_dir,
                &snapshot,
                request.remote_entries,
                normalize_exclude_paths(request.preserve_top_level_names),
            );
            serialize_json_value(&PlanRemoteToLocalResponse {
                ok: true,
                protocol_version: PROTOCOL_VERSION,
                remove_paths: plan.remove_paths,
                directories_to_create: plan.directories_to_create,
                download_candidates: plan.download_candidates,
                info_check_candidates: plan.info_check_candidates,
            })
        }
        "sync-remote-to-local" => {
            let request: SyncRemoteToLocalRequest = parse_payload(payload, command)?;
            let runtime = runtime
                .ok_or_else(|| "Async runtime is required for sync-remote-to-local.".to_string())?;
            serialize_json_value(&runtime.block_on(sync_remote_to_local(request))?)
        }
        "plan-seed-upload" => {
            let request: PlanSeedUploadRequest = parse_payload(payload, command)?;
            let excludes = normalize_exclude_paths(request.exclude_relative_paths);
            let snapshot = collect_snapshot(&PathBuf::from(request.root_dir), &excludes)?;
            let fingerprint = create_fingerprint(&snapshot);
            let plan = create_seed_upload_plan(&snapshot, &request.remote_base_path);
            serialize_json_value(&PlanSeedUploadResponse {
                ok: true,
                protocol_version: PROTOCOL_VERSION,
                fingerprint,
                directories: plan.directories,
                files: plan.files,
            })
        }
        "sync-local-to-sandbox-http" => {
            let request: SyncLocalToSandboxHttpRequest = parse_payload(payload, command)?;
            let runtime = runtime
                .ok_or_else(|| "Async runtime is required for sync-local-to-sandbox-http.".to_string())?;
            serialize_json_value(&runtime.block_on(sync_local_to_sandbox_http(request))?)
        }
        _ => Err(format!("Unknown command: {command}")),
    }
}

fn command_requires_runtime(command: &str) -> bool {
    matches!(
        command,
        "sync-local-to-remote" | "sync-remote-to-local" | "sync-local-to-sandbox-http"
    )
}

fn handle_worker_request(
    request: WorkerRequest,
    runtime: &mut Option<tokio::runtime::Runtime>,
) -> Value {
    let runtime_ref = if command_requires_runtime(&request.command) {
        if runtime.is_none() {
            match build_runtime() {
                Ok(created_runtime) => {
                    *runtime = Some(created_runtime);
                }
                Err(error) => {
                    return serde_json::json!({
                        "ok": false,
                        "protocolVersion": PROTOCOL_VERSION,
                        "requestId": request.request_id,
                        "code": "native_workspace_sync_failed",
                        "message": error
                    });
                }
            }
        }
        runtime.as_ref()
    } else {
        None
    };

    match handle_command(&request.command, request.payload, runtime_ref) {
        Ok(mut payload) => {
            if let Value::Object(map) = &mut payload {
                map.insert("requestId".to_string(), Value::String(request.request_id));
            }
            payload
        }
        Err(error) => serde_json::json!({
            "ok": false,
            "protocolVersion": PROTOCOL_VERSION,
            "requestId": request.request_id,
            "code": "native_workspace_sync_failed",
            "message": error
        }),
    }
}

fn serve() -> Result<(), String> {
    let mut runtime = None;
    let stdin = io::stdin();
    let stdout = io::stdout();
    let reader = BufReader::new(stdin.lock());
    let mut writer = BufWriter::new(stdout.lock());

    for line in reader.lines() {
        let line = line.map_err(|error| format!("Failed to read worker request: {error}"))?;
        if line.trim().is_empty() {
            continue;
        }

        let request = serde_json::from_str::<WorkerRequest>(&line)
            .map_err(|error| format!("Failed to decode worker request JSON: {error}"))?;
        let response = handle_worker_request(request, &mut runtime);
        let rendered = serde_json::to_string(&response)
            .map_err(|error| format!("Failed to serialize worker response JSON: {error}"))?;
        writer
            .write_all(rendered.as_bytes())
            .map_err(|error| format!("Failed to write worker response: {error}"))?;
        writer
            .write_all(b"\n")
            .map_err(|error| format!("Failed to write worker response newline: {error}"))?;
        writer
            .flush()
            .map_err(|error| format!("Failed to flush worker response: {error}"))?;
    }

    Ok(())
}

fn normalize_path(value: &Path) -> String {
    value.to_string_lossy().replace('\\', "/")
}

fn normalize_relative_path(value: &str) -> String {
    value.replace('\\', "/").trim_matches('/').to_string()
}

fn parse_object_mtime_ms(metadata: Option<&HashMap<String, String>>) -> Option<u128> {
    metadata
        .and_then(|metadata| metadata.get(OBJECT_MTIME_METADATA_KEY))
        .and_then(|value| value.parse::<u128>().ok())
        .filter(|value| *value > 0)
}

fn system_time_to_mtime_ms(value: SystemTime) -> Option<u128> {
    value
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|duration| duration.as_millis())
}

fn file_time_from_mtime_ms(value: u128) -> FileTime {
    let seconds = (value / 1000).min(i64::MAX as u128) as i64;
    let nanos = ((value % 1000) * 1_000_000) as u32;
    FileTime::from_unix_time(seconds, nanos)
}

fn resolve_max_concurrency(value: Option<usize>) -> usize {
    value.filter(|value| *value > 0).unwrap_or(1)
}

#[derive(Clone)]
struct NativeSandboxHttpClient {
    client: HttpClient,
    base_url: String,
    route_prefix: String,
    sandbox_id: String,
}

fn parse_sandbox_http_base_url(input: &str) -> (String, String) {
    let trimmed = input.trim();
    if let Ok(mut url) = Url::parse(trimmed) {
        let path = url.path().trim_end_matches('/').to_string();
        let route_prefix = if path.ends_with("/internal/v1") {
            "/internal/v1"
        } else if path.ends_with("/api/v1") {
            "/api/v1"
        } else {
            ""
        };
        let normalized_path = if route_prefix.is_empty() {
            path
        } else {
            path.trim_end_matches(route_prefix).trim_end_matches('/').to_string()
        };
        url.set_path(if normalized_path.is_empty() {
            "/"
        } else {
            &normalized_path
        });
        url.set_query(None);
        url.set_fragment(None);
        return (
            url.to_string().trim_end_matches('/').to_string(),
            route_prefix.to_string(),
        );
    }

    let trimmed = trimmed.trim_end_matches('/').to_string();
    if let Some(base_url) = trimmed.strip_suffix("/internal/v1") {
        return (base_url.trim_end_matches('/').to_string(), "/internal/v1".to_string());
    }
    if let Some(base_url) = trimmed.strip_suffix("/api/v1") {
        return (base_url.trim_end_matches('/').to_string(), "/api/v1".to_string());
    }
    (trimmed, String::new())
}

impl NativeSandboxHttpClient {
    fn new(config: &NativeSandboxHttpConfig) -> Result<Self, String> {
        let mut headers = HeaderMap::new();
        for (key, value) in &config.headers {
            let name = HeaderName::from_bytes(key.as_bytes())
                .map_err(|error| format!("Invalid sandbox HTTP header name {key:?}: {error}"))?;
            let header_value = HeaderValue::from_str(value)
                .map_err(|error| format!("Invalid sandbox HTTP header value for {key:?}: {error}"))?;
            headers.insert(name, header_value);
        }

        let client = HttpClient::builder()
            .default_headers(headers)
            .build()
            .map_err(|error| format!("Failed to initialize sandbox HTTP client: {error}"))?;
        let (base_url, route_prefix) = parse_sandbox_http_base_url(&config.base_url);

        Ok(Self {
            client,
            base_url,
            route_prefix,
            sandbox_id: config.sandbox_id.clone(),
        })
    }

    fn build_url(&self, request_path: &str, query: &[(&str, String)]) -> Result<Url, String> {
        let mapped_path = if self.route_prefix.is_empty() {
            request_path.to_string()
        } else {
            request_path.replacen("/api/v1", &self.route_prefix, 1)
        };
        let mut url = Url::parse(&format!("{}{}", self.base_url, mapped_path))
            .map_err(|error| format!("Failed to build sandbox HTTP URL: {error}"))?;
        for (key, value) in query {
            url.query_pairs_mut().append_pair(key, value);
        }
        Ok(url)
    }

    async fn create_directory(&self, path: &str) -> Result<(), String> {
        let url = self.build_url(
            &format!("/api/v1/sandboxes/{}/directories", self.sandbox_id),
            &[],
        )?;
        let response = self
            .client
            .post(url)
            .json(&serde_json::json!({
                "path": path,
                "createParents": true
            }))
            .send()
            .await
            .map_err(|error| format!("Failed to create sandbox directory {path}: {error}"))?;
        if response.status().is_success() {
            return Ok(());
        }

        let status = response.status();
        let body = response
            .text()
            .await
            .unwrap_or_else(|_| String::from("<unavailable>"));
        Err(format!(
            "Failed to create sandbox directory {path}: HTTP {status} {body}"
        ))
    }

    async fn upload_file(
        &self,
        path: &str,
        data: Vec<u8>,
        mtime_ms: u128,
    ) -> Result<(), String> {
        let url = self.build_url(
            &format!("/api/v1/sandboxes/{}/files/upload", self.sandbox_id),
            &[
                ("path", path.to_string()),
                ("overwrite", "true".to_string()),
                ("mtimeMs", mtime_ms.to_string()),
            ],
        )?;
        let response = self
            .client
            .put(url)
            .header(CONTENT_TYPE, "application/octet-stream")
            .body(data)
            .send()
            .await
            .map_err(|error| format!("Failed to upload sandbox file {path}: {error}"))?;
        if response.status().is_success() {
            return Ok(());
        }

        let status = response.status();
        let body = response
            .text()
            .await
            .unwrap_or_else(|_| String::from("<unavailable>"));
        Err(format!(
            "Failed to upload sandbox file {path}: HTTP {status} {body}"
        ))
    }

    async fn stat_path(&self, path: &str) -> Result<Option<NativeSandboxHttpFileStat>, String> {
        let url = self.build_url(
            &format!("/api/v1/sandboxes/{}/files/stat", self.sandbox_id),
            &[("path", path.to_string())],
        )?;
        let response = self
            .client
            .get(url)
            .send()
            .await
            .map_err(|error| format!("Failed to stat sandbox file {path}: {error}"))?;
        if response.status() == StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if response.status().is_success() {
            let payload = response.json::<NativeSandboxHttpFileStat>().await.map_err(|error| {
                format!("Failed to decode sandbox file stat response for {path}: {error}")
            })?;
            return Ok(Some(payload));
        }

        let status = response.status();
        let body = response
            .text()
            .await
            .unwrap_or_else(|_| String::from("<unavailable>"));
        Err(format!(
            "Failed to stat sandbox file {path}: HTTP {status} {body}"
        ))
    }

    async fn list_entries(
        &self,
        path: &str,
        cursor: Option<&str>,
    ) -> Result<NativeSandboxHttpEntryPage, String> {
        let mut query = vec![
            ("path", path.to_string()),
            ("pageSize", "200".to_string()),
            ("sortBy", "name".to_string()),
            ("sortOrder", "asc".to_string()),
        ];
        if let Some(cursor) = cursor {
            query.push(("cursor", cursor.to_string()));
        }
        let url = self.build_url(
            &format!("/api/v1/sandboxes/{}/files/entries", self.sandbox_id),
            &query,
        )?;
        let response = self
            .client
            .get(url)
            .send()
            .await
            .map_err(|error| format!("Failed to list sandbox entries under {path}: {error}"))?;
        if response.status() == StatusCode::NOT_FOUND {
            return Ok(NativeSandboxHttpEntryPage {
                items: Vec::new(),
                next_cursor: None,
            });
        }
        if response.status().is_success() {
            return response
                .json::<NativeSandboxHttpEntryPage>()
                .await
                .map_err(|error| {
                    format!("Failed to decode sandbox entry listing for {path}: {error}")
                });
        }

        let status = response.status();
        let body = response
            .text()
            .await
            .unwrap_or_else(|_| String::from("<unavailable>"));
        Err(format!(
            "Failed to list sandbox entries under {path}: HTTP {status} {body}"
        ))
    }

    async fn delete_entry(&self, path: &str, recursive: bool) -> Result<(), String> {
        let url = self.build_url(
            &format!("/api/v1/sandboxes/{}/files/entry", self.sandbox_id),
            &[
                ("path", path.to_string()),
                ("recursive", recursive.to_string()),
            ],
        )?;
        let response = self
            .client
            .delete(url)
            .send()
            .await
            .map_err(|error| format!("Failed to delete sandbox entry {path}: {error}"))?;
        if response.status() == StatusCode::NOT_FOUND {
            return Ok(());
        }
        if response.status().is_success() {
            return Ok(());
        }

        let status = response.status();
        let body = response
            .text()
            .await
            .unwrap_or_else(|_| String::from("<unavailable>"));
        Err(format!(
            "Failed to delete sandbox entry {path}: HTTP {status} {body}"
        ))
    }
}

fn sandbox_mtime_matches(local_mtime_ms: u128, remote_mtime_ms: f64) -> bool {
    (remote_mtime_ms - local_mtime_ms as f64).abs() < 1.0
}

fn sandbox_file_matches(local_size: u64, local_mtime_ms: u128, remote: &NativeSandboxHttpFileStat) -> bool {
    remote.kind == "file"
        && remote.size == local_size
        && sandbox_mtime_matches(local_mtime_ms, remote.mtime_ms)
}

fn parse_workspace_entry_updated_at_ms(value: &str) -> Option<f64> {
    let parsed = OffsetDateTime::parse(value.trim(), &Rfc3339).ok()?;
    Some(parsed.unix_timestamp_nanos() as f64 / 1_000_000.0)
}

fn sandbox_entry_file_stat(entry: &NativeSandboxHttpEntry) -> Option<NativeSandboxHttpFileStat> {
    if entry.entry_type != "file" {
        return None;
    }

    Some(NativeSandboxHttpFileStat {
        kind: "file".to_string(),
        size: entry.size_bytes?,
        mtime_ms: parse_workspace_entry_updated_at_ms(entry.updated_at.as_deref()?)?,
    })
}

async fn process_with_concurrency<T, R, F, Fut>(
    items: Vec<T>,
    max_concurrency: usize,
    worker: F,
) -> Result<Vec<R>, String>
where
    T: Send + 'static,
    R: Send + 'static,
    F: Fn(T) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = Result<R, String>> + Send + 'static,
{
    if items.is_empty() {
        return Ok(Vec::new());
    }

    let worker = Arc::new(worker);
    let mut pending = items.into_iter();
    let mut join_set = JoinSet::new();
    let mut in_flight = 0usize;
    let limit = max_concurrency.max(1);
    let mut results = Vec::new();

    loop {
        while in_flight < limit {
            let Some(item) = pending.next() else {
                break;
            };
            let worker = Arc::clone(&worker);
            join_set.spawn(async move { worker(item).await });
            in_flight += 1;
        }

        if in_flight == 0 {
            break;
        }

        let next = join_set.join_next().await.ok_or_else(|| {
            "Native workspace sync concurrency worker exited unexpectedly.".to_string()
        })?;
        in_flight -= 1;
        let result =
            next.map_err(|error| format!("Native workspace sync worker task failed: {error}"))??;
        results.push(result);
    }

    Ok(results)
}

fn build_remote_path(base_path: &str, relative_path: &str) -> String {
    let normalized_base = base_path.replace('\\', "/").trim_end_matches('/').to_string();
    let normalized_relative = normalize_relative_path(relative_path);

    if normalized_base.is_empty() {
        return normalized_relative;
    }

    if normalized_relative.is_empty() {
        return normalized_base;
    }

    format!("{normalized_base}/{normalized_relative}")
}

async fn collect_remote_sandbox_entries(
    sandbox_client: &NativeSandboxHttpClient,
    root_path: &str,
) -> Result<Vec<NativeSandboxHttpEntry>, String> {
    let mut directories_to_visit = vec![root_path.to_string()];
    let mut collected = Vec::new();

    while let Some(current_path) = directories_to_visit.pop() {
        let mut cursor: Option<String> = None;
        loop {
            let page = sandbox_client
                .list_entries(&current_path, cursor.as_deref())
                .await?;
            for entry in page.items {
                if entry.entry_type == "directory" {
                    directories_to_visit.push(entry.path.clone());
                }
                collected.push(entry);
            }

            match page.next_cursor {
                Some(next_cursor) => {
                    cursor = Some(next_cursor);
                }
                None => break,
            }
        }
    }

    Ok(collected)
}

async fn prune_unexpected_remote_sandbox_entries(
    sandbox_client: &NativeSandboxHttpClient,
    root_path: &str,
    expected_directories: &BTreeSet<String>,
    expected_files: &BTreeSet<String>,
) -> Result<NativeSandboxHttpRemoteState, String> {
    let mut keep_directories = expected_directories.clone();
    keep_directories.insert(root_path.to_string());
    let mut remote_entries = collect_remote_sandbox_entries(sandbox_client, root_path).await?;
    remote_entries.sort_by(|left, right| right.path.len().cmp(&left.path.len()));
    let mut remote_state = NativeSandboxHttpRemoteState {
        existing_directories: BTreeSet::new(),
        existing_file_stats: BTreeMap::new(),
    };

    for entry in remote_entries {
        if should_keep_remote_sandbox_entry(
            &entry,
            &keep_directories,
            expected_files,
        ) {
            if entry.entry_type == "directory" {
                remote_state.existing_directories.insert(entry.path.clone());
            } else if let Some(file_stat) = sandbox_entry_file_stat(&entry) {
                remote_state
                    .existing_file_stats
                    .insert(entry.path.clone(), file_stat);
            }
            continue;
        }

        sandbox_client
            .delete_entry(&entry.path, entry.entry_type == "directory")
            .await?;
    }

    Ok(remote_state)
}

fn should_keep_remote_sandbox_entry(
    entry: &NativeSandboxHttpEntry,
    expected_directories: &BTreeSet<String>,
    expected_files: &BTreeSet<String>,
) -> bool {
    let keep_directory = entry.entry_type == "directory"
        && expected_directories.contains(&entry.path)
        && !expected_files.contains(&entry.path);
    let keep_file = entry.entry_type == "file"
        && expected_files.contains(&entry.path)
        && !expected_directories.contains(&entry.path);
    keep_directory || keep_file
}

fn normalize_exclude_paths(paths: Vec<String>) -> Vec<String> {
    paths
        .into_iter()
        .map(|path| normalize_relative_path(&path))
        .filter(|path| !path.is_empty())
        .collect()
}

fn should_ignore_relative_path(relative_path: &str) -> bool {
    if relative_path.is_empty() {
        return false;
    }

    if normalize_relative_path(relative_path) == INTERNAL_SYNC_MANIFEST_RELATIVE_PATH {
        return true;
    }

    let segments: Vec<&str> = relative_path.split('/').collect();
    if segments.iter().any(|segment| *segment == "__pycache__") {
        return true;
    }

    match segments.last().copied() {
        Some(".DS_Store") => true,
        Some(basename) if basename.ends_with(".pyc") => true,
        Some(basename) if basename.ends_with(".db-shm") => true,
        Some(basename) if basename.ends_with(".db-wal") => true,
        _ => false,
    }
}

fn should_exclude_relative_path(relative_path: &str, excludes: &[String]) -> bool {
    excludes.iter().any(|exclude| {
        relative_path == exclude || relative_path.starts_with(&format!("{exclude}/"))
    })
}

fn relative_path_from_remote_key(prefix: &str, key: &str) -> Option<String> {
    let normalized_prefix = normalize_relative_path(prefix);
    if normalized_prefix.is_empty() {
        return Some(normalize_relative_path(key));
    }

    if key == normalized_prefix {
        return Some(String::new());
    }

    key.strip_prefix(&format!("{normalized_prefix}/"))
        .map(normalize_relative_path)
}

fn collect_snapshot(root_dir: &Path, excludes: &[String]) -> Result<Snapshot, String> {
    match fs::metadata(root_dir) {
        Ok(metadata) if metadata.is_dir() => {
            let mut snapshot = Snapshot::default();
            walk_directory(root_dir, root_dir, excludes, &mut snapshot)?;
            Ok(snapshot)
        }
        Ok(_) => Ok(Snapshot::default()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(Snapshot::default()),
        Err(error) => Err(format!("Failed to stat {}: {error}", root_dir.display())),
    }
}

fn walk_directory(
    directory: &Path,
    root_dir: &Path,
    excludes: &[String],
    snapshot: &mut Snapshot,
) -> Result<(), String> {
    let mut entries = match fs::read_dir(directory) {
        Ok(entries) => entries.collect::<Result<Vec<_>, _>>().map_err(|error| {
            format!("Failed to read directory {}: {error}", directory.display())
        })?,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(format!(
                "Failed to read directory {}: {error}",
                directory.display()
            ))
        }
    };

    entries.sort_by(|left, right| left.file_name().cmp(&right.file_name()));

    let mut visible_children = 0usize;
    let mut suppressed_children = false;

    for entry in entries {
        let absolute_path = entry.path();
        let relative_path = match absolute_path.strip_prefix(root_dir) {
            Ok(path) => normalize_relative_path(&normalize_path(path)),
            Err(_) => continue,
        };

        if should_ignore_relative_path(&relative_path) {
            snapshot.ignored_paths.push(normalize_path(&absolute_path));
            suppressed_children = true;
            continue;
        }

        if should_exclude_relative_path(&relative_path, excludes) {
            suppressed_children = true;
            continue;
        }

        let file_type = entry.file_type().map_err(|error| {
            format!(
                "Failed to read file type for {}: {error}",
                absolute_path.display()
            )
        })?;

        visible_children += 1;

        if file_type.is_dir() {
            if !relative_path.is_empty() {
                snapshot.directories.insert(relative_path.clone());
            }
            walk_directory(&absolute_path, root_dir, excludes, snapshot)?;
            continue;
        }

        if !file_type.is_file() {
            continue;
        }

        let metadata = match entry.metadata() {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => {
                return Err(format!(
                    "Failed to read metadata for {}: {error}",
                    absolute_path.display()
                ))
            }
        };

        let mtime_ms = metadata
            .modified()
            .ok()
            .and_then(|modified_at| modified_at.duration_since(UNIX_EPOCH).ok())
            .map(|duration| duration.as_millis())
            .unwrap_or_default();

        snapshot.files.push(FileEntry {
            relative_path,
            absolute_path: normalize_path(&absolute_path),
            size: metadata.len(),
            mtime_ms,
        });
    }

    let relative_directory = match directory.strip_prefix(root_dir) {
        Ok(path) => normalize_relative_path(&normalize_path(path)),
        Err(_) => String::new(),
    };

    if visible_children == 0 && !relative_directory.is_empty() && !suppressed_children {
        snapshot.empty_directories.insert(relative_directory);
    }

    Ok(())
}

fn create_fingerprint(snapshot: &Snapshot) -> String {
    let mut hash = Sha1::new();
    let mut files = snapshot.files.iter().collect::<Vec<_>>();
    files.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));

    for file in files {
        hash.update(
            format!(
                "file:{}:{}:{}\n",
                file.relative_path, file.size, file.mtime_ms
            )
            .as_bytes(),
        );
    }

    for relative_directory in &snapshot.empty_directories {
        hash.update(format!("dir:{relative_directory}\n").as_bytes());
    }

    format!("{:x}", hash.finalize())
}

fn create_fingerprint_from_entries(
    files: &[(String, u64, u128)],
    empty_directories: &BTreeSet<String>,
) -> String {
    let mut hash = Sha1::new();
    let mut sorted_files = files.iter().collect::<Vec<_>>();
    sorted_files.sort_by(|left, right| left.0.cmp(&right.0));

    for (relative_path, size, mtime_ms) in sorted_files {
        hash.update(format!("file:{relative_path}:{size}:{mtime_ms}\n").as_bytes());
    }

    for relative_directory in empty_directories {
        hash.update(format!("dir:{relative_directory}\n").as_bytes());
    }

    format!("{:x}", hash.finalize())
}

fn resolve_empty_remote_directories(
    explicit_directories: &BTreeSet<String>,
    file_paths: &BTreeSet<String>,
) -> BTreeSet<String> {
    explicit_directories
        .iter()
        .filter(|candidate| {
            let child_prefix = format!("{candidate}/");
            !explicit_directories
                .iter()
                .any(|directory| directory.starts_with(&child_prefix))
                && !file_paths.iter().any(|file_path| file_path.starts_with(&child_prefix))
        })
        .cloned()
        .collect()
}

fn build_sync_manifest(files: &[(String, u64, u128)]) -> SyncManifestDocument {
    let mut entries = files
        .iter()
        .filter_map(|(relative_path, size, mtime_ms)| {
            let normalized = normalize_relative_path(relative_path);
            if normalized.is_empty() || should_ignore_relative_path(&normalized) {
                return None;
            }
            Some((
                normalized,
                SyncManifestFileEntry {
                    size: *size,
                    mtime_ms: *mtime_ms,
                },
            ))
        })
        .collect::<Vec<_>>();
    entries.sort_by(|left, right| left.0.cmp(&right.0));

    SyncManifestDocument {
        version: 1,
        files: entries.into_iter().collect(),
    }
}

fn create_local_to_remote_plan(
    snapshot: &Snapshot,
    remote_entries: Vec<PlanRemoteEntry>,
) -> LocalToRemotePlan {
    use std::collections::{BTreeMap, BTreeSet};

    let mut remote_by_relative_path = BTreeMap::new();
    for entry in remote_entries {
        remote_by_relative_path.insert(normalize_relative_path(&entry.relative_path), entry);
    }

    let mut seen_remote_relative_paths = BTreeSet::new();
    let mut upload_candidates = Vec::new();
    let mut info_check_candidates = Vec::new();

    let mut files = snapshot.files.iter().collect::<Vec<_>>();
    files.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));

    for file in files {
        let remote_entry = remote_by_relative_path.get(&file.relative_path);
        seen_remote_relative_paths.insert(file.relative_path.clone());

        let candidate = PlanUploadCandidate {
            relative_path: file.relative_path.clone(),
            absolute_path: file.absolute_path.clone(),
            size: file.size,
            mtime_ms: file.mtime_ms,
            remote_key: remote_entry
                .map(|entry| entry.key.clone())
                .unwrap_or_else(|| file.relative_path.clone()),
        };

        match remote_entry {
            None => upload_candidates.push(candidate),
            Some(entry) if entry.is_directory => upload_candidates.push(candidate),
            Some(entry) if entry.size != file.size => upload_candidates.push(candidate),
            Some(_entry) => info_check_candidates.push(candidate),
        }
    }

    let mut empty_directories_to_create = snapshot
        .empty_directories
        .iter()
        .filter(|relative_path| {
            seen_remote_relative_paths.insert((*relative_path).clone());
            match remote_by_relative_path.get(*relative_path) {
                Some(entry) => !entry.is_directory,
                None => true,
            }
        })
        .cloned()
        .collect::<Vec<_>>();
    empty_directories_to_create.sort();

    let mut keys_to_delete = remote_by_relative_path
        .into_iter()
        .filter_map(|(relative_path, entry)| {
            if relative_path == "/" || seen_remote_relative_paths.contains(&relative_path) {
                return None;
            }
            Some(entry.key)
        })
        .collect::<Vec<_>>();
    keys_to_delete.sort();

    LocalToRemotePlan {
        upload_candidates,
        info_check_candidates,
        empty_directories_to_create,
        keys_to_delete,
    }
}

fn create_remote_to_local_plan(
    root_dir: &Path,
    snapshot: &Snapshot,
    remote_entries: Vec<PlanRemoteEntry>,
    preserve_top_level_names: Vec<String>,
) -> RemoteToLocalPlan {
    use std::collections::{BTreeMap, BTreeSet};

    let local_files_by_relative_path = snapshot
        .files
        .iter()
        .map(|file| (file.relative_path.clone(), file))
        .collect::<BTreeMap<_, _>>();

    let mut remote_directories = BTreeSet::new();
    let mut remote_files = Vec::new();

    for entry in remote_entries {
        let relative_path = normalize_relative_path(&entry.relative_path);
        if relative_path.is_empty() {
            continue;
        }

        if entry.is_directory {
            add_directory_with_parents(&relative_path, &mut remote_directories);
        } else {
            let parent = Path::new(&relative_path)
                .parent()
                .map(normalize_path)
                .map(|value| normalize_relative_path(&value))
                .unwrap_or_default();
            if !parent.is_empty() {
                add_directory_with_parents(&parent, &mut remote_directories);
            }
            remote_files.push((relative_path, entry));
        }
    }

    let mut directories_to_create = remote_directories.iter().cloned().collect::<Vec<_>>();
    directories_to_create.sort_by(|left, right| {
        let depth_difference = left.split('/').count().cmp(&right.split('/').count());
        if depth_difference == std::cmp::Ordering::Equal {
            left.cmp(right)
        } else {
            depth_difference
        }
    });

    let mut download_candidates = Vec::new();
    let mut info_check_candidates = Vec::new();
    let mut remote_file_paths = BTreeSet::new();
    let mut remove_paths = snapshot.ignored_paths.clone();

    remote_files.sort_by(|left, right| left.0.cmp(&right.0));
    for (relative_path, entry) in remote_files {
        remote_file_paths.insert(relative_path.clone());
        let target_path = normalize_path(&root_dir.join(&relative_path));
        let candidate = PlanDownloadCandidate {
            relative_path: relative_path.clone(),
            target_path,
            size: entry.size,
            remote_key: entry.key,
        };

        match local_files_by_relative_path.get(&relative_path) {
            None => download_candidates.push(candidate),
            Some(local_file) if local_file.size != entry.size => {
                download_candidates.push(candidate)
            }
            Some(_) => info_check_candidates.push(candidate),
        }
    }

    for file in &snapshot.files {
        if should_preserve_top_level_name(&file.relative_path, &preserve_top_level_names) {
            continue;
        }

        if !remote_file_paths.contains(&file.relative_path) {
            remove_paths.push(file.absolute_path.clone());
        }
    }

    let mut local_directories = snapshot.directories.iter().collect::<Vec<_>>();
    local_directories.sort_by(|left, right| {
        let depth_difference = right.split('/').count().cmp(&left.split('/').count());
        if depth_difference == std::cmp::Ordering::Equal {
            right.cmp(left)
        } else {
            depth_difference
        }
    });

    for relative_path in local_directories {
        if remote_directories.contains(relative_path)
            || should_preserve_top_level_name(relative_path, &preserve_top_level_names)
        {
            continue;
        }

        remove_paths.push(normalize_path(&root_dir.join(relative_path)));
    }

    remove_paths.sort();
    remove_paths.dedup();

    RemoteToLocalPlan {
        remove_paths,
        directories_to_create,
        download_candidates,
        info_check_candidates,
    }
}

fn create_seed_upload_plan(snapshot: &Snapshot, remote_base_path: &str) -> SeedUploadPlan {
    let mut directories = snapshot.directories.iter().cloned().collect::<Vec<_>>();
    directories.sort_by(|left, right| {
        let depth_difference = left.split('/').count().cmp(&right.split('/').count());
        if depth_difference == std::cmp::Ordering::Equal {
            left.cmp(right)
        } else {
            depth_difference
        }
    });

    let directories = directories
        .into_iter()
        .map(|relative_path| build_remote_path(remote_base_path, &relative_path))
        .collect();

    let mut files = snapshot.files.iter().collect::<Vec<_>>();
    files.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
    let files = files
        .into_iter()
        .map(|file| PlanSeedUploadFile {
            relative_path: file.relative_path.clone(),
            absolute_path: file.absolute_path.clone(),
            remote_path: build_remote_path(remote_base_path, &file.relative_path),
            size: file.size,
            mtime_ms: file.mtime_ms,
        })
        .collect();

    SeedUploadPlan { directories, files }
}

fn create_s3_client(config: &NativeObjectStoreConfig) -> S3Client {
    let mut builder = aws_sdk_s3::config::Builder::new().region(Region::new(config.region.clone()));
    if let Some(endpoint) = &config.endpoint {
        builder = builder.endpoint_url(endpoint);
    }
    if let Some(force_path_style) = config.force_path_style {
        builder = builder.force_path_style(force_path_style);
    }
    if let (Some(access_key), Some(secret_key)) = (&config.access_key, &config.secret_key) {
        builder = builder.credentials_provider(Credentials::new(
            access_key.clone(),
            secret_key.clone(),
            config.session_token.clone(),
            None,
            "oah-workspace-sync",
        ));
    }

    S3Client::from_conf(builder.build())
}

async fn list_remote_entries(
    client: &S3Client,
    config: &NativeObjectStoreConfig,
    remote_prefix: &str,
) -> Result<RemoteEntryListing, String> {
    let normalized_prefix = normalize_relative_path(remote_prefix);
    let mut continuation_token = None;
    let mut entries = Vec::new();
    let mut has_sync_manifest = false;

    loop {
        let mut request = client
            .list_objects_v2()
            .bucket(&config.bucket)
            .set_continuation_token(continuation_token.clone());
        if !normalized_prefix.is_empty() {
            request = request.prefix(format!("{normalized_prefix}/"));
        }

        let response = request
            .send()
            .await
            .map_err(|error| format!("Failed to list S3 prefix {normalized_prefix}: {error}"))?;

        for item in response.contents() {
            let Some(key) = item.key() else {
                continue;
            };
            let Some(relative_path) = relative_path_from_remote_key(&normalized_prefix, key) else {
                continue;
            };
            if normalize_relative_path(&relative_path) == INTERNAL_SYNC_MANIFEST_RELATIVE_PATH {
                has_sync_manifest = true;
                continue;
            }
            if should_ignore_relative_path(&relative_path) {
                continue;
            }

            entries.push(PlanRemoteEntry {
                relative_path,
                key: key.to_string(),
                size: item.size().unwrap_or_default() as u64,
                last_modified_ms: item
                    .last_modified()
                    .and_then(|value| value.to_millis().ok())
                    .map(|value| value.max(0) as u128),
                is_directory: key.ends_with('/'),
            });
        }

        if response.is_truncated().unwrap_or(false) {
            continuation_token = response
                .next_continuation_token()
                .map(|value| value.to_string());
        } else {
            break;
        }
    }

    Ok(RemoteEntryListing {
        entries,
        has_sync_manifest,
    })
}

async fn load_remote_sync_manifest(
    client: &S3Client,
    config: &NativeObjectStoreConfig,
    remote_prefix: &str,
    has_sync_manifest: bool,
) -> Result<BTreeMap<String, SyncManifestFileEntry>, String> {
    if !has_sync_manifest {
        return Ok(BTreeMap::new());
    }

    let key = build_remote_path(remote_prefix, INTERNAL_SYNC_MANIFEST_RELATIVE_PATH);
    let response = match client
        .get_object()
        .bucket(&config.bucket)
        .key(&key)
        .send()
        .await
    {
        Ok(response) => response,
        Err(_) => return Ok(BTreeMap::new()),
    };

    let mut body = response.body.into_async_read();
    let mut bytes = Vec::new();
    body.read_to_end(&mut bytes)
        .await
        .map_err(|error| format!("Failed to read sync manifest {key}: {error}"))?;
    let document = serde_json::from_slice::<SyncManifestDocument>(&bytes)
        .map_err(|error| format!("Failed to parse sync manifest {key}: {error}"))?;
    if document.version != 1 {
        return Ok(BTreeMap::new());
    }

    Ok(document
        .files
        .into_iter()
        .filter_map(|(relative_path, entry)| {
            let normalized = normalize_relative_path(&relative_path);
            if normalized.is_empty() || should_ignore_relative_path(&normalized) {
                return None;
            }
            Some((normalized, entry))
        })
        .collect())
}

async fn write_remote_sync_manifest(
    client: &S3Client,
    config: &NativeObjectStoreConfig,
    remote_prefix: &str,
    files: &[(String, u64, u128)],
) -> Result<(), String> {
    let key = build_remote_path(remote_prefix, INTERNAL_SYNC_MANIFEST_RELATIVE_PATH);
    let body = serde_json::to_vec(&build_sync_manifest(files))
        .map_err(|error| format!("Failed to serialize sync manifest {key}: {error}"))?;
    client
        .put_object()
        .bucket(&config.bucket)
        .key(&key)
        .body(ByteStream::from(body))
        .send()
        .await
        .map_err(|error| format!("Failed to write sync manifest {key}: {error}"))?;
    Ok(())
}

async fn upload_local_file(
    client: &S3Client,
    config: &NativeObjectStoreConfig,
    key: &str,
    absolute_path: &str,
    mtime_ms: u128,
) -> Result<bool, String> {
    match tokio::fs::metadata(absolute_path).await {
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(error) => {
            return Err(format!(
                "Failed to stat local file {absolute_path} before upload: {error}"
            ))
        }
    }

    let body = ByteStream::from_path(PathBuf::from(absolute_path))
        .await
        .map_err(|error| {
            format!("Failed to read local file {absolute_path} for upload: {error}")
        })?;

    client
        .put_object()
        .bucket(&config.bucket)
        .key(key)
        .body(body)
        .metadata(OBJECT_MTIME_METADATA_KEY, mtime_ms.to_string())
        .send()
        .await
        .map_err(|error| format!("Failed to upload S3 object {key}: {error}"))?;

    Ok(true)
}

async fn stat_local_path(target_path: &Path) -> Result<Option<fs::Metadata>, String> {
    match tokio::fs::metadata(target_path).await {
        Ok(metadata) => Ok(Some(metadata)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!(
            "Failed to stat local path {}: {error}",
            target_path.display()
        )),
    }
}

async fn remove_local_path(target_path: &Path) -> Result<bool, String> {
    let Some(metadata) = stat_local_path(target_path).await? else {
        return Ok(false);
    };

    if metadata.is_dir() {
        tokio::fs::remove_dir_all(target_path)
            .await
            .map_err(|error| {
                format!(
                    "Failed to remove local directory {}: {error}",
                    target_path.display()
                )
            })?;
    } else {
        tokio::fs::remove_file(target_path).await.map_err(|error| {
            format!(
                "Failed to remove local file {}: {error}",
                target_path.display()
            )
        })?;
    }

    Ok(true)
}

async fn ensure_local_directory(target_path: &Path) -> Result<bool, String> {
    match stat_local_path(target_path).await? {
        Some(metadata) if metadata.is_dir() => return Ok(false),
        Some(_) => {
            remove_local_path(target_path).await?;
        }
        None => {}
    }

    tokio::fs::create_dir_all(target_path)
        .await
        .map_err(|error| {
            format!(
                "Failed to create local directory {}: {error}",
                target_path.display()
            )
        })?;

    Ok(true)
}

async fn prepare_local_file_target(target_path: &Path) -> Result<Option<fs::Metadata>, String> {
    let existing = match stat_local_path(target_path).await? {
        Some(metadata) if metadata.is_file() => Some(metadata),
        Some(_) => {
            remove_local_path(target_path).await?;
            None
        }
        None => None,
    };

    if let Some(parent) = target_path.parent() {
        tokio::fs::create_dir_all(parent).await.map_err(|error| {
            format!(
                "Failed to create parent directory {}: {error}",
                parent.display()
            )
        })?;
    }

    Ok(existing)
}

async fn download_remote_file(
    client: &S3Client,
    config: &NativeObjectStoreConfig,
    key: &str,
    target_path: &Path,
) -> Result<u128, String> {
    let response = client
        .get_object()
        .bucket(&config.bucket)
        .key(key)
        .send()
        .await
        .map_err(|error| format!("Failed to download S3 object {key}: {error}"))?;

    let target_mtime_ms = parse_object_mtime_ms(response.metadata()).or_else(|| {
        response
            .last_modified()
            .and_then(|value| value.to_millis().ok())
            .map(|value| value.max(0) as u128)
    });

    let mut body = response.body.into_async_read();
    let mut file = tokio::fs::File::create(target_path)
        .await
        .map_err(|error| {
            format!(
                "Failed to create local file {}: {error}",
                target_path.display()
            )
        })?;
    tokio::io::copy(&mut body, &mut file)
        .await
        .map_err(|error| {
            format!(
                "Failed to write local file {} from S3 object {key}: {error}",
                target_path.display()
            )
        })?;
    file.flush().await.map_err(|error| {
        format!(
            "Failed to flush local file {} after download: {error}",
            target_path.display()
        )
    })?;
    drop(file);

    if let Some(target_mtime_ms) = target_mtime_ms {
        set_file_mtime(target_path, file_time_from_mtime_ms(target_mtime_ms)).map_err(|error| {
            format!(
                "Failed to preserve mtime for local file {}: {error}",
                target_path.display()
            )
        })?;
        return Ok(target_mtime_ms);
    }

    let metadata = tokio::fs::metadata(target_path).await.map_err(|error| {
        format!(
            "Failed to read metadata for downloaded local file {}: {error}",
            target_path.display()
        )
    })?;
    metadata
        .modified()
        .ok()
        .and_then(system_time_to_mtime_ms)
        .ok_or_else(|| {
            format!(
                "Failed to resolve mtime for downloaded local file {}.",
                target_path.display()
            )
        })
}

async fn sync_remote_to_local(
    request: SyncRemoteToLocalRequest,
) -> Result<SyncRemoteToLocalResponse, String> {
    let excludes = normalize_exclude_paths(request.exclude_relative_paths);
    let preserve_top_level_names = normalize_exclude_paths(request.preserve_top_level_names);
    let max_concurrency = resolve_max_concurrency(request.max_concurrency);
    let root_dir = PathBuf::from(&request.root_dir);
    let snapshot = collect_snapshot(&root_dir, &excludes)?;

    let client = create_s3_client(&request.object_store);
    let remote_listing =
        list_remote_entries(&client, &request.object_store, &request.remote_prefix).await?;
    let remote_entries = remote_listing.entries;
    let sync_manifest =
        Arc::new(
            load_remote_sync_manifest(
                &client,
                &request.object_store,
                &request.remote_prefix,
                remote_listing.has_sync_manifest,
            )
            .await?,
        );
    let explicit_remote_directories = remote_entries
        .iter()
        .filter(|entry| entry.is_directory)
        .map(|entry| normalize_relative_path(&entry.relative_path))
        .filter(|relative_path| !relative_path.is_empty())
        .collect::<BTreeSet<_>>();
    let remote_file_paths = remote_entries
        .iter()
        .filter(|entry| !entry.is_directory)
        .map(|entry| normalize_relative_path(&entry.relative_path))
        .filter(|relative_path| !relative_path.is_empty())
        .collect::<BTreeSet<_>>();
    let plan = create_remote_to_local_plan(
        &root_dir,
        &snapshot,
        remote_entries,
        preserve_top_level_names,
    );

    let removed_path_count = process_with_concurrency(
        plan.remove_paths.clone(),
        max_concurrency,
        |target_path| async move { remove_local_path(Path::new(&target_path)).await },
    )
    .await?
    .into_iter()
    .filter(|removed| *removed)
    .count();

    tokio::fs::create_dir_all(&root_dir)
        .await
        .map_err(|error| {
            format!(
                "Failed to create local root directory {}: {error}",
                root_dir.display()
            )
        })?;

    let root_dir_for_directories = root_dir.clone();
    let created_directory_count = process_with_concurrency(
        plan.directories_to_create.clone(),
        max_concurrency,
        move |relative_path| {
            let root_dir = root_dir_for_directories.clone();
            async move {
                let target_path = root_dir.join(relative_path);
                ensure_local_directory(&target_path).await
            }
        },
    )
    .await?
    .into_iter()
    .filter(|created| *created)
    .count();

    let client_for_downloads = client.clone();
    let object_store_for_downloads = request.object_store.clone();
    let downloaded_candidates = process_with_concurrency(
        plan.download_candidates.clone(),
        max_concurrency,
        move |candidate| {
            let client = client_for_downloads.clone();
            let object_store = object_store_for_downloads.clone();
            async move {
                let target_path = PathBuf::from(&candidate.target_path);
                prepare_local_file_target(&target_path).await?;
                let mtime_ms =
                    download_remote_file(&client, &object_store, &candidate.remote_key, &target_path)
                        .await?;
                Ok((candidate.relative_path, candidate.size, mtime_ms, true))
            }
        },
    )
    .await?;

    let client_for_info_checks = client.clone();
    let object_store_for_info_checks = request.object_store.clone();
    let sync_manifest_for_info_checks = Arc::clone(&sync_manifest);
    let info_checked_candidates = process_with_concurrency(
        plan.info_check_candidates.clone(),
        max_concurrency,
        move |candidate| {
            let client = client_for_info_checks.clone();
            let object_store = object_store_for_info_checks.clone();
            let sync_manifest = Arc::clone(&sync_manifest_for_info_checks);
            async move {
                let target_path = PathBuf::from(&candidate.target_path);
                let existing = prepare_local_file_target(&target_path).await?;

                let should_download: Result<(bool, Option<u128>), String> = match existing {
                    Some(metadata) if metadata.len() == candidate.size => {
                        if let Some(manifest_entry) = sync_manifest.get(&candidate.relative_path) {
                            let local_mtime_ms =
                                metadata.modified().ok().and_then(system_time_to_mtime_ms);
                            if manifest_entry.size == candidate.size
                                && local_mtime_ms == Some(manifest_entry.mtime_ms)
                            {
                                return Ok((
                                    candidate.relative_path,
                                    candidate.size,
                                    manifest_entry.mtime_ms,
                                    false,
                                ));
                            }
                        }

                        let head = client
                            .head_object()
                            .bucket(&object_store.bucket)
                            .key(&candidate.remote_key)
                            .send()
                            .await;

                        match head {
                            Ok(head) => {
                                let remote_mtime_ms = parse_object_mtime_ms(head.metadata())
                                    .or_else(|| {
                                        head.last_modified()
                                            .and_then(|value| value.to_millis().ok())
                                            .map(|value| value.max(0) as u128)
                                    });
                                let local_mtime_ms =
                                    metadata.modified().ok().and_then(system_time_to_mtime_ms);
                                match (remote_mtime_ms, local_mtime_ms) {
                                    (Some(remote_mtime_ms), Some(local_mtime_ms)) => {
                                        if remote_mtime_ms != local_mtime_ms {
                                            Ok((true, None))
                                        } else {
                                            Ok((false, Some(local_mtime_ms)))
                                        }
                                    }
                                    _ => Ok((true, None)),
                                }
                            }
                            Err(_) => Ok((true, None)),
                        }
                    }
                    _ => Ok((true, None)),
                };

                let (should_download, existing_mtime_ms) = should_download?;
                if !should_download {
                    return Ok((
                        candidate.relative_path,
                        candidate.size,
                        existing_mtime_ms.unwrap_or_default(),
                        false,
                    ));
                }

                let mtime_ms =
                    download_remote_file(&client, &object_store, &candidate.remote_key, &target_path)
                        .await?;
                Ok((candidate.relative_path, candidate.size, mtime_ms, true))
            }
        },
    )
    .await?;
    let downloaded_file_count = downloaded_candidates.len()
        + info_checked_candidates
            .iter()
            .filter(|(_, _, _, downloaded)| *downloaded)
            .count();
    let local_fingerprint = create_fingerprint_from_entries(
        &downloaded_candidates
            .into_iter()
            .chain(info_checked_candidates.into_iter())
            .map(|(relative_path, size, mtime_ms, _downloaded)| {
                (relative_path, size, mtime_ms)
            })
            .collect::<Vec<_>>(),
        &resolve_empty_remote_directories(&explicit_remote_directories, &remote_file_paths),
    );

    Ok(SyncRemoteToLocalResponse {
        ok: true,
        protocol_version: PROTOCOL_VERSION,
        local_fingerprint,
        removed_path_count,
        created_directory_count,
        downloaded_file_count,
    })
}

async fn sync_local_to_remote(
    request: SyncLocalToRemoteRequest,
) -> Result<SyncLocalToRemoteResponse, String> {
    use std::collections::BTreeMap;

    let excludes = normalize_exclude_paths(request.exclude_relative_paths);
    let max_concurrency = resolve_max_concurrency(request.max_concurrency);
    let snapshot = collect_snapshot(&PathBuf::from(&request.root_dir), &excludes)?;
    let local_fingerprint = create_fingerprint(&snapshot);

    let client = create_s3_client(&request.object_store);
    let remote_listing =
        list_remote_entries(&client, &request.object_store, &request.remote_prefix).await?;
    let remote_entries = remote_listing.entries;
    let sync_manifest =
        Arc::new(
            load_remote_sync_manifest(
                &client,
                &request.object_store,
                &request.remote_prefix,
                remote_listing.has_sync_manifest,
            )
            .await?,
        );
    let remote_entries_by_relative_path = remote_entries
        .iter()
        .cloned()
        .map(|entry| (normalize_relative_path(&entry.relative_path), entry))
        .collect::<BTreeMap<_, _>>();
    let plan = create_local_to_remote_plan(&snapshot, remote_entries);

    let remote_entries_by_relative_path = Arc::new(remote_entries_by_relative_path);

    let client_for_uploads = client.clone();
    let object_store_for_uploads = request.object_store.clone();
    let remote_prefix_for_uploads = request.remote_prefix.clone();
    let uploaded_candidates = process_with_concurrency(
        plan.upload_candidates.clone(),
        max_concurrency,
        move |candidate| {
            let client = client_for_uploads.clone();
            let object_store = object_store_for_uploads.clone();
            let remote_prefix = remote_prefix_for_uploads.clone();
            async move {
                let key = build_remote_path(&remote_prefix, &candidate.relative_path);
                upload_local_file(
                    &client,
                    &object_store,
                    &key,
                    &candidate.absolute_path,
                    candidate.mtime_ms,
                )
                .await
            }
        },
    )
    .await?;

    let client_for_info_checks = client.clone();
    let object_store_for_info_checks = request.object_store.clone();
    let remote_prefix_for_info_checks = request.remote_prefix.clone();
    let remote_entries_for_info_checks = Arc::clone(&remote_entries_by_relative_path);
    let sync_manifest_for_info_checks = Arc::clone(&sync_manifest);
    let info_checked_candidates = process_with_concurrency(
        plan.info_check_candidates.clone(),
        max_concurrency,
        move |candidate| {
            let client = client_for_info_checks.clone();
            let object_store = object_store_for_info_checks.clone();
            let remote_prefix = remote_prefix_for_info_checks.clone();
            let remote_entries = Arc::clone(&remote_entries_for_info_checks);
            let sync_manifest = Arc::clone(&sync_manifest_for_info_checks);
            async move {
                let remote_entry = remote_entries.get(&candidate.relative_path).cloned();
                let should_upload = match remote_entry {
                    None => true,
                    Some(remote_entry) if remote_entry.is_directory => true,
                    Some(remote_entry) => {
                        if let Some(manifest_entry) = sync_manifest.get(&candidate.relative_path) {
                            if manifest_entry.size == candidate.size
                                && manifest_entry.mtime_ms == candidate.mtime_ms
                            {
                                return Ok(false);
                            }
                        }

                        let head = client
                            .head_object()
                            .bucket(&object_store.bucket)
                            .key(&remote_entry.key)
                            .send()
                            .await;

                        match head {
                            Ok(head) => match parse_object_mtime_ms(head.metadata()) {
                                Some(remote_mtime_ms) => remote_mtime_ms != candidate.mtime_ms,
                                None => head
                                    .last_modified()
                                    .and_then(|value| value.to_millis().ok())
                                    .map(|value| value as i128)
                                    .map(|value| value < candidate.mtime_ms as i128)
                                    .unwrap_or(true),
                            },
                            Err(_) => true,
                        }
                    }
                };

                if !should_upload {
                    return Ok(false);
                }

                let key = build_remote_path(&remote_prefix, &candidate.relative_path);
                upload_local_file(
                    &client,
                    &object_store,
                    &key,
                    &candidate.absolute_path,
                    candidate.mtime_ms,
                )
                .await
            }
        },
    )
    .await?;

    let uploaded_file_count = uploaded_candidates
        .into_iter()
        .filter(|uploaded| *uploaded)
        .count()
        + info_checked_candidates
            .into_iter()
            .filter(|uploaded| *uploaded)
            .count();

    let client_for_empty_directories = client.clone();
    let object_store_for_empty_directories = request.object_store.clone();
    let remote_prefix_for_empty_directories = request.remote_prefix.clone();
    let created_empty_directory_count = process_with_concurrency(
        plan.empty_directories_to_create.clone(),
        max_concurrency,
        move |relative_path| {
            let client = client_for_empty_directories.clone();
            let object_store = object_store_for_empty_directories.clone();
            let remote_prefix = remote_prefix_for_empty_directories.clone();
            async move {
                let key = format!("{}/", build_remote_path(&remote_prefix, &relative_path));
                client
                    .put_object()
                    .bucket(&object_store.bucket)
                    .key(key)
                    .body(ByteStream::from_static(b""))
                    .send()
                    .await
                    .map_err(|error| {
                        format!("Failed to create empty S3 directory marker: {error}")
                    })?;
                Ok(true)
            }
        },
    )
    .await?
    .len();

    for chunk in plan.keys_to_delete.chunks(1000) {
        if chunk.is_empty() {
            continue;
        }

        let delete = Delete::builder()
            .set_objects(Some(
                chunk
                    .iter()
                    .map(|key| {
                        ObjectIdentifier::builder()
                            .key(key)
                            .build()
                            .map_err(|error| {
                                format!("Failed to prepare S3 delete object identifier: {error}")
                            })
                    })
                    .collect::<Result<Vec<_>, _>>()?,
            ))
            .build()
            .map_err(|error| format!("Failed to prepare S3 delete request: {error}"))?;

        client
            .delete_objects()
            .bucket(&request.object_store.bucket)
            .delete(delete)
            .send()
            .await
            .map_err(|error| format!("Failed to delete S3 objects: {error}"))?;
    }

    write_remote_sync_manifest(
        &client,
        &request.object_store,
        &request.remote_prefix,
        &plan
            .upload_candidates
            .iter()
            .chain(plan.info_check_candidates.iter())
            .map(|candidate| {
                (
                    candidate.relative_path.clone(),
                    candidate.size,
                    candidate.mtime_ms,
                )
            })
            .collect::<Vec<_>>(),
    )
    .await?;

    Ok(SyncLocalToRemoteResponse {
        ok: true,
        protocol_version: PROTOCOL_VERSION,
        local_fingerprint,
        uploaded_file_count,
        deleted_remote_count: plan.keys_to_delete.len(),
        created_empty_directory_count,
    })
}

async fn sync_local_to_sandbox_http(
    request: SyncLocalToSandboxHttpRequest,
) -> Result<SyncLocalToSandboxHttpResponse, String> {
    let excludes = normalize_exclude_paths(request.exclude_relative_paths);
    let max_concurrency = resolve_max_concurrency(request.max_concurrency);
    let snapshot = collect_snapshot(&PathBuf::from(&request.root_dir), &excludes)?;
    let local_fingerprint = create_fingerprint(&snapshot);
    let plan = create_seed_upload_plan(&snapshot, &request.remote_root_path);
    let empty_directories_to_create = snapshot
        .empty_directories
        .iter()
        .map(|relative_path| build_remote_path(&request.remote_root_path, relative_path))
        .collect::<BTreeSet<_>>();
    let sandbox_client = NativeSandboxHttpClient::new(&request.sandbox)?;

    let root_path = request.remote_root_path.clone();
    let root_directory_exists = if let Some(existing_root) = sandbox_client.stat_path(&root_path).await? {
        if existing_root.kind != "directory" {
            sandbox_client.delete_entry(&root_path, true).await?;
            false
        } else {
            true
        }
    } else {
        false
    };
    if !root_directory_exists {
        sandbox_client.create_directory(&root_path).await?;
    }
    let expected_directories = plan.directories.iter().cloned().collect::<BTreeSet<_>>();
    let expected_files = plan
        .files
        .iter()
        .map(|file| file.remote_path.clone())
        .collect::<BTreeSet<_>>();
    let remote_state = prune_unexpected_remote_sandbox_entries(
        &sandbox_client,
        &root_path,
        &expected_directories,
        &expected_files,
    )
    .await?;
    let directories_to_create = empty_directories_to_create
        .iter()
        .filter(|remote_path| !remote_state.existing_directories.contains(*remote_path))
        .cloned()
        .collect::<Vec<_>>();

    let sandbox_client_for_directories = sandbox_client.clone();
    let created_directory_count = process_with_concurrency(
        directories_to_create,
        max_concurrency,
        move |remote_path| {
            let sandbox_client = sandbox_client_for_directories.clone();
            async move {
                sandbox_client.create_directory(&remote_path).await?;
                Ok(true)
            }
        },
    )
    .await?
    .len()
        + if root_directory_exists { 0 } else { 1 };

    let sandbox_client_for_uploads = sandbox_client.clone();
    let remote_file_stats = Arc::new(remote_state.existing_file_stats);
    let uploaded_file_count = process_with_concurrency(
        plan.files.clone(),
        max_concurrency,
        move |file| {
            let sandbox_client = sandbox_client_for_uploads.clone();
            let remote_file_stats = Arc::clone(&remote_file_stats);
            async move {
                if let Some(remote_stat) = remote_file_stats.get(&file.remote_path) {
                    if sandbox_file_matches(file.size, file.mtime_ms, remote_stat) {
                        return Ok(false);
                    }
                }
                let data = tokio::fs::read(&file.absolute_path).await.map_err(|error| {
                    format!(
                        "Failed to read local file {} for sandbox upload: {error}",
                        file.absolute_path
                    )
                })?;
                sandbox_client
                    .upload_file(&file.remote_path, data, file.mtime_ms)
                    .await?;
                Ok(true)
            }
        },
    )
    .await?
    .into_iter()
    .filter(|uploaded| *uploaded)
    .count();

    Ok(SyncLocalToSandboxHttpResponse {
        ok: true,
        protocol_version: PROTOCOL_VERSION,
        local_fingerprint,
        created_directory_count,
        uploaded_file_count,
    })
}

fn add_directory_with_parents(relative_path: &str, directories: &mut BTreeSet<String>) {
    let normalized = normalize_relative_path(relative_path);
    if normalized.is_empty() {
        return;
    }

    let segments = normalized.split('/').collect::<Vec<_>>();
    for index in 0..segments.len() {
        let candidate = segments[..=index].join("/");
        if !candidate.is_empty() {
            directories.insert(candidate);
        }
    }
}

fn should_preserve_top_level_name(
    relative_path: &str,
    preserve_top_level_names: &[String],
) -> bool {
    const EMPTY: &str = "";

    let normalized = normalize_relative_path(relative_path);
    if normalized.is_empty() {
        return false;
    }

    let top_level_name = normalized.split('/').next().unwrap_or(EMPTY);
    !top_level_name.is_empty()
        && preserve_top_level_names
            .iter()
            .any(|candidate| candidate == top_level_name)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_snapshot() -> Snapshot {
        let mut directories = BTreeSet::new();
        directories.insert("foo".to_string());
        directories.insert("foo/nested".to_string());
        directories.insert("keep".to_string());

        Snapshot {
            files: vec![
                FileEntry {
                    relative_path: "foo/a.txt".to_string(),
                    absolute_path: "/workspace/foo/a.txt".to_string(),
                    size: 10,
                    mtime_ms: 1000,
                },
                FileEntry {
                    relative_path: "orphan.txt".to_string(),
                    absolute_path: "/workspace/orphan.txt".to_string(),
                    size: 4,
                    mtime_ms: 2000,
                },
                FileEntry {
                    relative_path: "keep/child.txt".to_string(),
                    absolute_path: "/workspace/keep/child.txt".to_string(),
                    size: 6,
                    mtime_ms: 3000,
                },
            ],
            directories,
            empty_directories: BTreeSet::new(),
            ignored_paths: vec!["/workspace/.DS_Store".to_string()],
        }
    }

    #[test]
    fn local_to_remote_plan_splits_uploads_and_deletes() {
        let snapshot = make_snapshot();
        let plan = create_local_to_remote_plan(
            &snapshot,
            vec![
                PlanRemoteEntry {
                    relative_path: "foo/a.txt".to_string(),
                    key: "prefix/foo/a.txt".to_string(),
                    size: 10,
                    last_modified_ms: Some(1000),
                    is_directory: false,
                },
                PlanRemoteEntry {
                    relative_path: "unused.txt".to_string(),
                    key: "prefix/unused.txt".to_string(),
                    size: 5,
                    last_modified_ms: Some(1000),
                    is_directory: false,
                },
            ],
        );

        assert_eq!(plan.upload_candidates.len(), 2);
        assert_eq!(plan.upload_candidates[0].relative_path, "keep/child.txt");
        assert_eq!(plan.upload_candidates[1].relative_path, "orphan.txt");
        assert_eq!(plan.info_check_candidates.len(), 1);
        assert_eq!(plan.info_check_candidates[0].relative_path, "foo/a.txt");
        assert_eq!(plan.keys_to_delete, vec!["prefix/unused.txt".to_string()]);
    }

    #[test]
    fn remote_to_local_plan_emits_downloads_and_removals() {
        let snapshot = make_snapshot();
        let plan = create_remote_to_local_plan(
            Path::new("/workspace"),
            &snapshot,
            vec![
                PlanRemoteEntry {
                    relative_path: "foo/a.txt".to_string(),
                    key: "prefix/foo/a.txt".to_string(),
                    size: 10,
                    last_modified_ms: Some(1000),
                    is_directory: false,
                },
                PlanRemoteEntry {
                    relative_path: "foo/b.txt".to_string(),
                    key: "prefix/foo/b.txt".to_string(),
                    size: 8,
                    last_modified_ms: Some(1000),
                    is_directory: false,
                },
            ],
            vec!["keep".to_string()],
        );

        assert_eq!(plan.download_candidates.len(), 1);
        assert_eq!(plan.download_candidates[0].relative_path, "foo/b.txt");
        assert_eq!(plan.info_check_candidates.len(), 1);
        assert_eq!(plan.info_check_candidates[0].relative_path, "foo/a.txt");
        assert!(plan
            .remove_paths
            .contains(&"/workspace/.DS_Store".to_string()));
        assert!(plan
            .remove_paths
            .contains(&"/workspace/orphan.txt".to_string()));
        assert!(plan
            .remove_paths
            .contains(&"/workspace/foo/nested".to_string()));
        assert!(!plan.remove_paths.contains(&"/workspace/keep".to_string()));
        assert!(!plan
            .remove_paths
            .contains(&"/workspace/keep/child.txt".to_string()));
    }

    #[test]
    fn seed_upload_plan_maps_remote_paths_and_orders_parent_directories_first() {
        let snapshot = make_snapshot();
        let plan = create_seed_upload_plan(&snapshot, "/workspace/root/");

        assert_eq!(
            plan.directories,
            vec![
                "/workspace/root/foo".to_string(),
                "/workspace/root/keep".to_string(),
                "/workspace/root/foo/nested".to_string(),
            ]
        );
        assert_eq!(plan.files.len(), 3);
        assert_eq!(plan.files[0].remote_path, "/workspace/root/foo/a.txt");
        assert_eq!(plan.files[1].remote_path, "/workspace/root/keep/child.txt");
        assert_eq!(plan.files[2].remote_path, "/workspace/root/orphan.txt");
        assert_eq!(plan.files[1].mtime_ms, 3000);
    }

    #[test]
    fn build_remote_path_trims_duplicate_separators() {
        assert_eq!(
            build_remote_path("/seed/workspace/", "/nested/file.txt"),
            "/seed/workspace/nested/file.txt"
        );
        assert_eq!(build_remote_path("", "/nested/file.txt"), "nested/file.txt");
        assert_eq!(build_remote_path("/seed/workspace/", ""), "/seed/workspace");
    }

    #[test]
    fn sandbox_file_match_tolerates_sub_millisecond_mtime_drift() {
        let remote = NativeSandboxHttpFileStat {
            kind: "file".to_string(),
            size: 12,
            mtime_ms: 1_234.6,
        };

        assert!(sandbox_file_matches(12, 1_234, &remote));
        assert!(!sandbox_file_matches(11, 1_234, &remote));
        assert!(!sandbox_file_matches(12, 1_236, &remote));
    }

    #[test]
    fn remote_sandbox_entry_keep_logic_respects_type_mismatches() {
        let expected_directories =
            BTreeSet::from(["/workspace".to_string(), "/workspace/nested".to_string()]);
        let expected_files = BTreeSet::from(["/workspace/README.md".to_string()]);

        assert!(should_keep_remote_sandbox_entry(
            &NativeSandboxHttpEntry {
                path: "/workspace/nested".to_string(),
                entry_type: "directory".to_string(),
                size_bytes: None,
                updated_at: None,
            },
            &expected_directories,
            &expected_files,
        ));
        assert!(should_keep_remote_sandbox_entry(
            &NativeSandboxHttpEntry {
                path: "/workspace/README.md".to_string(),
                entry_type: "file".to_string(),
                size_bytes: Some(12),
                updated_at: Some("2026-04-24T00:00:00.000Z".to_string()),
            },
            &expected_directories,
            &expected_files,
        ));
        assert!(!should_keep_remote_sandbox_entry(
            &NativeSandboxHttpEntry {
                path: "/workspace/nested".to_string(),
                entry_type: "file".to_string(),
                size_bytes: Some(12),
                updated_at: Some("2026-04-24T00:00:00.000Z".to_string()),
            },
            &expected_directories,
            &expected_files,
        ));
        assert!(!should_keep_remote_sandbox_entry(
            &NativeSandboxHttpEntry {
                path: "/workspace/stale.txt".to_string(),
                entry_type: "file".to_string(),
                size_bytes: Some(12),
                updated_at: Some("2026-04-24T00:00:00.000Z".to_string()),
            },
            &expected_directories,
            &expected_files,
        ));
    }

    #[test]
    fn sandbox_entry_file_stat_uses_listing_metadata() {
        let entry = NativeSandboxHttpEntry {
            path: "/workspace/README.md".to_string(),
            entry_type: "file".to_string(),
            size_bytes: Some(12),
            updated_at: Some("2026-04-24T00:00:00.500Z".to_string()),
        };

        let stat = sandbox_entry_file_stat(&entry).expect("expected file stat");
        assert_eq!(stat.kind, "file");
        assert_eq!(stat.size, 12);
        assert!(sandbox_mtime_matches(1_776_988_800_500, stat.mtime_ms));
    }

    #[test]
    fn worker_request_executes_version_command_and_includes_request_id() {
        let mut runtime = None;
        let response = handle_worker_request(
            WorkerRequest {
                request_id: "req_1".to_string(),
                command: "version".to_string(),
                payload: None,
            },
            &mut runtime,
        );

        assert_eq!(response.get("ok").and_then(Value::as_bool), Some(true));
        assert_eq!(
            response.get("requestId").and_then(Value::as_str),
            Some("req_1")
        );
        assert_eq!(response.get("name").and_then(Value::as_str), Some(BINARY_NAME));
    }

    #[test]
    fn worker_request_reports_unknown_command_error() {
        let mut runtime = None;
        let response = handle_worker_request(
            WorkerRequest {
                request_id: "req_2".to_string(),
                command: "unknown".to_string(),
                payload: None,
            },
            &mut runtime,
        );

        assert_eq!(response.get("ok").and_then(Value::as_bool), Some(false));
        assert_eq!(
            response.get("requestId").and_then(Value::as_str),
            Some("req_2")
        );
        assert!(response
            .get("message")
            .and_then(Value::as_str)
            .is_some_and(|message| message.contains("Unknown command")));
    }
}
