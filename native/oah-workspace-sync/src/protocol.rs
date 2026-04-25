use std::io::{self, BufRead, BufReader, BufWriter, Read, Write};
use std::path::PathBuf;
use std::time::{Instant, SystemTime};

use clap::{Parser, Subcommand};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::runtime::Builder as RuntimeBuilder;

use crate::bundle_policy::NativeSyncBundleConfig;
use crate::elapsed_millis_u64;
use crate::manifest::PlanRemoteEntry;
use crate::object_store::{
    create_s3_client, system_time_to_mtime_ms, NativeObjectStoreConfig, ObjectStoreRequestCounts,
};
use crate::object_sync::{sync_local_to_remote, sync_remote_to_local};
use crate::path_rules::normalize_exclude_paths;
use crate::plan::{
    create_local_to_remote_plan, create_remote_to_local_plan, create_seed_upload_plan,
    PlanDownloadCandidate, PlanSeedUploadFile, PlanUploadCandidate,
};
use crate::sandbox_http::NativeSandboxHttpConfig;
use crate::sandbox_sync::sync_local_to_sandbox_http;
use crate::seed_archive::{build_seed_archive, BuildSeedArchiveRequest};
use crate::snapshot::{collect_snapshot, create_fingerprint, ScanFileEntry};

pub(crate) const PROTOCOL_VERSION: u32 = 1;
pub(crate) const BINARY_NAME: &str = "oah-workspace-sync";
pub(crate) const BINARY_VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Parser)]
#[command(name = BINARY_NAME, version = BINARY_VERSION, about = "Open Agent Harness native workspace sync utilities.")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    Ready,
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
    BuildSeedArchive,
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ReadyResponse {
    ok: bool,
    protocol_version: u32,
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
pub(crate) struct SyncLocalToRemoteRequest {
    pub(crate) root_dir: String,
    pub(crate) remote_prefix: String,
    #[serde(default)]
    pub(crate) exclude_relative_paths: Vec<String>,
    #[serde(default)]
    pub(crate) max_concurrency: Option<usize>,
    #[serde(default)]
    pub(crate) inline_upload_threshold_bytes: Option<u64>,
    #[serde(default)]
    pub(crate) sync_bundle: Option<NativeSyncBundleConfig>,
    pub(crate) object_store: NativeObjectStoreConfig,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SyncRemoteToLocalRequest {
    pub(crate) root_dir: String,
    pub(crate) remote_prefix: String,
    #[serde(default)]
    pub(crate) exclude_relative_paths: Vec<String>,
    #[serde(default)]
    pub(crate) preserve_top_level_names: Vec<String>,
    #[serde(default)]
    pub(crate) max_concurrency: Option<usize>,
    #[serde(default)]
    pub(crate) remote_entries: Option<Vec<PlanRemoteEntry>>,
    #[serde(default)]
    pub(crate) has_sync_manifest: Option<bool>,
    #[serde(default)]
    pub(crate) bundle_entry: Option<PlanRemoteEntry>,
    #[serde(default)]
    pub(crate) sync_bundle: Option<NativeSyncBundleConfig>,
    pub(crate) object_store: NativeObjectStoreConfig,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SyncLocalToSandboxHttpRequest {
    pub(crate) root_dir: String,
    pub(crate) remote_root_path: String,
    #[serde(default)]
    pub(crate) exclude_relative_paths: Vec<String>,
    #[serde(default)]
    pub(crate) max_concurrency: Option<usize>,
    pub(crate) sandbox: NativeSandboxHttpConfig,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ErrorResponse {
    pub(crate) ok: bool,
    pub(crate) protocol_version: u32,
    pub(crate) code: &'static str,
    pub(crate) message: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkerRequest {
    pub(crate) request_id: String,
    pub(crate) command: String,
    pub(crate) payload: Option<Value>,
    #[serde(default)]
    pub(crate) sent_at_ms: Option<u128>,
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SyncLocalToRemotePhaseTimings {
    pub(crate) scan_ms: u64,
    pub(crate) fingerprint_ms: u64,
    pub(crate) client_create_ms: u64,
    pub(crate) manifest_read_ms: u64,
    pub(crate) bundle_build_ms: u64,
    pub(crate) bundle_body_prepare_ms: u64,
    pub(crate) bundle_upload_ms: u64,
    pub(crate) bundle_transport: String,
    pub(crate) bundle_bytes: u64,
    pub(crate) manifest_write_ms: u64,
    pub(crate) delete_ms: u64,
    pub(crate) total_primary_path_ms: u64,
    pub(crate) total_command_ms: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SyncRemoteToLocalPhaseTimings {
    pub(crate) scan_ms: u64,
    pub(crate) client_create_ms: u64,
    pub(crate) listing_ms: u64,
    pub(crate) manifest_read_ms: u64,
    pub(crate) plan_ms: u64,
    pub(crate) remove_ms: u64,
    pub(crate) mkdir_ms: u64,
    pub(crate) bundle_get_ms: u64,
    pub(crate) bundle_body_read_ms: u64,
    pub(crate) bundle_extract_ms: u64,
    pub(crate) bundle_extract_mkdir_us: u64,
    pub(crate) bundle_extract_replace_us: u64,
    pub(crate) bundle_extract_file_create_us: u64,
    pub(crate) bundle_extract_file_write_us: u64,
    pub(crate) bundle_extract_file_mtime_us: u64,
    pub(crate) bundle_extract_chmod_us: u64,
    pub(crate) bundle_extract_target_check_us: u64,
    pub(crate) bundle_extract_file_count: u64,
    pub(crate) bundle_extract_directory_count: u64,
    pub(crate) bundle_transport: String,
    pub(crate) bundle_extractor: String,
    pub(crate) bundle_bytes: u64,
    pub(crate) download_ms: u64,
    pub(crate) info_check_ms: u64,
    pub(crate) fingerprint_ms: u64,
    pub(crate) total_command_ms: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkerRequestTimings {
    receive_delay_ms: u64,
    parse_ms: u64,
    handle_ms: u64,
    serialize_ms: u64,
    write_ms: u64,
    total_worker_ms: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SyncLocalToRemoteResponse {
    pub(crate) ok: bool,
    pub(crate) protocol_version: u32,
    pub(crate) local_fingerprint: String,
    pub(crate) uploaded_file_count: usize,
    pub(crate) deleted_remote_count: usize,
    pub(crate) created_empty_directory_count: usize,
    pub(crate) request_counts: ObjectStoreRequestCounts,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) phase_timings: Option<SyncLocalToRemotePhaseTimings>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SyncRemoteToLocalResponse {
    pub(crate) ok: bool,
    pub(crate) protocol_version: u32,
    pub(crate) local_fingerprint: String,
    pub(crate) removed_path_count: usize,
    pub(crate) created_directory_count: usize,
    pub(crate) downloaded_file_count: usize,
    pub(crate) request_counts: ObjectStoreRequestCounts,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) phase_timings: Option<SyncRemoteToLocalPhaseTimings>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SyncLocalToSandboxHttpResponse {
    pub(crate) ok: bool,
    pub(crate) protocol_version: u32,
    pub(crate) local_fingerprint: String,
    pub(crate) created_directory_count: usize,
    pub(crate) uploaded_file_count: usize,
}

pub(crate) fn run() -> Result<(), String> {
    let cli = Cli::parse();
    match cli.command {
        Command::Ready => write_json_value(&handle_command("ready", None, None)?),
        Command::Version => write_json_value(&handle_command("version", None, None)?),
        Command::Serve => serve(),
        Command::Fingerprint => write_json_value(&handle_command(
            "fingerprint",
            Some(read_json_stdin_value()?),
            None,
        )?),
        Command::FingerprintBatch => write_json_value(&handle_command(
            "fingerprint-batch",
            Some(read_json_stdin_value()?),
            None,
        )?),
        Command::ScanLocalTree => write_json_value(&handle_command(
            "scan-local-tree",
            Some(read_json_stdin_value()?),
            None,
        )?),
        Command::PlanLocalToRemote => write_json_value(&handle_command(
            "plan-local-to-remote",
            Some(read_json_stdin_value()?),
            None,
        )?),
        Command::SyncLocalToRemote => {
            let runtime = build_runtime()?;
            write_json_value(&handle_command(
                "sync-local-to-remote",
                Some(read_json_stdin_value()?),
                Some(&runtime),
            )?)
        }
        Command::PlanRemoteToLocal => write_json_value(&handle_command(
            "plan-remote-to-local",
            Some(read_json_stdin_value()?),
            None,
        )?),
        Command::SyncRemoteToLocal => {
            let runtime = build_runtime()?;
            write_json_value(&handle_command(
                "sync-remote-to-local",
                Some(read_json_stdin_value()?),
                Some(&runtime),
            )?)
        }
        Command::PlanSeedUpload => write_json_value(&handle_command(
            "plan-seed-upload",
            Some(read_json_stdin_value()?),
            None,
        )?),
        Command::BuildSeedArchive => write_json_value(&handle_command(
            "build-seed-archive",
            Some(read_json_stdin_value()?),
            None,
        )?),
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

fn build_runtime() -> Result<tokio::runtime::Runtime, String> {
    RuntimeBuilder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(|error| format!("Failed to initialize async runtime: {error}"))
}

fn warm_native_object_store_stack() {
    let _ = create_s3_client(&NativeObjectStoreConfig {
        bucket: "oah-warmup".to_string(),
        region: "us-east-1".to_string(),
        endpoint: None,
        force_path_style: Some(true),
        access_key: Some("oah-warmup".to_string()),
        secret_key: Some("oah-warmup".to_string()),
        session_token: None,
    });
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
        "ready" => serialize_json_value(&ReadyResponse {
            ok: true,
            protocol_version: PROTOCOL_VERSION,
        }),
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
        "build-seed-archive" => {
            let request: BuildSeedArchiveRequest = parse_payload(payload, command)?;
            serialize_json_value(&build_seed_archive(request, PROTOCOL_VERSION)?)
        }
        "sync-local-to-sandbox-http" => {
            let request: SyncLocalToSandboxHttpRequest = parse_payload(payload, command)?;
            let runtime = runtime.ok_or_else(|| {
                "Async runtime is required for sync-local-to-sandbox-http.".to_string()
            })?;
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

pub(crate) fn handle_worker_request(
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
    let mut runtime = Some(build_runtime()?);
    warm_native_object_store_stack();
    let stdin = io::stdin();
    let stdout = io::stdout();
    let reader = BufReader::new(stdin.lock());
    let mut writer = BufWriter::new(stdout.lock());

    for line in reader.lines() {
        let line = line.map_err(|error| format!("Failed to read worker request: {error}"))?;
        if line.trim().is_empty() {
            continue;
        }

        let worker_started_at = Instant::now();
        let parse_started_at = Instant::now();
        let request = serde_json::from_str::<WorkerRequest>(&line)
            .map_err(|error| format!("Failed to decode worker request JSON: {error}"))?;
        let parse_ms = elapsed_millis_u64(parse_started_at);
        let receive_delay_ms = request
            .sent_at_ms
            .and_then(|sent_at_ms| {
                system_time_to_mtime_ms(SystemTime::now())
                    .map(|now_ms| now_ms.saturating_sub(sent_at_ms))
            })
            .map(|delay_ms| delay_ms.min(u128::from(u64::MAX)) as u64)
            .unwrap_or(0);
        let handle_started_at = Instant::now();
        let response = handle_worker_request(request, &mut runtime);
        let handle_ms = elapsed_millis_u64(handle_started_at);
        let mut response = response;
        if let Some(object) = response.as_object_mut() {
            object.insert(
                "workerTimings".to_string(),
                serde_json::to_value(WorkerRequestTimings {
                    receive_delay_ms,
                    parse_ms,
                    handle_ms,
                    serialize_ms: 0,
                    write_ms: 0,
                    total_worker_ms: elapsed_millis_u64(worker_started_at),
                })
                .map_err(|error| format!("Failed to serialize worker timings JSON: {error}"))?,
            );
        }
        let serialize_started_at = Instant::now();
        let _ = serde_json::to_string(&response)
            .map_err(|error| format!("Failed to serialize worker response JSON: {error}"))?;
        let serialize_ms = elapsed_millis_u64(serialize_started_at);
        if let Some(object) = response.as_object_mut() {
            object.insert(
                "workerTimings".to_string(),
                serde_json::to_value(WorkerRequestTimings {
                    receive_delay_ms,
                    parse_ms,
                    handle_ms,
                    serialize_ms,
                    write_ms: 0,
                    total_worker_ms: elapsed_millis_u64(worker_started_at),
                })
                .map_err(|error| format!("Failed to serialize worker timings JSON: {error}"))?,
            );
        }
        let rendered = serde_json::to_string(&response)
            .map_err(|error| format!("Failed to serialize worker response JSON: {error}"))?;
        let write_started_at = Instant::now();
        writer
            .write_all(rendered.as_bytes())
            .map_err(|error| format!("Failed to write worker response: {error}"))?;
        writer
            .write_all(b"\n")
            .map_err(|error| format!("Failed to write worker response newline: {error}"))?;
        writer
            .flush()
            .map_err(|error| format!("Failed to flush worker response: {error}"))?;
        let _write_ms = elapsed_millis_u64(write_started_at);
    }

    Ok(())
}
