use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::env;
use std::fs;
use std::future::Future;
use std::io::{self, BufRead, BufReader, BufWriter, Cursor, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command as ProcessCommand, ExitCode};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use aws_credential_types::Credentials;
use aws_sdk_s3::config::Region;
use aws_sdk_s3::error::ProvideErrorMetadata;
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
const INTERNAL_SYNC_BUNDLE_RELATIVE_PATH: &str = ".oah-sync-bundle.tar";
const INLINE_UPLOAD_THRESHOLD_BYTES: u64 = 128 * 1024;
const DEFAULT_SYNC_BUNDLE_MIN_FILE_COUNT: usize = 16;
const DEFAULT_SYNC_BUNDLE_MIN_TOTAL_BYTES: u64 = 128 * 1024;
const DEFAULT_IN_MEMORY_SYNC_BUNDLE_MIN_SOURCE_BYTES: u64 = 256 * 1024;
const DEFAULT_IN_MEMORY_SYNC_BUNDLE_MAX_SOURCE_BYTES: u64 = 8 * 1024 * 1024;
const DEFAULT_IN_MEMORY_SYNC_BUNDLE_EXTRACT_MAX_BYTES: u64 = 16 * 1024 * 1024;
const TAR_BLOCK_SIZE: usize = 512;
const IN_MEMORY_SYNC_BUNDLE_MIN_SOURCE_BYTES_ENV: &str =
    "OAH_NATIVE_WORKSPACE_SYNC_IN_MEMORY_BUNDLE_MIN_SOURCE_BYTES";
const IN_MEMORY_SYNC_BUNDLE_MAX_SOURCE_BYTES_ENV: &str =
    "OAH_NATIVE_WORKSPACE_SYNC_IN_MEMORY_BUNDLE_MAX_SOURCE_BYTES";
const IN_MEMORY_SYNC_BUNDLE_EXTRACT_MAX_BYTES_ENV: &str =
    "OAH_NATIVE_WORKSPACE_SYNC_IN_MEMORY_BUNDLE_EXTRACT_MAX_BYTES";
const RUST_SYNC_BUNDLE_WRITER_ENV: &str = "OAH_NATIVE_WORKSPACE_SYNC_RUST_BUNDLE_WRITER";

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
struct SyncLocalToRemoteRequest {
    root_dir: String,
    remote_prefix: String,
    #[serde(default)]
    exclude_relative_paths: Vec<String>,
    #[serde(default)]
    max_concurrency: Option<usize>,
    #[serde(default)]
    inline_upload_threshold_bytes: Option<u64>,
    #[serde(default)]
    sync_bundle: Option<NativeSyncBundleConfig>,
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
    #[serde(default)]
    remote_entries: Option<Vec<PlanRemoteEntry>>,
    #[serde(default)]
    has_sync_manifest: Option<bool>,
    #[serde(default)]
    bundle_entry: Option<PlanRemoteEntry>,
    #[serde(default)]
    sync_bundle: Option<NativeSyncBundleConfig>,
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
struct NativeSyncBundleConfig {
    mode: Option<String>,
    min_file_count: Option<usize>,
    min_total_bytes: Option<u64>,
    layout: Option<String>,
    trust_managed_prefixes: Option<bool>,
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
    #[serde(default)]
    sent_at_ms: Option<u128>,
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

#[derive(Clone)]
struct FileEntry {
    relative_path: String,
    absolute_path: String,
    size: u64,
    mtime_ms: u128,
    mode: u32,
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BuildSeedArchiveRequest {
    root_dir: String,
    archive_path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BuildSeedArchiveResponse {
    ok: bool,
    protocol_version: u32,
    archive_path: String,
    archive_bytes: u64,
    file_count: usize,
    empty_directory_count: usize,
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
    #[serde(default)]
    empty_directories: Vec<String>,
    #[serde(default)]
    storage_mode: Option<String>,
}

struct RemoteEntryListing {
    entries: Vec<PlanRemoteEntry>,
    has_sync_manifest: bool,
    bundle_entry: Option<PlanRemoteEntry>,
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum SyncBundleMode {
    Off,
    Auto,
    Force,
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum SyncBundleLayout {
    Sidecar,
    Primary,
}

#[derive(Clone, Copy)]
struct ResolvedSyncBundleConfig {
    mode: SyncBundleMode,
    min_file_count: usize,
    min_total_bytes: u64,
    layout: SyncBundleLayout,
    trust_managed_prefixes: bool,
}

static TRUSTED_MANAGED_PREFIX_CACHE: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct ObjectStoreRequestCounts {
    list_requests: usize,
    get_requests: usize,
    head_requests: usize,
    put_requests: usize,
    delete_requests: usize,
}

#[derive(Default)]
struct NativeObjectStoreRequestCounter {
    list_requests: AtomicUsize,
    get_requests: AtomicUsize,
    head_requests: AtomicUsize,
    put_requests: AtomicUsize,
    delete_requests: AtomicUsize,
}

impl NativeObjectStoreRequestCounter {
    fn increment_list(&self) {
        self.list_requests.fetch_add(1, Ordering::Relaxed);
    }

    fn increment_get(&self) {
        self.get_requests.fetch_add(1, Ordering::Relaxed);
    }

    fn increment_head(&self) {
        self.head_requests.fetch_add(1, Ordering::Relaxed);
    }

    fn increment_put(&self) {
        self.put_requests.fetch_add(1, Ordering::Relaxed);
    }

    fn increment_delete(&self) {
        self.delete_requests.fetch_add(1, Ordering::Relaxed);
    }

    fn snapshot(&self) -> ObjectStoreRequestCounts {
        ObjectStoreRequestCounts {
            list_requests: self.list_requests.load(Ordering::Relaxed),
            get_requests: self.get_requests.load(Ordering::Relaxed),
            head_requests: self.head_requests.load(Ordering::Relaxed),
            put_requests: self.put_requests.load(Ordering::Relaxed),
            delete_requests: self.delete_requests.load(Ordering::Relaxed),
        }
    }
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
struct SyncLocalToRemotePhaseTimings {
    scan_ms: u64,
    fingerprint_ms: u64,
    client_create_ms: u64,
    manifest_read_ms: u64,
    bundle_build_ms: u64,
    bundle_body_prepare_ms: u64,
    bundle_upload_ms: u64,
    bundle_transport: String,
    bundle_bytes: u64,
    manifest_write_ms: u64,
    delete_ms: u64,
    total_primary_path_ms: u64,
    total_command_ms: u64,
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
struct SyncLocalToRemoteResponse {
    ok: bool,
    protocol_version: u32,
    local_fingerprint: String,
    uploaded_file_count: usize,
    deleted_remote_count: usize,
    created_empty_directory_count: usize,
    request_counts: ObjectStoreRequestCounts,
    #[serde(skip_serializing_if = "Option::is_none")]
    phase_timings: Option<SyncLocalToRemotePhaseTimings>,
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
    request_counts: ObjectStoreRequestCounts,
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
            serialize_json_value(&build_seed_archive(request)?)
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

fn resolve_inline_upload_threshold_bytes(value: Option<u64>) -> u64 {
    value
        .filter(|value| *value > 0)
        .unwrap_or(INLINE_UPLOAD_THRESHOLD_BYTES)
}

fn resolve_sync_bundle_config(value: Option<&NativeSyncBundleConfig>) -> ResolvedSyncBundleConfig {
    let mode = match value
        .and_then(|config| config.mode.as_deref())
        .map(|mode| mode.trim().to_ascii_lowercase())
        .as_deref()
    {
        Some("0" | "false" | "off" | "no" | "disabled") => SyncBundleMode::Off,
        Some("1" | "true" | "on" | "yes" | "enabled" | "force") => SyncBundleMode::Force,
        _ => SyncBundleMode::Auto,
    };
    let layout = match value
        .and_then(|config| config.layout.as_deref())
        .map(|layout| layout.trim().to_ascii_lowercase())
        .as_deref()
    {
        Some("primary" | "bundle" | "bundle-only") => SyncBundleLayout::Primary,
        _ => SyncBundleLayout::Sidecar,
    };

    ResolvedSyncBundleConfig {
        mode,
        min_file_count: value
            .and_then(|config| config.min_file_count)
            .filter(|count| *count > 0)
            .unwrap_or(DEFAULT_SYNC_BUNDLE_MIN_FILE_COUNT),
        min_total_bytes: value
            .and_then(|config| config.min_total_bytes)
            .filter(|bytes| *bytes > 0)
            .unwrap_or(DEFAULT_SYNC_BUNDLE_MIN_TOTAL_BYTES),
        layout,
        trust_managed_prefixes: value
            .and_then(|config| config.trust_managed_prefixes)
            .unwrap_or(false),
    }
}

fn mark_trusted_managed_prefix_seen(remote_prefix: &str) {
    let cache = TRUSTED_MANAGED_PREFIX_CACHE.get_or_init(|| Mutex::new(HashSet::new()));
    if let Ok(mut seen) = cache.lock() {
        seen.insert(remote_prefix.to_string());
    }
}

fn should_assume_empty_trusted_managed_prefix(
    remote_prefix: &str,
    config: ResolvedSyncBundleConfig,
) -> bool {
    if !config.trust_managed_prefixes {
        return false;
    }

    let cache = TRUSTED_MANAGED_PREFIX_CACHE.get_or_init(|| Mutex::new(HashSet::new()));
    let Ok(mut seen) = cache.lock() else {
        return false;
    };
    if seen.contains(remote_prefix) {
        return false;
    }
    seen.insert(remote_prefix.to_string());
    true
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
            path.trim_end_matches(route_prefix)
                .trim_end_matches('/')
                .to_string()
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
        return (
            base_url.trim_end_matches('/').to_string(),
            "/internal/v1".to_string(),
        );
    }
    if let Some(base_url) = trimmed.strip_suffix("/api/v1") {
        return (
            base_url.trim_end_matches('/').to_string(),
            "/api/v1".to_string(),
        );
    }
    (trimmed, String::new())
}

impl NativeSandboxHttpClient {
    fn new(config: &NativeSandboxHttpConfig) -> Result<Self, String> {
        let mut headers = HeaderMap::new();
        for (key, value) in &config.headers {
            let name = HeaderName::from_bytes(key.as_bytes())
                .map_err(|error| format!("Invalid sandbox HTTP header name {key:?}: {error}"))?;
            let header_value = HeaderValue::from_str(value).map_err(|error| {
                format!("Invalid sandbox HTTP header value for {key:?}: {error}")
            })?;
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

    async fn upload_file(&self, path: &str, data: Vec<u8>, mtime_ms: u128) -> Result<(), String> {
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
            let payload = response
                .json::<NativeSandboxHttpFileStat>()
                .await
                .map_err(|error| {
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

fn sandbox_file_matches(
    local_size: u64,
    local_mtime_ms: u128,
    remote: &NativeSandboxHttpFileStat,
) -> bool {
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
    let normalized_base = base_path
        .replace('\\', "/")
        .trim_end_matches('/')
        .to_string();
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
        if should_keep_remote_sandbox_entry(&entry, &keep_directories, expected_files) {
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

    let normalized_relative_path = normalize_relative_path(relative_path);
    if normalized_relative_path == INTERNAL_SYNC_MANIFEST_RELATIVE_PATH {
        return true;
    }

    if normalized_relative_path == INTERNAL_SYNC_BUNDLE_RELATIVE_PATH {
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

fn metadata_mode(metadata: &fs::Metadata, default_mode: u32) -> u32 {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = metadata.permissions().mode() & 0o7777;
        if mode == 0 {
            return default_mode;
        }
        mode
    }

    #[cfg(not(unix))]
    {
        let _ = metadata;
        default_mode
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
            mode: metadata_mode(&metadata, 0o644),
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
                && !file_paths
                    .iter()
                    .any(|file_path| file_path.starts_with(&child_prefix))
        })
        .cloned()
        .collect()
}

fn build_sync_manifest(
    files: &[(String, u64, u128)],
    empty_directories: &[String],
    storage_mode: Option<&str>,
) -> SyncManifestDocument {
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

    let mut normalized_empty_directories = empty_directories
        .iter()
        .map(|relative_path| normalize_relative_path(relative_path))
        .filter(|relative_path| {
            !relative_path.is_empty() && !should_ignore_relative_path(relative_path)
        })
        .collect::<Vec<_>>();
    normalized_empty_directories.sort();
    normalized_empty_directories.dedup();

    SyncManifestDocument {
        version: 1,
        files: entries.into_iter().collect(),
        empty_directories: normalized_empty_directories,
        storage_mode: storage_mode.map(|value| value.to_string()),
    }
}

fn is_primary_bundle_manifest(document: &SyncManifestDocument) -> bool {
    matches!(
        document
            .storage_mode
            .as_deref()
            .map(|value| value.trim().to_ascii_lowercase()),
        Some(value) if value == "bundle" || value == "primary" || value == "bundle-only"
    )
}

fn create_remote_entries_from_manifest_document(
    document: &SyncManifestDocument,
    remote_prefix: &str,
    excludes: &[String],
) -> Vec<PlanRemoteEntry> {
    let mut entries = document
        .files
        .iter()
        .filter_map(|(relative_path, entry)| {
            let normalized = normalize_relative_path(relative_path);
            if normalized.is_empty()
                || should_ignore_relative_path(&normalized)
                || should_exclude_relative_path(&normalized, excludes)
            {
                return None;
            }

            Some(PlanRemoteEntry {
                relative_path: normalized.clone(),
                key: build_remote_path(remote_prefix, &normalized),
                size: entry.size,
                last_modified_ms: Some(entry.mtime_ms),
                is_directory: false,
            })
        })
        .collect::<Vec<_>>();

    entries.extend(
        document
            .empty_directories
            .iter()
            .filter_map(|relative_path| {
                let normalized = normalize_relative_path(relative_path);
                if normalized.is_empty()
                    || should_ignore_relative_path(&normalized)
                    || should_exclude_relative_path(&normalized, excludes)
                {
                    return None;
                }

                Some(PlanRemoteEntry {
                    relative_path: normalized.clone(),
                    key: format!("{}/", build_remote_path(remote_prefix, &normalized)),
                    size: 0,
                    last_modified_ms: None,
                    is_directory: true,
                })
            }),
    );
    entries.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
    entries
}

fn count_snapshot_file_mutations(
    snapshot: &Snapshot,
    existing_manifest: Option<&SyncManifestDocument>,
) -> usize {
    let Some(existing_manifest) = existing_manifest else {
        return snapshot.files.len();
    };

    snapshot
        .files
        .iter()
        .filter(|file| {
            existing_manifest
                .files
                .get(&file.relative_path)
                .map(|entry| entry.size != file.size || entry.mtime_ms != file.mtime_ms)
                .unwrap_or(true)
        })
        .count()
}

fn count_snapshot_deleted_files(
    snapshot: &Snapshot,
    existing_manifest: Option<&SyncManifestDocument>,
) -> usize {
    let Some(existing_manifest) = existing_manifest else {
        return 0;
    };
    let local_paths = snapshot
        .files
        .iter()
        .map(|file| file.relative_path.as_str())
        .collect::<BTreeSet<_>>();
    existing_manifest
        .files
        .keys()
        .filter(|relative_path| !local_paths.contains(relative_path.as_str()))
        .count()
}

fn count_snapshot_created_empty_directories(
    snapshot: &Snapshot,
    existing_manifest: Option<&SyncManifestDocument>,
) -> usize {
    let Some(existing_manifest) = existing_manifest else {
        return snapshot.empty_directories.len();
    };
    let existing = existing_manifest
        .empty_directories
        .iter()
        .map(|relative_path| normalize_relative_path(relative_path))
        .collect::<BTreeSet<_>>();
    snapshot
        .empty_directories
        .iter()
        .filter(|relative_path| !existing.contains(*relative_path))
        .count()
}

fn should_attempt_sync_bundle(
    file_count: usize,
    total_bytes: u64,
    config: ResolvedSyncBundleConfig,
) -> bool {
    if file_count == 0 {
        return false;
    }

    match config.mode {
        SyncBundleMode::Off => false,
        SyncBundleMode::Force => true,
        SyncBundleMode::Auto => {
            file_count >= config.min_file_count || total_bytes >= config.min_total_bytes
        }
    }
}

fn should_attempt_sync_bundle_for_snapshot(
    snapshot: &Snapshot,
    config: ResolvedSyncBundleConfig,
) -> bool {
    let file_count = snapshot.files.len();
    let total_bytes = snapshot.files.iter().map(|file| file.size).sum::<u64>();
    should_attempt_sync_bundle(file_count, total_bytes, config)
}

fn should_attempt_sync_bundle_for_remote_entries(
    remote_entries: &[PlanRemoteEntry],
    config: ResolvedSyncBundleConfig,
) -> bool {
    let file_count = remote_entries
        .iter()
        .filter(|entry| !entry.is_directory)
        .count();
    let total_bytes = remote_entries
        .iter()
        .filter(|entry| !entry.is_directory)
        .map(|entry| entry.size)
        .sum::<u64>();
    should_attempt_sync_bundle(file_count, total_bytes, config)
}

fn count_remote_file_entries(remote_entries: &[PlanRemoteEntry]) -> usize {
    remote_entries
        .iter()
        .filter(|entry| !entry.is_directory)
        .count()
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

fn build_seed_archive(
    request: BuildSeedArchiveRequest,
) -> Result<BuildSeedArchiveResponse, String> {
    let root_dir = PathBuf::from(&request.root_dir);
    let archive_path = PathBuf::from(&request.archive_path);
    let snapshot = collect_snapshot(&root_dir, &[])?;
    let archive_parent = archive_path.parent().ok_or_else(|| {
        format!(
            "Failed to resolve parent directory for seed archive {}.",
            archive_path.display()
        )
    })?;
    fs::create_dir_all(archive_parent).map_err(|error| {
        format!(
            "Failed to create seed archive directory {}: {error}",
            archive_parent.display()
        )
    })?;

    let mut archive_file = tempfile::Builder::new()
        .prefix(".oah-seed-")
        .suffix(".tar.tmp")
        .tempfile_in(archive_parent)
        .map_err(|error| format!("Failed to create temporary seed archive file: {error}"))?;
    let relative_paths = collect_bundle_relative_paths(&snapshot);
    let wrote_with_tar =
        run_tar_with_file_list_to_path(&root_dir, &relative_paths, archive_file.path())?;
    if !wrote_with_tar {
        let mut files = snapshot.files.clone();
        files.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
        let empty_directories = snapshot
            .empty_directories
            .iter()
            .cloned()
            .collect::<Vec<_>>();
        write_snapshot_tar_archive(archive_file.as_file_mut(), &files, &empty_directories)
            .map_err(|error| format!("Failed to build seed archive: {error}"))?;
    }
    archive_file
        .as_file_mut()
        .flush()
        .map_err(|error| format!("Failed to flush seed archive: {error}"))?;

    let temp_archive_path = archive_file.into_temp_path();
    fs::rename(&temp_archive_path, &archive_path).map_err(|error| {
        format!(
            "Failed to move temporary seed archive {} to {}: {error}",
            temp_archive_path.display(),
            archive_path.display()
        )
    })?;
    let archive_bytes = fs::metadata(&archive_path)
        .map_err(|error| {
            format!(
                "Failed to stat seed archive {} after build: {error}",
                archive_path.display()
            )
        })?
        .len();

    Ok(BuildSeedArchiveResponse {
        ok: true,
        protocol_version: PROTOCOL_VERSION,
        archive_path: normalize_path(&archive_path),
        archive_bytes,
        file_count: snapshot.files.len(),
        empty_directory_count: snapshot.empty_directories.len(),
    })
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
    request_counter: &NativeObjectStoreRequestCounter,
) -> Result<RemoteEntryListing, String> {
    let normalized_prefix = normalize_relative_path(remote_prefix);
    let mut continuation_token = None;
    let mut entries = Vec::new();
    let mut has_sync_manifest = false;
    let mut bundle_entry = None;

    loop {
        let mut request = client
            .list_objects_v2()
            .bucket(&config.bucket)
            .set_continuation_token(continuation_token.clone());
        if !normalized_prefix.is_empty() {
            request = request.prefix(format!("{normalized_prefix}/"));
        }

        request_counter.increment_list();
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
            let normalized_relative_path = normalize_relative_path(&relative_path);
            if normalized_relative_path == INTERNAL_SYNC_MANIFEST_RELATIVE_PATH {
                has_sync_manifest = true;
                continue;
            }
            if normalized_relative_path == INTERNAL_SYNC_BUNDLE_RELATIVE_PATH {
                bundle_entry = Some(PlanRemoteEntry {
                    relative_path,
                    key: key.to_string(),
                    size: item.size().unwrap_or_default().max(0) as u64,
                    last_modified_ms: item
                        .last_modified()
                        .and_then(|value| value.to_millis().ok())
                        .map(|value| value.max(0) as u128),
                    is_directory: false,
                });
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
        bundle_entry,
    })
}

async fn load_remote_sync_manifest_document(
    client: &S3Client,
    config: &NativeObjectStoreConfig,
    remote_prefix: &str,
    request_counter: &NativeObjectStoreRequestCounter,
) -> Result<Option<SyncManifestDocument>, String> {
    let key = build_remote_path(remote_prefix, INTERNAL_SYNC_MANIFEST_RELATIVE_PATH);
    request_counter.increment_get();
    let response = match client
        .get_object()
        .bucket(&config.bucket)
        .key(&key)
        .send()
        .await
    {
        Ok(response) => response,
        Err(_) => return Ok(None),
    };

    let mut body = response.body.into_async_read();
    let mut bytes = Vec::new();
    body.read_to_end(&mut bytes)
        .await
        .map_err(|error| format!("Failed to read sync manifest {key}: {error}"))?;
    let document = serde_json::from_slice::<SyncManifestDocument>(&bytes)
        .map_err(|error| format!("Failed to parse sync manifest {key}: {error}"))?;
    if document.version != 1 {
        return Ok(None);
    }

    Ok(Some(document))
}

async fn load_remote_sync_manifest(
    client: &S3Client,
    config: &NativeObjectStoreConfig,
    remote_prefix: &str,
    has_sync_manifest: bool,
    request_counter: &NativeObjectStoreRequestCounter,
) -> Result<BTreeMap<String, SyncManifestFileEntry>, String> {
    if !has_sync_manifest {
        return Ok(BTreeMap::new());
    }

    let Some(document) =
        load_remote_sync_manifest_document(client, config, remote_prefix, request_counter).await?
    else {
        return Ok(BTreeMap::new());
    };

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
    empty_directories: &[String],
    storage_mode: Option<&str>,
    existing_manifest: Option<&SyncManifestDocument>,
    request_counter: &NativeObjectStoreRequestCounter,
) -> Result<(), String> {
    let manifest = build_sync_manifest(files, empty_directories, storage_mode);
    if let Some(existing_manifest) = existing_manifest {
        if existing_manifest.files.len() == manifest.files.len()
            && existing_manifest.empty_directories == manifest.empty_directories
            && existing_manifest.storage_mode == manifest.storage_mode
            && manifest.files.iter().all(|(relative_path, entry)| {
                existing_manifest
                    .files
                    .get(relative_path)
                    .map(|existing| {
                        existing.size == entry.size && existing.mtime_ms == entry.mtime_ms
                    })
                    .unwrap_or(false)
            })
        {
            return Ok(());
        }
    }

    let key = build_remote_path(remote_prefix, INTERNAL_SYNC_MANIFEST_RELATIVE_PATH);
    let body = serde_json::to_vec(&manifest)
        .map_err(|error| format!("Failed to serialize sync manifest {key}: {error}"))?;
    request_counter.increment_put();
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

fn build_local_sync_bundle_blocking(
    file_entries: Vec<FileEntry>,
    empty_directories: Vec<String>,
) -> Result<tempfile::TempPath, String> {
    let mut bundle_file = tempfile::NamedTempFile::new()
        .map_err(|error| format!("Failed to create temporary sync bundle file: {error}"))?;
    write_snapshot_tar_archive(bundle_file.as_file_mut(), &file_entries, &empty_directories)
        .map_err(|error| format!("Failed to build sync bundle archive: {error}"))?;
    bundle_file
        .as_file_mut()
        .flush()
        .map_err(|error| format!("Failed to flush sync bundle archive: {error}"))?;
    Ok(bundle_file.into_temp_path())
}

fn write_tar_file_list(relative_paths: &[String], list_file: &mut fs::File) -> Result<(), String> {
    for (index, relative_path) in relative_paths.iter().enumerate() {
        list_file
            .write_all(relative_path.as_bytes())
            .map_err(|error| {
                format!("Failed to write sync bundle file list entry {relative_path}: {error}")
            })?;
        if index + 1 < relative_paths.len() {
            list_file.write_all(&[0]).map_err(|error| {
                format!(
                    "Failed to write sync bundle file list separator after {relative_path}: {error}"
                )
            })?;
        }
    }
    list_file
        .flush()
        .map_err(|error| format!("Failed to flush sync bundle file list: {error}"))
}

fn run_tar_with_file_list_to_path(
    root_dir: &Path,
    relative_paths: &[String],
    output_path: &Path,
) -> Result<bool, String> {
    if relative_paths.is_empty() {
        return Ok(false);
    }

    let mut list_file = tempfile::NamedTempFile::new()
        .map_err(|error| format!("Failed to create temporary sync bundle file list: {error}"))?;
    write_tar_file_list(relative_paths, list_file.as_file_mut())?;

    let status = match ProcessCommand::new("tar")
        .env("COPYFILE_DISABLE", "1")
        .env("COPY_EXTENDED_ATTRIBUTES_DISABLE", "1")
        .arg("-cf")
        .arg(output_path)
        .arg("--null")
        .arg("-T")
        .arg(list_file.path())
        .arg("-C")
        .arg(root_dir)
        .status()
    {
        Ok(status) => status,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(_) => return Ok(false),
    };

    Ok(status.success())
}

fn try_build_local_sync_bundle_with_tar_blocking(
    root_dir: &Path,
    relative_paths: &[String],
) -> Result<Option<tempfile::TempPath>, String> {
    let mut bundle_file = tempfile::NamedTempFile::new()
        .map_err(|error| format!("Failed to create temporary sync bundle file: {error}"))?;
    if !run_tar_with_file_list_to_path(root_dir, relative_paths, bundle_file.path())? {
        return Ok(None);
    }

    bundle_file
        .as_file_mut()
        .flush()
        .map_err(|error| format!("Failed to flush sync bundle archive: {error}"))?;
    Ok(Some(bundle_file.into_temp_path()))
}

fn try_build_local_sync_bundle_root_with_tar_blocking(
    root_dir: &Path,
) -> Result<Option<tempfile::TempPath>, String> {
    let mut bundle_file = tempfile::NamedTempFile::new()
        .map_err(|error| format!("Failed to create temporary sync bundle file: {error}"))?;

    let status = match ProcessCommand::new("tar")
        .env("COPYFILE_DISABLE", "1")
        .env("COPY_EXTENDED_ATTRIBUTES_DISABLE", "1")
        .arg("-cf")
        .arg(bundle_file.path())
        .arg("--exclude")
        .arg(INTERNAL_SYNC_MANIFEST_RELATIVE_PATH)
        .arg("--exclude")
        .arg(INTERNAL_SYNC_BUNDLE_RELATIVE_PATH)
        .arg("-C")
        .arg(root_dir)
        .arg(".")
        .status()
    {
        Ok(status) => status,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Ok(None),
    };

    if !status.success() {
        return Ok(None);
    }

    bundle_file
        .as_file_mut()
        .flush()
        .map_err(|error| format!("Failed to flush sync bundle archive: {error}"))?;
    Ok(Some(bundle_file.into_temp_path()))
}

fn try_build_local_sync_bundle_with_tar_to_memory_blocking(
    root_dir: &Path,
    relative_paths: &[String],
) -> Result<Option<Vec<u8>>, String> {
    if relative_paths.is_empty() {
        return Ok(None);
    }

    let mut list_file = tempfile::NamedTempFile::new()
        .map_err(|error| format!("Failed to create temporary sync bundle file list: {error}"))?;
    write_tar_file_list(relative_paths, list_file.as_file_mut())?;

    let output = match ProcessCommand::new("tar")
        .env("COPYFILE_DISABLE", "1")
        .env("COPY_EXTENDED_ATTRIBUTES_DISABLE", "1")
        .arg("-cf")
        .arg("-")
        .arg("--null")
        .arg("-T")
        .arg(list_file.path())
        .arg("-C")
        .arg(root_dir)
        .output()
    {
        Ok(output) => output,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Ok(None),
    };

    if !output.status.success() {
        return Ok(None);
    }

    Ok(Some(output.stdout))
}

fn try_build_local_sync_bundle_root_with_tar_to_memory_blocking(
    root_dir: &Path,
) -> Result<Option<Vec<u8>>, String> {
    let output = match ProcessCommand::new("tar")
        .env("COPYFILE_DISABLE", "1")
        .env("COPY_EXTENDED_ATTRIBUTES_DISABLE", "1")
        .arg("-cf")
        .arg("-")
        .arg("--exclude")
        .arg(INTERNAL_SYNC_MANIFEST_RELATIVE_PATH)
        .arg("--exclude")
        .arg(INTERNAL_SYNC_BUNDLE_RELATIVE_PATH)
        .arg("-C")
        .arg(root_dir)
        .arg(".")
        .output()
    {
        Ok(output) => output,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Ok(None),
    };

    if !output.status.success() {
        return Ok(None);
    }

    Ok(Some(output.stdout))
}

fn write_snapshot_tar_archive<W: Write>(
    writer: W,
    file_entries: &[FileEntry],
    empty_directories: &[String],
) -> io::Result<W> {
    let mut builder = tar::Builder::new(writer);
    builder.mode(tar::HeaderMode::Deterministic);

    for file in file_entries {
        let mut source = fs::File::open(&file.absolute_path)?;
        let mut header = tar::Header::new_gnu();
        header.set_entry_type(tar::EntryType::Regular);
        header.set_size(file.size);
        header.set_mode(file.mode);
        header.set_mtime((file.mtime_ms / 1000).min(u128::from(u64::MAX)) as u64);
        header.set_cksum();
        builder.append_data(&mut header, Path::new(&file.relative_path), &mut source)?;
    }

    for relative_path in empty_directories {
        let mut header = tar::Header::new_gnu();
        header.set_entry_type(tar::EntryType::Directory);
        header.set_size(0);
        header.set_mode(0o755);
        header.set_mtime(0);
        header.set_cksum();
        builder.append_data(&mut header, Path::new(relative_path), io::empty())?;
    }

    builder.into_inner()
}

fn split_ustar_path(path: &str) -> Option<(&str, &str)> {
    let path = path.trim_start_matches("./").trim_end_matches('/');
    if path.is_empty() {
        return None;
    }

    if path.as_bytes().len() <= 100 {
        return Some(("", path));
    }

    for (index, _) in path.match_indices('/').rev() {
        let prefix = &path[..index];
        let name = &path[index + 1..];
        if !name.is_empty() && prefix.as_bytes().len() <= 155 && name.as_bytes().len() <= 100 {
            return Some((prefix, name));
        }
    }

    None
}

fn write_octal_field(header: &mut [u8], start: usize, len: usize, value: u64) -> io::Result<()> {
    if len == 0 {
        return Ok(());
    }

    let digits_len = len.saturating_sub(1);
    let value_text = format!("{value:0digits_len$o}");
    if value_text.len() > digits_len {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "tar header numeric field is too large",
        ));
    }

    let field = &mut header[start..start + len];
    field.fill(b'0');
    let offset = digits_len - value_text.len();
    field[offset..offset + value_text.len()].copy_from_slice(value_text.as_bytes());
    field[len - 1] = 0;
    Ok(())
}

fn write_ustar_header<W: Write>(
    writer: &mut W,
    relative_path: &str,
    size: u64,
    mode: u32,
    mtime_seconds: u64,
    entry_type: u8,
) -> io::Result<()> {
    let (prefix, name) = split_ustar_path(relative_path).ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("tar path is too long for ustar header: {relative_path}"),
        )
    })?;
    let mut header = [0_u8; TAR_BLOCK_SIZE];
    header[0..name.len()].copy_from_slice(name.as_bytes());
    write_octal_field(&mut header, 100, 8, u64::from(mode))?;
    write_octal_field(&mut header, 108, 8, 0)?;
    write_octal_field(&mut header, 116, 8, 0)?;
    write_octal_field(&mut header, 124, 12, size)?;
    write_octal_field(&mut header, 136, 12, mtime_seconds)?;
    header[148..156].fill(b' ');
    header[156] = entry_type;
    header[257..263].copy_from_slice(b"ustar\0");
    header[263..265].copy_from_slice(b"00");
    if !prefix.is_empty() {
        header[345..345 + prefix.len()].copy_from_slice(prefix.as_bytes());
    }

    let checksum = header.iter().map(|byte| u32::from(*byte)).sum::<u32>();
    let checksum_text = format!("{checksum:06o}");
    header[148..154].copy_from_slice(checksum_text.as_bytes());
    header[154] = 0;
    header[155] = b' ';
    writer.write_all(&header)
}

fn write_padding<W: Write>(writer: &mut W, size: u64) -> io::Result<()> {
    let remainder = (size as usize) % TAR_BLOCK_SIZE;
    if remainder == 0 {
        return Ok(());
    }

    let padding = [0_u8; TAR_BLOCK_SIZE];
    writer.write_all(&padding[..TAR_BLOCK_SIZE - remainder])
}

fn write_snapshot_ustar_archive<W: Write>(
    mut writer: W,
    file_entries: &[FileEntry],
    empty_directories: &[String],
) -> io::Result<W> {
    let mut buffer = [0_u8; 64 * 1024];
    for file in file_entries {
        write_ustar_header(
            &mut writer,
            &file.relative_path,
            file.size,
            file.mode,
            (file.mtime_ms / 1000).min(u128::from(u64::MAX)) as u64,
            b'0',
        )?;
        let mut source = fs::File::open(&file.absolute_path)?;
        loop {
            let read = source.read(&mut buffer)?;
            if read == 0 {
                break;
            }
            writer.write_all(&buffer[..read])?;
        }
        write_padding(&mut writer, file.size)?;
    }

    for relative_path in empty_directories {
        let directory_path = format!("{}/", relative_path.trim_end_matches('/'));
        write_ustar_header(&mut writer, &directory_path, 0, 0o755, 0, b'5')?;
    }

    writer.write_all(&[0_u8; TAR_BLOCK_SIZE])?;
    writer.write_all(&[0_u8; TAR_BLOCK_SIZE])?;
    Ok(writer)
}

fn build_local_sync_bundle_to_memory_blocking(
    file_entries: &[FileEntry],
    empty_directories: &[String],
) -> Result<Vec<u8>, String> {
    write_snapshot_ustar_archive(Vec::new(), file_entries, empty_directories)
        .map_err(|error| format!("Failed to build in-memory sync bundle archive: {error}"))
}

fn collect_bundle_relative_paths(snapshot: &Snapshot) -> Vec<String> {
    let mut relative_paths = snapshot
        .files
        .iter()
        .map(|file| file.relative_path.clone())
        .chain(snapshot.empty_directories.iter().cloned())
        .collect::<Vec<_>>();
    relative_paths.sort();
    relative_paths
}

enum BuiltSyncBundle {
    TempPath(tempfile::TempPath),
    Bytes(Vec<u8>),
}

#[derive(Clone, Copy)]
struct InMemorySyncBundleSourceByteRange {
    min: u64,
    max: u64,
}

fn read_u64_env(name: &str) -> Option<u64> {
    let raw = env::var(name).ok()?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }

    trimmed.parse::<u64>().ok()
}

fn read_bool_env(name: &str) -> Option<bool> {
    let raw = env::var(name).ok()?;
    let normalized = raw.trim().to_ascii_lowercase();
    if normalized.is_empty() {
        return None;
    }

    if matches!(normalized.as_str(), "1" | "true" | "yes" | "on") {
        return Some(true);
    }

    if matches!(normalized.as_str(), "0" | "false" | "no" | "off") {
        return Some(false);
    }

    None
}

fn should_use_rust_sync_bundle_writer() -> bool {
    read_bool_env(RUST_SYNC_BUNDLE_WRITER_ENV).unwrap_or(true)
}

fn resolve_in_memory_sync_bundle_source_byte_range() -> InMemorySyncBundleSourceByteRange {
    let min = read_u64_env(IN_MEMORY_SYNC_BUNDLE_MIN_SOURCE_BYTES_ENV)
        .unwrap_or(DEFAULT_IN_MEMORY_SYNC_BUNDLE_MIN_SOURCE_BYTES);
    let mut max = read_u64_env(IN_MEMORY_SYNC_BUNDLE_MAX_SOURCE_BYTES_ENV)
        .unwrap_or(DEFAULT_IN_MEMORY_SYNC_BUNDLE_MAX_SOURCE_BYTES);
    if max < min {
        max = min;
    }

    InMemorySyncBundleSourceByteRange { min, max }
}

fn should_build_sync_bundle_in_memory(snapshot_total_bytes: u64) -> bool {
    let range = resolve_in_memory_sync_bundle_source_byte_range();
    (range.min..=range.max).contains(&snapshot_total_bytes)
}

async fn build_local_sync_bundle(
    root_dir: &Path,
    snapshot: &Snapshot,
    excludes: &[String],
) -> Result<BuiltSyncBundle, String> {
    let root_dir_buf = root_dir.to_path_buf();
    let relative_paths = collect_bundle_relative_paths(snapshot);
    if excludes.is_empty() {
        let can_use_root_tar_fast_path = snapshot.ignored_paths.is_empty();
        let snapshot_total_bytes = snapshot.files.iter().map(|file| file.size).sum::<u64>();
        if should_build_sync_bundle_in_memory(snapshot_total_bytes) {
            if should_use_rust_sync_bundle_writer() {
                let file_entries = snapshot.files.clone();
                let empty_directories = snapshot
                    .empty_directories
                    .iter()
                    .cloned()
                    .collect::<Vec<_>>();
                if let Ok(bundle_bytes) = tokio::task::spawn_blocking(move || {
                    let mut file_entries = file_entries;
                    file_entries
                        .sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
                    build_local_sync_bundle_to_memory_blocking(&file_entries, &empty_directories)
                })
                .await
                .map_err(|error| format!("Sync bundle worker task failed: {error}"))?
                {
                    return Ok(BuiltSyncBundle::Bytes(bundle_bytes));
                }
            }

            if can_use_root_tar_fast_path {
                let root_dir_for_in_memory_fast_path = root_dir_buf.clone();
                if let Some(bundle_bytes) = tokio::task::spawn_blocking(move || {
                    try_build_local_sync_bundle_root_with_tar_to_memory_blocking(
                        &root_dir_for_in_memory_fast_path,
                    )
                })
                .await
                .map_err(|error| format!("Sync bundle worker task failed: {error}"))??
                {
                    return Ok(BuiltSyncBundle::Bytes(bundle_bytes));
                }
            } else {
                let root_dir_for_in_memory_fast_path = root_dir_buf.clone();
                let relative_paths_for_in_memory_fast_path = relative_paths.clone();
                if let Some(bundle_bytes) = tokio::task::spawn_blocking(move || {
                    try_build_local_sync_bundle_with_tar_to_memory_blocking(
                        &root_dir_for_in_memory_fast_path,
                        &relative_paths_for_in_memory_fast_path,
                    )
                })
                .await
                .map_err(|error| format!("Sync bundle worker task failed: {error}"))??
                {
                    return Ok(BuiltSyncBundle::Bytes(bundle_bytes));
                }
            }
        }

        let root_dir_for_fast_path = root_dir_buf.clone();
        if can_use_root_tar_fast_path {
            if let Some(bundle_path) = tokio::task::spawn_blocking(move || {
                try_build_local_sync_bundle_root_with_tar_blocking(&root_dir_for_fast_path)
            })
            .await
            .map_err(|error| format!("Sync bundle worker task failed: {error}"))??
            {
                return Ok(BuiltSyncBundle::TempPath(bundle_path));
            }
        } else {
            let relative_paths_for_fast_path = relative_paths.clone();
            if let Some(bundle_path) = tokio::task::spawn_blocking(move || {
                try_build_local_sync_bundle_with_tar_blocking(
                    &root_dir_for_fast_path,
                    &relative_paths_for_fast_path,
                )
            })
            .await
            .map_err(|error| format!("Sync bundle worker task failed: {error}"))??
            {
                return Ok(BuiltSyncBundle::TempPath(bundle_path));
            }
        }
    }

    let file_entries_input = snapshot.files.iter().cloned().collect::<Vec<_>>();
    let empty_directory_relative_paths = snapshot
        .empty_directories
        .iter()
        .cloned()
        .collect::<Vec<_>>();

    tokio::task::spawn_blocking(move || {
        if let Some(bundle_path) =
            try_build_local_sync_bundle_with_tar_blocking(&root_dir_buf, &relative_paths)?
        {
            return Ok(BuiltSyncBundle::TempPath(bundle_path));
        }

        let mut file_entries = file_entries_input;
        file_entries.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));

        build_local_sync_bundle_blocking(file_entries, empty_directory_relative_paths)
            .map(BuiltSyncBundle::TempPath)
    })
    .await
    .map_err(|error| format!("Sync bundle worker task failed: {error}"))?
}

struct UploadSyncBundleResult {
    bundle_build_ms: u64,
    bundle_body_prepare_ms: u64,
    bundle_upload_ms: u64,
    bundle_transport: &'static str,
    bundle_bytes: u64,
}

async fn upload_sync_bundle(
    client: &S3Client,
    config: &NativeObjectStoreConfig,
    remote_prefix: &str,
    root_dir: &Path,
    snapshot: &Snapshot,
    excludes: &[String],
    request_counter: &NativeObjectStoreRequestCounter,
) -> Result<UploadSyncBundleResult, String> {
    let key = build_remote_path(remote_prefix, INTERNAL_SYNC_BUNDLE_RELATIVE_PATH);
    let bundle_build_started_at = Instant::now();
    let bundle = build_local_sync_bundle(root_dir, snapshot, excludes).await?;
    let bundle_build_ms = elapsed_millis_u64(bundle_build_started_at);
    request_counter.increment_put();
    match bundle {
        BuiltSyncBundle::Bytes(bundle_bytes) => {
            let bundle_len = bundle_bytes.len() as u64;
            let bundle_body_prepare_ms = 0;
            let bundle_upload_started_at = Instant::now();
            client
                .put_object()
                .bucket(&config.bucket)
                .key(&key)
                .content_length(bundle_bytes.len() as i64)
                .body(ByteStream::from(bundle_bytes))
                .send()
                .await
                .map_err(|error| format!("Failed to write sync bundle object: {error}"))?;
            Ok(UploadSyncBundleResult {
                bundle_build_ms,
                bundle_body_prepare_ms,
                bundle_upload_ms: elapsed_millis_u64(bundle_upload_started_at),
                bundle_transport: "memory",
                bundle_bytes: bundle_len,
            })
        }
        BuiltSyncBundle::TempPath(bundle_path) => {
            let bundle_path_ref = bundle_path.as_ref() as &Path;
            let bundle_len = tokio::fs::metadata(bundle_path_ref)
                .await
                .map_err(|error| format!("Failed to stat sync bundle file for upload: {error}"))?
                .len();
            let bundle_body_prepare_started_at = Instant::now();
            let body = ByteStream::read_from()
                .path(bundle_path_ref)
                .build()
                .await
                .map_err(|error| {
                    format!("Failed to stream sync bundle file for upload: {error}")
                })?;
            let bundle_body_prepare_ms = elapsed_millis_u64(bundle_body_prepare_started_at);
            let bundle_upload_started_at = Instant::now();
            client
                .put_object()
                .bucket(&config.bucket)
                .key(&key)
                .content_length(bundle_len as i64)
                .body(body)
                .send()
                .await
                .map_err(|error| format!("Failed to write sync bundle object: {error}"))?;
            Ok(UploadSyncBundleResult {
                bundle_build_ms,
                bundle_body_prepare_ms,
                bundle_upload_ms: elapsed_millis_u64(bundle_upload_started_at),
                bundle_transport: "tempfile",
                bundle_bytes: bundle_len,
            })
        }
    }
}

async fn delete_remote_object_if_present(
    client: &S3Client,
    config: &NativeObjectStoreConfig,
    key: &str,
    request_counter: &NativeObjectStoreRequestCounter,
) -> Result<(), String> {
    let delete = Delete::builder()
        .objects(
            ObjectIdentifier::builder()
                .key(key)
                .build()
                .map_err(|error| {
                    format!("Failed to prepare S3 delete object identifier: {error}")
                })?,
        )
        .build()
        .map_err(|error| format!("Failed to prepare S3 delete request: {error}"))?;
    request_counter.increment_delete();
    client
        .delete_objects()
        .bucket(&config.bucket)
        .delete(delete)
        .send()
        .await
        .map_err(|error| format!("Failed to delete S3 object {key}: {error}"))?;
    Ok(())
}

fn prune_empty_local_directories_blocking(root_dir: &Path) -> Result<(), String> {
    let Ok(metadata) = fs::metadata(root_dir) else {
        return Ok(());
    };
    if !metadata.is_dir() {
        return Ok(());
    }

    fn walk(directory: &Path) -> Result<bool, String> {
        let entries = match fs::read_dir(directory) {
            Ok(entries) => entries,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
            Err(error) => {
                return Err(format!(
                    "Failed to read local directory {} while pruning empty directories: {error}",
                    directory.display()
                ));
            }
        };

        let mut has_children = false;
        for entry in entries {
            let entry = entry.map_err(|error| {
                format!(
                    "Failed to read local directory entry in {} while pruning empty directories: {error}",
                    directory.display()
                )
            })?;
            let path = entry.path();
            let file_type = entry.file_type().map_err(|error| {
                format!(
                    "Failed to inspect local directory entry {} while pruning empty directories: {error}",
                    path.display()
                )
            })?;

            if file_type.is_dir() {
                let keep_child = walk(&path)?;
                if !keep_child {
                    fs::remove_dir_all(&path).map_err(|error| {
                        format!(
                            "Failed to remove empty local directory {}: {error}",
                            path.display()
                        )
                    })?;
                    continue;
                }
            }

            has_children = true;
        }

        Ok(has_children)
    }

    walk(root_dir)?;
    Ok(())
}

async fn prune_empty_local_directories(root_dir: &Path) -> Result<(), String> {
    let root_dir = root_dir.to_path_buf();
    tokio::task::spawn_blocking(move || prune_empty_local_directories_blocking(&root_dir))
        .await
        .map_err(|error| format!("Empty directory prune worker task failed: {error}"))?
}

async fn is_local_directory_empty(target_path: &Path) -> Result<bool, String> {
    match tokio::fs::metadata(target_path).await {
        Ok(metadata) if !metadata.is_dir() => Ok(false),
        Ok(_) => {
            let mut entries = tokio::fs::read_dir(target_path).await.map_err(|error| {
                format!(
                    "Failed to read local directory {}: {error}",
                    target_path.display()
                )
            })?;
            Ok(entries
                .next_entry()
                .await
                .map_err(|error| {
                    format!(
                        "Failed to inspect local directory {}: {error}",
                        target_path.display()
                    )
                })?
                .is_none())
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(true),
        Err(error) => Err(format!(
            "Failed to stat local directory {}: {error}",
            target_path.display()
        )),
    }
}

fn unpack_sync_bundle_reader_blocking<R: Read>(root_dir: PathBuf, reader: R) -> Result<(), String> {
    fs::create_dir_all(&root_dir).map_err(|error| {
        format!(
            "Failed to create local bundle root {}: {error}",
            root_dir.display()
        )
    })?;
    let mut archive = tar::Archive::new(reader);
    archive.unpack(&root_dir).map_err(|error| {
        format!(
            "Failed to unpack sync bundle into {}: {error}",
            root_dir.display()
        )
    })
}

fn unpack_sync_bundle_blocking(root_dir: PathBuf, bundle_path: PathBuf) -> Result<(), String> {
    let bundle_file = fs::File::open(&bundle_path).map_err(|error| {
        format!(
            "Failed to open sync bundle archive {}: {error}",
            bundle_path.display()
        )
    })?;
    unpack_sync_bundle_reader_blocking(root_dir, bundle_file)
}

fn unpack_sync_bundle_bytes_blocking(
    root_dir: PathBuf,
    bundle_bytes: Vec<u8>,
) -> Result<(), String> {
    unpack_sync_bundle_reader_blocking(root_dir, Cursor::new(bundle_bytes))
}

fn resolve_in_memory_sync_bundle_extract_max_bytes() -> u64 {
    read_u64_env(IN_MEMORY_SYNC_BUNDLE_EXTRACT_MAX_BYTES_ENV)
        .unwrap_or(DEFAULT_IN_MEMORY_SYNC_BUNDLE_EXTRACT_MAX_BYTES)
}

async fn maybe_hydrate_from_remote_sync_bundle(
    client: &S3Client,
    config: &NativeObjectStoreConfig,
    root_dir: &Path,
    bundle_key: &str,
    require_empty_root: bool,
    request_counter: &NativeObjectStoreRequestCounter,
) -> Result<bool, String> {
    if require_empty_root && !is_local_directory_empty(root_dir).await? {
        return Ok(false);
    }

    let hydrated = async {
        let bundle_path = tempfile::NamedTempFile::new()
            .map_err(|error| format!("Failed to create temporary sync bundle file: {error}"))?
            .into_temp_path();
        request_counter.increment_get();
        let response = match client
            .get_object()
            .bucket(&config.bucket)
            .key(bundle_key)
            .send()
            .await
        {
            Ok(response) => response,
            Err(error) => {
                if error.code() == Some("NoSuchKey") {
                    return Ok(false);
                }
                return Err(format!(
                    "Failed to download sync bundle {bundle_key}: {error}"
                ));
            }
        };

        let content_length = response.content_length().unwrap_or_default().max(0) as u64;
        let extract_max_bytes = resolve_in_memory_sync_bundle_extract_max_bytes();
        if content_length > 0 && content_length <= extract_max_bytes {
            let bundle_bytes = response
                .body
                .collect()
                .await
                .map_err(|error| format!("Failed to read sync bundle {bundle_key}: {error}"))?
                .into_bytes()
                .to_vec();
            let root_dir = root_dir.to_path_buf();
            tokio::task::spawn_blocking(move || {
                unpack_sync_bundle_bytes_blocking(root_dir, bundle_bytes)
            })
            .await
            .map_err(|error| format!("Sync bundle extraction worker task failed: {error}"))??;
            return Ok(true);
        }

        let mut body = response.body.into_async_read();
        let mut bundle_file = tokio::fs::OpenOptions::new()
            .write(true)
            .truncate(true)
            .open(bundle_path.as_ref() as &Path)
            .await
            .map_err(|error| {
                format!(
                    "Failed to open temporary sync bundle file {}: {error}",
                    bundle_path.display()
                )
            })?;
        tokio::io::copy(&mut body, &mut bundle_file)
            .await
            .map_err(|error| format!("Failed to read sync bundle {}: {error}", bundle_key))?;
        bundle_file.flush().await.map_err(|error| {
            format!(
                "Failed to flush temporary sync bundle file {}: {error}",
                bundle_path.display()
            )
        })?;
        drop(bundle_file);

        let root_dir = root_dir.to_path_buf();
        let bundle_path_buf = bundle_path.to_path_buf();
        tokio::task::spawn_blocking(move || unpack_sync_bundle_blocking(root_dir, bundle_path_buf))
            .await
            .map_err(|error| format!("Sync bundle extraction worker task failed: {error}"))??;
        Ok(true)
    }
    .await;

    match hydrated {
        Ok(found) => Ok(found),
        Err(_) => {
            let _ = tokio::fs::remove_dir_all(root_dir).await;
            let _ = tokio::fs::create_dir_all(root_dir).await;
            Ok(false)
        }
    }
}

async fn upload_local_file(
    client: &S3Client,
    config: &NativeObjectStoreConfig,
    key: &str,
    absolute_path: &str,
    size: u64,
    inline_upload_threshold_bytes: u64,
    mtime_ms: u128,
    request_counter: &NativeObjectStoreRequestCounter,
) -> Result<bool, String> {
    let body = if size <= inline_upload_threshold_bytes {
        match tokio::fs::read(absolute_path).await {
            Ok(bytes) => ByteStream::from(bytes),
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
            Err(error) => {
                return Err(format!(
                    "Failed to read local file {absolute_path} for upload: {error}"
                ))
            }
        }
    } else {
        match tokio::fs::try_exists(absolute_path).await {
            Ok(true) => {}
            Ok(false) => return Ok(false),
            Err(error) => {
                return Err(format!(
                    "Failed to stat local file {absolute_path} before upload: {error}"
                ))
            }
        }

        match ByteStream::from_path(PathBuf::from(absolute_path)).await {
            Ok(body) => body,
            Err(error) => {
                return Err(format!(
                    "Failed to stream local file {absolute_path} for upload: {error}"
                ))
            }
        }
    };

    request_counter.increment_put();
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
    request_counter: &NativeObjectStoreRequestCounter,
) -> Result<u128, String> {
    request_counter.increment_get();
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
    let sync_bundle_config = resolve_sync_bundle_config(request.sync_bundle.as_ref());
    let root_dir = PathBuf::from(&request.root_dir);
    let snapshot = collect_snapshot(&root_dir, &excludes)?;

    let client = create_s3_client(&request.object_store);
    let request_counts = Arc::new(NativeObjectStoreRequestCounter::default());
    if request.remote_entries.is_none() && sync_bundle_config.mode != SyncBundleMode::Off {
        let bundle_key =
            build_remote_path(&request.remote_prefix, INTERNAL_SYNC_BUNDLE_RELATIVE_PATH);
        if maybe_hydrate_from_remote_sync_bundle(
            &client,
            &request.object_store,
            &root_dir,
            &bundle_key,
            true,
            request_counts.as_ref(),
        )
        .await?
        {
            let hydrated_snapshot = collect_snapshot(&root_dir, &excludes)?;
            return Ok(SyncRemoteToLocalResponse {
                ok: true,
                protocol_version: PROTOCOL_VERSION,
                local_fingerprint: create_fingerprint(&hydrated_snapshot),
                removed_path_count: 0,
                created_directory_count: 0,
                downloaded_file_count: hydrated_snapshot.files.len(),
                request_counts: request_counts.snapshot(),
            });
        }
    }

    if request.remote_entries.is_none() && sync_bundle_config.layout == SyncBundleLayout::Primary {
        if let Some(manifest_document) = load_remote_sync_manifest_document(
            &client,
            &request.object_store,
            &request.remote_prefix,
            request_counts.as_ref(),
        )
        .await?
        {
            if is_primary_bundle_manifest(&manifest_document) {
                let remote_entries = create_remote_entries_from_manifest_document(
                    &manifest_document,
                    &request.remote_prefix,
                    &excludes,
                );
                let plan = create_remote_to_local_plan(
                    &root_dir,
                    &snapshot,
                    remote_entries.clone(),
                    preserve_top_level_names.clone(),
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

                let bundle_key =
                    build_remote_path(&request.remote_prefix, INTERNAL_SYNC_BUNDLE_RELATIVE_PATH);
                if maybe_hydrate_from_remote_sync_bundle(
                    &client,
                    &request.object_store,
                    &root_dir,
                    &bundle_key,
                    false,
                    request_counts.as_ref(),
                )
                .await?
                {
                    let manifest_files = manifest_document
                        .files
                        .iter()
                        .filter_map(|(relative_path, entry)| {
                            let normalized = normalize_relative_path(relative_path);
                            if normalized.is_empty()
                                || should_ignore_relative_path(&normalized)
                                || should_exclude_relative_path(&normalized, &excludes)
                            {
                                return None;
                            }
                            Some((normalized, entry.size, entry.mtime_ms))
                        })
                        .collect::<Vec<_>>();
                    let explicit_remote_directories = manifest_document
                        .empty_directories
                        .iter()
                        .map(|relative_path| normalize_relative_path(relative_path))
                        .filter(|relative_path| {
                            !relative_path.is_empty()
                                && !should_ignore_relative_path(relative_path)
                                && !should_exclude_relative_path(relative_path, &excludes)
                        })
                        .collect::<BTreeSet<_>>();
                    let remote_file_paths = manifest_files
                        .iter()
                        .map(|(relative_path, _, _)| relative_path.clone())
                        .collect::<BTreeSet<_>>();

                    return Ok(SyncRemoteToLocalResponse {
                        ok: true,
                        protocol_version: PROTOCOL_VERSION,
                        local_fingerprint: create_fingerprint_from_entries(
                            &manifest_files,
                            &resolve_empty_remote_directories(
                                &explicit_remote_directories,
                                &remote_file_paths,
                            ),
                        ),
                        removed_path_count,
                        created_directory_count,
                        downloaded_file_count: manifest_files.len(),
                        request_counts: request_counts.snapshot(),
                    });
                }
            }
        }
    }

    let (remote_entries, has_sync_manifest, bundle_entry) = match request.remote_entries {
        Some(prefetched_remote_entries) => (
            prefetched_remote_entries,
            request.has_sync_manifest.unwrap_or(false),
            request.bundle_entry,
        ),
        None => {
            let remote_listing = list_remote_entries(
                &client,
                &request.object_store,
                &request.remote_prefix,
                request_counts.as_ref(),
            )
            .await?;
            (
                remote_listing.entries,
                remote_listing.has_sync_manifest,
                remote_listing.bundle_entry,
            )
        }
    };

    if let Some(bundle_entry) = bundle_entry.as_ref() {
        if should_attempt_sync_bundle_for_remote_entries(&remote_entries, sync_bundle_config)
            && maybe_hydrate_from_remote_sync_bundle(
                &client,
                &request.object_store,
                &root_dir,
                &bundle_entry.key,
                true,
                request_counts.as_ref(),
            )
            .await?
        {
            let hydrated_snapshot = collect_snapshot(&root_dir, &excludes)?;
            return Ok(SyncRemoteToLocalResponse {
                ok: true,
                protocol_version: PROTOCOL_VERSION,
                local_fingerprint: create_fingerprint(&hydrated_snapshot),
                removed_path_count: 0,
                created_directory_count: 0,
                downloaded_file_count: count_remote_file_entries(&remote_entries),
                request_counts: request_counts.snapshot(),
            });
        }
    }

    let sync_manifest = Arc::new(
        load_remote_sync_manifest(
            &client,
            &request.object_store,
            &request.remote_prefix,
            has_sync_manifest,
            request_counts.as_ref(),
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
    let request_counts_for_downloads = Arc::clone(&request_counts);
    let downloaded_candidates = process_with_concurrency(
        plan.download_candidates.clone(),
        max_concurrency,
        move |candidate| {
            let client = client_for_downloads.clone();
            let object_store = object_store_for_downloads.clone();
            let request_counts = Arc::clone(&request_counts_for_downloads);
            async move {
                let target_path = PathBuf::from(&candidate.target_path);
                prepare_local_file_target(&target_path).await?;
                let mtime_ms = download_remote_file(
                    &client,
                    &object_store,
                    &candidate.remote_key,
                    &target_path,
                    request_counts.as_ref(),
                )
                .await?;
                Ok((candidate.relative_path, candidate.size, mtime_ms, true))
            }
        },
    )
    .await?;

    let client_for_info_checks = client.clone();
    let object_store_for_info_checks = request.object_store.clone();
    let sync_manifest_for_info_checks = Arc::clone(&sync_manifest);
    let request_counts_for_info_checks = Arc::clone(&request_counts);
    let info_checked_candidates = process_with_concurrency(
        plan.info_check_candidates.clone(),
        max_concurrency,
        move |candidate| {
            let client = client_for_info_checks.clone();
            let object_store = object_store_for_info_checks.clone();
            let sync_manifest = Arc::clone(&sync_manifest_for_info_checks);
            let request_counts = Arc::clone(&request_counts_for_info_checks);
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

                        request_counts.increment_head();
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

                let mtime_ms = download_remote_file(
                    &client,
                    &object_store,
                    &candidate.remote_key,
                    &target_path,
                    request_counts.as_ref(),
                )
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
            .map(|(relative_path, size, mtime_ms, _downloaded)| (relative_path, size, mtime_ms))
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
        request_counts: request_counts.snapshot(),
    })
}

async fn sync_local_to_remote(
    request: SyncLocalToRemoteRequest,
) -> Result<SyncLocalToRemoteResponse, String> {
    use std::collections::BTreeMap;

    let command_started_at = Instant::now();
    let excludes = normalize_exclude_paths(request.exclude_relative_paths);
    let max_concurrency = resolve_max_concurrency(request.max_concurrency);
    let inline_upload_threshold_bytes =
        resolve_inline_upload_threshold_bytes(request.inline_upload_threshold_bytes);
    let sync_bundle_config = resolve_sync_bundle_config(request.sync_bundle.as_ref());
    let root_dir = PathBuf::from(&request.root_dir);
    let scan_started_at = Instant::now();
    let snapshot = collect_snapshot(&root_dir, &excludes)?;
    let mut phase_timings = SyncLocalToRemotePhaseTimings {
        scan_ms: elapsed_millis_u64(scan_started_at),
        fingerprint_ms: 0,
        client_create_ms: 0,
        manifest_read_ms: 0,
        bundle_build_ms: 0,
        bundle_body_prepare_ms: 0,
        bundle_upload_ms: 0,
        bundle_transport: "none".to_string(),
        bundle_bytes: 0,
        manifest_write_ms: 0,
        delete_ms: 0,
        total_primary_path_ms: 0,
        total_command_ms: 0,
    };
    let fingerprint_started_at = Instant::now();
    let local_fingerprint = create_fingerprint(&snapshot);
    phase_timings.fingerprint_ms = elapsed_millis_u64(fingerprint_started_at);

    let client_create_started_at = Instant::now();
    let client = create_s3_client(&request.object_store);
    phase_timings.client_create_ms = elapsed_millis_u64(client_create_started_at);
    let request_counts = Arc::new(NativeObjectStoreRequestCounter::default());
    let snapshot_manifest_files = snapshot
        .files
        .iter()
        .map(|file| (file.relative_path.clone(), file.size, file.mtime_ms))
        .collect::<Vec<_>>();

    if sync_bundle_config.layout == SyncBundleLayout::Primary
        && should_attempt_sync_bundle_for_snapshot(&snapshot, sync_bundle_config)
    {
        let primary_path_started_at = Instant::now();
        let assume_empty_trusted_prefix =
            should_assume_empty_trusted_managed_prefix(&request.remote_prefix, sync_bundle_config);
        let existing_manifest_document = if assume_empty_trusted_prefix {
            None
        } else {
            let manifest_read_started_at = Instant::now();
            let document = load_remote_sync_manifest_document(
                &client,
                &request.object_store,
                &request.remote_prefix,
                request_counts.as_ref(),
            )
            .await?;
            phase_timings.manifest_read_ms = elapsed_millis_u64(manifest_read_started_at);
            document
        };
        let uploaded_file_count =
            count_snapshot_file_mutations(&snapshot, existing_manifest_document.as_ref());
        let deleted_remote_count =
            count_snapshot_deleted_files(&snapshot, existing_manifest_document.as_ref());
        let created_empty_directory_count = count_snapshot_created_empty_directories(
            &snapshot,
            existing_manifest_document.as_ref(),
        );
        let has_mutations = uploaded_file_count > 0
            || deleted_remote_count > 0
            || created_empty_directory_count > 0
            || !existing_manifest_document
                .as_ref()
                .map(is_primary_bundle_manifest)
                .unwrap_or(false);

        if has_mutations {
            let upload_result = upload_sync_bundle(
                &client,
                &request.object_store,
                &request.remote_prefix,
                &root_dir,
                &snapshot,
                &excludes,
                request_counts.as_ref(),
            )
            .await?;
            phase_timings.bundle_build_ms = upload_result.bundle_build_ms;
            phase_timings.bundle_body_prepare_ms = upload_result.bundle_body_prepare_ms;
            phase_timings.bundle_upload_ms = upload_result.bundle_upload_ms;
            phase_timings.bundle_transport = upload_result.bundle_transport.to_string();
            phase_timings.bundle_bytes = upload_result.bundle_bytes;

            let snapshot_file_paths = snapshot
                .files
                .iter()
                .map(|file| file.relative_path.as_str())
                .collect::<BTreeSet<_>>();
            let snapshot_empty_directories = snapshot
                .empty_directories
                .iter()
                .map(|relative_path| relative_path.as_str())
                .collect::<BTreeSet<_>>();

            let mut keys_to_delete =
                existing_manifest_document
                    .as_ref()
                    .map(|document| {
                        let remove_all_tracked_entries = !is_primary_bundle_manifest(document);
                        let mut keys = document
                            .files
                            .keys()
                            .filter(|relative_path| {
                                remove_all_tracked_entries
                                    || !snapshot_file_paths.contains(relative_path.as_str())
                            })
                            .map(|relative_path| {
                                build_remote_path(&request.remote_prefix, relative_path)
                            })
                            .collect::<Vec<_>>();
                        keys.extend(document.empty_directories.iter().filter_map(
                            |relative_path| {
                                let normalized = normalize_relative_path(relative_path);
                                if normalized.is_empty()
                                    || (!remove_all_tracked_entries
                                        && snapshot_empty_directories.contains(normalized.as_str()))
                                {
                                    return None;
                                }
                                Some(format!(
                                    "{}/",
                                    build_remote_path(&request.remote_prefix, &normalized)
                                ))
                            },
                        ));
                        keys
                    })
                    .unwrap_or_default();
            keys_to_delete.sort();
            keys_to_delete.dedup();

            if !keys_to_delete.is_empty() {
                let delete_started_at = Instant::now();
                for chunk in keys_to_delete.chunks(1000) {
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
                                            format!(
                                                "Failed to prepare S3 delete object identifier: {error}"
                                            )
                                        })
                                })
                                .collect::<Result<Vec<_>, _>>()?,
                        ))
                        .build()
                        .map_err(|error| {
                            format!("Failed to prepare S3 delete request: {error}")
                        })?;

                    request_counts.increment_delete();
                    client
                        .delete_objects()
                        .bucket(&request.object_store.bucket)
                        .delete(delete)
                        .send()
                        .await
                        .map_err(|error| format!("Failed to delete S3 objects: {error}"))?;
                }
                phase_timings.delete_ms = elapsed_millis_u64(delete_started_at);
            }

            let manifest_write_started_at = Instant::now();
            write_remote_sync_manifest(
                &client,
                &request.object_store,
                &request.remote_prefix,
                &snapshot_manifest_files,
                &snapshot
                    .empty_directories
                    .iter()
                    .cloned()
                    .collect::<Vec<_>>(),
                Some("bundle"),
                existing_manifest_document.as_ref(),
                request_counts.as_ref(),
            )
            .await?;
            phase_timings.manifest_write_ms = elapsed_millis_u64(manifest_write_started_at);
        }

        mark_trusted_managed_prefix_seen(&request.remote_prefix);
        phase_timings.total_primary_path_ms = elapsed_millis_u64(primary_path_started_at);
        phase_timings.total_command_ms = elapsed_millis_u64(command_started_at);

        return Ok(SyncLocalToRemoteResponse {
            ok: true,
            protocol_version: PROTOCOL_VERSION,
            local_fingerprint,
            uploaded_file_count,
            deleted_remote_count,
            created_empty_directory_count,
            request_counts: request_counts.snapshot(),
            phase_timings: Some(phase_timings),
        });
    }

    let remote_listing = list_remote_entries(
        &client,
        &request.object_store,
        &request.remote_prefix,
        request_counts.as_ref(),
    )
    .await?;
    let remote_entries = remote_listing.entries;
    let bundle_entry = remote_listing.bundle_entry;
    let existing_manifest_document = if remote_listing.has_sync_manifest {
        load_remote_sync_manifest_document(
            &client,
            &request.object_store,
            &request.remote_prefix,
            request_counts.as_ref(),
        )
        .await?
    } else {
        None
    };
    let sync_manifest = Arc::new(
        existing_manifest_document
            .as_ref()
            .map(|document| {
                document
                    .files
                    .iter()
                    .filter_map(|(relative_path, entry)| {
                        let normalized = normalize_relative_path(relative_path);
                        if normalized.is_empty() || should_ignore_relative_path(&normalized) {
                            return None;
                        }
                        Some((normalized, entry.clone()))
                    })
                    .collect::<BTreeMap<_, _>>()
            })
            .unwrap_or_default(),
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
    let request_counts_for_uploads = Arc::clone(&request_counts);
    let inline_upload_threshold_bytes_for_uploads = inline_upload_threshold_bytes;
    let uploaded_candidates = process_with_concurrency(
        plan.upload_candidates.clone(),
        max_concurrency,
        move |candidate| {
            let client = client_for_uploads.clone();
            let object_store = object_store_for_uploads.clone();
            let remote_prefix = remote_prefix_for_uploads.clone();
            let request_counts = Arc::clone(&request_counts_for_uploads);
            let inline_upload_threshold_bytes = inline_upload_threshold_bytes_for_uploads;
            async move {
                let key = build_remote_path(&remote_prefix, &candidate.relative_path);
                upload_local_file(
                    &client,
                    &object_store,
                    &key,
                    &candidate.absolute_path,
                    candidate.size,
                    inline_upload_threshold_bytes,
                    candidate.mtime_ms,
                    request_counts.as_ref(),
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
    let request_counts_for_info_checks = Arc::clone(&request_counts);
    let inline_upload_threshold_bytes_for_info_checks = inline_upload_threshold_bytes;
    let info_checked_candidates = process_with_concurrency(
        plan.info_check_candidates.clone(),
        max_concurrency,
        move |candidate| {
            let client = client_for_info_checks.clone();
            let object_store = object_store_for_info_checks.clone();
            let remote_prefix = remote_prefix_for_info_checks.clone();
            let remote_entries = Arc::clone(&remote_entries_for_info_checks);
            let sync_manifest = Arc::clone(&sync_manifest_for_info_checks);
            let request_counts = Arc::clone(&request_counts_for_info_checks);
            let inline_upload_threshold_bytes = inline_upload_threshold_bytes_for_info_checks;
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

                        request_counts.increment_head();
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
                    candidate.size,
                    inline_upload_threshold_bytes,
                    candidate.mtime_ms,
                    request_counts.as_ref(),
                )
                .await
            }
        },
    )
    .await?;

    let deleted_remote_count = plan.keys_to_delete.len();
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
    let request_counts_for_empty_directories = Arc::clone(&request_counts);
    let created_empty_directory_count = process_with_concurrency(
        plan.empty_directories_to_create.clone(),
        max_concurrency,
        move |relative_path| {
            let client = client_for_empty_directories.clone();
            let object_store = object_store_for_empty_directories.clone();
            let remote_prefix = remote_prefix_for_empty_directories.clone();
            let request_counts = Arc::clone(&request_counts_for_empty_directories);
            async move {
                let key = format!("{}/", build_remote_path(&remote_prefix, &relative_path));
                request_counts.increment_put();
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

    let has_mutations =
        uploaded_file_count > 0 || deleted_remote_count > 0 || created_empty_directory_count > 0;

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

        request_counts.increment_delete();
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
        &snapshot_manifest_files,
        &snapshot
            .empty_directories
            .iter()
            .cloned()
            .collect::<Vec<_>>(),
        Some("objects"),
        existing_manifest_document.as_ref(),
        request_counts.as_ref(),
    )
    .await?;

    if has_mutations {
        if should_attempt_sync_bundle_for_snapshot(&snapshot, sync_bundle_config) {
            upload_sync_bundle(
                &client,
                &request.object_store,
                &request.remote_prefix,
                &root_dir,
                &snapshot,
                &excludes,
                request_counts.as_ref(),
            )
            .await?;
        } else if let Some(bundle_entry) = bundle_entry {
            delete_remote_object_if_present(
                &client,
                &request.object_store,
                &bundle_entry.key,
                request_counts.as_ref(),
            )
            .await?;
        }
    }

    prune_empty_local_directories(&root_dir).await?;
    phase_timings.total_command_ms = elapsed_millis_u64(command_started_at);
    Ok(SyncLocalToRemoteResponse {
        ok: true,
        protocol_version: PROTOCOL_VERSION,
        local_fingerprint,
        uploaded_file_count,
        deleted_remote_count,
        created_empty_directory_count,
        request_counts: request_counts.snapshot(),
        phase_timings: Some(phase_timings),
    })
}

fn elapsed_millis_u64(started_at: Instant) -> u64 {
    started_at.elapsed().as_millis().min(u128::from(u64::MAX)) as u64
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
    let root_directory_exists =
        if let Some(existing_root) = sandbox_client.stat_path(&root_path).await? {
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
    let created_directory_count =
        process_with_concurrency(directories_to_create, max_concurrency, move |remote_path| {
            let sandbox_client = sandbox_client_for_directories.clone();
            async move {
                sandbox_client.create_directory(&remote_path).await?;
                Ok(true)
            }
        })
        .await?
        .len()
            + if root_directory_exists { 0 } else { 1 };

    let sandbox_client_for_uploads = sandbox_client.clone();
    let remote_file_stats = Arc::new(remote_state.existing_file_stats);
    let uploaded_file_count =
        process_with_concurrency(plan.files.clone(), max_concurrency, move |file| {
            let sandbox_client = sandbox_client_for_uploads.clone();
            let remote_file_stats = Arc::clone(&remote_file_stats);
            async move {
                if let Some(remote_stat) = remote_file_stats.get(&file.remote_path) {
                    if sandbox_file_matches(file.size, file.mtime_ms, remote_stat) {
                        return Ok(false);
                    }
                }
                let data = tokio::fs::read(&file.absolute_path)
                    .await
                    .map_err(|error| {
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
        })
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
                    mode: 0o644,
                },
                FileEntry {
                    relative_path: "orphan.txt".to_string(),
                    absolute_path: "/workspace/orphan.txt".to_string(),
                    size: 4,
                    mtime_ms: 2000,
                    mode: 0o644,
                },
                FileEntry {
                    relative_path: "keep/child.txt".to_string(),
                    absolute_path: "/workspace/keep/child.txt".to_string(),
                    size: 6,
                    mtime_ms: 3000,
                    mode: 0o644,
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
    fn build_seed_archive_writes_tar_and_ignores_runtime_junk() {
        let temp = tempfile::tempdir().expect("tempdir");
        let root = temp.path().join("workspace");
        fs::create_dir_all(root.join("src")).expect("src");
        fs::create_dir_all(root.join("empty")).expect("empty");
        fs::create_dir_all(root.join("__pycache__")).expect("pycache");
        fs::write(root.join("src").join("main.txt"), "hello").expect("main");
        fs::write(root.join(".DS_Store"), "junk").expect("ds store");
        fs::write(root.join("__pycache__").join("main.pyc"), "junk").expect("pyc");

        let archive_path = temp.path().join("workspace-seed.tar");
        let response = build_seed_archive(BuildSeedArchiveRequest {
            root_dir: normalize_path(&root),
            archive_path: normalize_path(&archive_path),
        })
        .expect("build seed archive");

        assert_eq!(response.file_count, 1);
        assert_eq!(response.empty_directory_count, 1);
        assert!(response.archive_bytes > 0);

        let archive_file = fs::File::open(&archive_path).expect("archive");
        let mut archive = tar::Archive::new(archive_file);
        let names = archive
            .entries()
            .expect("entries")
            .map(|entry| {
                entry
                    .expect("entry")
                    .path()
                    .expect("path")
                    .to_string_lossy()
                    .to_string()
            })
            .collect::<Vec<_>>();
        let normalized_names = names
            .iter()
            .map(|name| name.trim_end_matches('/').to_string())
            .collect::<Vec<_>>();

        assert!(normalized_names.contains(&"src/main.txt".to_string()));
        assert!(normalized_names.contains(&"empty".to_string()));
        assert!(!names.iter().any(|name| name.contains(".DS_Store")));
        assert!(!names.iter().any(|name| name.contains("__pycache__")));
    }

    #[test]
    fn sync_bundle_from_snapshot_uses_filtered_entries() {
        let temp = tempfile::tempdir().expect("tempdir");
        let root = temp.path().join("workspace");
        fs::create_dir_all(root.join("src")).expect("src");
        fs::create_dir_all(root.join("empty")).expect("empty");
        fs::create_dir_all(root.join("__pycache__")).expect("pycache");
        fs::write(root.join("src").join("main.txt"), "hello").expect("main");
        fs::write(root.join(".DS_Store"), "junk").expect("ds store");
        fs::write(root.join("__pycache__").join("main.pyc"), "junk").expect("pyc");

        let snapshot = collect_snapshot(&root, &[]).expect("snapshot");
        let mut files = snapshot.files.clone();
        files.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
        let empty_directories = snapshot
            .empty_directories
            .iter()
            .cloned()
            .collect::<Vec<_>>();
        let bundle_bytes =
            build_local_sync_bundle_to_memory_blocking(&files, &empty_directories).expect("bundle");

        let mut archive = tar::Archive::new(Cursor::new(bundle_bytes));
        let names = archive
            .entries()
            .expect("entries")
            .map(|entry| {
                entry
                    .expect("entry")
                    .path()
                    .expect("path")
                    .to_string_lossy()
                    .to_string()
            })
            .collect::<Vec<_>>();
        let normalized_names = names
            .iter()
            .map(|name| name.trim_end_matches('/').to_string())
            .collect::<Vec<_>>();

        assert!(normalized_names.contains(&"src/main.txt".to_string()));
        assert!(normalized_names.contains(&"empty".to_string()));
        assert!(!names.iter().any(|name| name.contains(".DS_Store")));
        assert!(!names.iter().any(|name| name.contains("__pycache__")));
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
    fn ignore_internal_sync_sidecars() {
        assert!(should_ignore_relative_path(".oah-sync-manifest.json"));
        assert!(should_ignore_relative_path(".oah-sync-bundle.tar"));
        assert!(!should_ignore_relative_path("README.md"));
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
                sent_at_ms: None,
            },
            &mut runtime,
        );

        assert_eq!(response.get("ok").and_then(Value::as_bool), Some(true));
        assert_eq!(
            response.get("requestId").and_then(Value::as_str),
            Some("req_1")
        );
        assert_eq!(
            response.get("name").and_then(Value::as_str),
            Some(BINARY_NAME)
        );
    }

    #[test]
    fn worker_request_reports_unknown_command_error() {
        let mut runtime = None;
        let response = handle_worker_request(
            WorkerRequest {
                request_id: "req_2".to_string(),
                command: "unknown".to_string(),
                payload: None,
                sent_at_ms: None,
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
