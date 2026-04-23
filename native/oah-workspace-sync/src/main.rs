use std::collections::BTreeSet;
use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::UNIX_EPOCH;

use clap::{Parser, Subcommand};
use serde::Deserialize;
use serde::Serialize;
use sha1::{Digest, Sha1};

const PROTOCOL_VERSION: u32 = 1;
const BINARY_NAME: &str = "oah-workspace-sync";
const BINARY_VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Parser)]
#[command(name = BINARY_NAME, version = BINARY_VERSION, about = "Open Agent Harness native workspace sync utilities.")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    Version,
    Fingerprint,
    ScanLocalTree,
    PlanLocalToRemote,
    PlanRemoteToLocal,
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
struct ErrorResponse {
    ok: bool,
    protocol_version: u32,
    code: &'static str,
    message: String,
}

#[derive(Default)]
struct Snapshot {
    files: Vec<FileEntry>,
    directories: BTreeSet<String>,
    empty_directories: BTreeSet<String>,
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
    remote_entries: Vec<PlanRemoteEntry>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlanRemoteEntry {
    relative_path: String,
    key: String,
    size: u64,
    last_modified_ms: Option<u128>,
    is_directory: bool,
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
struct PlanUploadCandidate {
    relative_path: String,
    absolute_path: String,
    size: u64,
    mtime_ms: u128,
    remote_key: String,
}

#[derive(Serialize)]
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
    directories_to_create: Vec<String>,
    download_candidates: Vec<PlanDownloadCandidate>,
    info_check_candidates: Vec<PlanDownloadCandidate>,
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
        Command::Version => write_json(&VersionResponse {
            ok: true,
            protocol_version: PROTOCOL_VERSION,
            name: BINARY_NAME,
            version: BINARY_VERSION,
        }),
        Command::Fingerprint => {
            let request: FingerprintRequest = read_json_stdin()?;
            let excludes = normalize_exclude_paths(request.exclude_relative_paths);
            let snapshot = collect_snapshot(&PathBuf::from(request.root_dir), &excludes)?;
            let fingerprint = create_fingerprint(&snapshot);
            write_json(&FingerprintResponse {
                ok: true,
                protocol_version: PROTOCOL_VERSION,
                fingerprint,
                file_count: snapshot.files.len(),
                empty_directory_count: snapshot.empty_directories.len(),
            })
        }
        Command::ScanLocalTree => {
            let request: FingerprintRequest = read_json_stdin()?;
            let excludes = normalize_exclude_paths(request.exclude_relative_paths);
            let snapshot = collect_snapshot(&PathBuf::from(request.root_dir), &excludes)?;
            let fingerprint = create_fingerprint(&snapshot);
            write_json(&ScanLocalTreeResponse {
                ok: true,
                protocol_version: PROTOCOL_VERSION,
                fingerprint,
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
        Command::PlanLocalToRemote => {
            let request: PlanLocalToRemoteRequest = read_json_stdin()?;
            let excludes = normalize_exclude_paths(request.exclude_relative_paths);
            let snapshot = collect_snapshot(&PathBuf::from(request.root_dir), &excludes)?;
            let fingerprint = create_fingerprint(&snapshot);
            let plan = create_local_to_remote_plan(&snapshot, request.remote_entries);
            write_json(&PlanLocalToRemoteResponse {
                ok: true,
                protocol_version: PROTOCOL_VERSION,
                fingerprint,
                upload_candidates: plan.upload_candidates,
                info_check_candidates: plan.info_check_candidates,
                empty_directories_to_create: plan.empty_directories_to_create,
                keys_to_delete: plan.keys_to_delete,
            })
        }
        Command::PlanRemoteToLocal => {
            let request: PlanLocalToRemoteRequest = read_json_stdin()?;
            let excludes = normalize_exclude_paths(request.exclude_relative_paths);
            let root_dir = PathBuf::from(&request.root_dir);
            let snapshot = collect_snapshot(&root_dir, &excludes)?;
            let plan = create_remote_to_local_plan(&root_dir, &snapshot, request.remote_entries);
            write_json(&PlanRemoteToLocalResponse {
                ok: true,
                protocol_version: PROTOCOL_VERSION,
                directories_to_create: plan.directories_to_create,
                download_candidates: plan.download_candidates,
                info_check_candidates: plan.info_check_candidates,
            })
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
    directories_to_create: Vec<String>,
    download_candidates: Vec<PlanDownloadCandidate>,
    info_check_candidates: Vec<PlanDownloadCandidate>,
}

fn read_json_stdin<T: for<'de> Deserialize<'de>>() -> Result<T, String> {
    let mut input = String::new();
    io::stdin()
        .read_to_string(&mut input)
        .map_err(|error| format!("Failed to read stdin: {error}"))?;
    serde_json::from_str::<T>(&input).map_err(|error| format!("Failed to decode stdin JSON: {error}"))
}

fn write_json<T: Serialize>(payload: &T) -> Result<(), String> {
    let rendered =
        serde_json::to_string(payload).map_err(|error| format!("Failed to serialize JSON response: {error}"))?;
    println!("{rendered}");
    Ok(())
}

fn normalize_path(value: &Path) -> String {
    value.to_string_lossy().replace('\\', "/")
}

fn normalize_relative_path(value: &str) -> String {
    value
        .replace('\\', "/")
        .trim_matches('/')
        .to_string()
}

fn normalize_exclude_paths(paths: Vec<String>) -> Vec<String> {
    paths.into_iter()
        .map(|path| normalize_relative_path(&path))
        .filter(|path| !path.is_empty())
        .collect()
}

fn should_ignore_relative_path(relative_path: &str) -> bool {
    if relative_path.is_empty() {
        return false;
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

fn walk_directory(directory: &Path, root_dir: &Path, excludes: &[String], snapshot: &mut Snapshot) -> Result<(), String> {
    let mut entries = match fs::read_dir(directory) {
        Ok(entries) => entries
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("Failed to read directory {}: {error}", directory.display()))?,
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
            suppressed_children = true;
            continue;
        }

        if should_exclude_relative_path(&relative_path, excludes) {
            suppressed_children = true;
            continue;
        }

        let file_type = entry
            .file_type()
            .map_err(|error| format!("Failed to read file type for {}: {error}", absolute_path.display()))?;

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
                file.relative_path,
                file.size,
                file.mtime_ms
            )
            .as_bytes(),
        );
    }

    for relative_directory in &snapshot.empty_directories {
        hash.update(format!("dir:{relative_directory}\n").as_bytes());
    }

    format!("{:x}", hash.finalize())
}

fn create_local_to_remote_plan(snapshot: &Snapshot, remote_entries: Vec<PlanRemoteEntry>) -> LocalToRemotePlan {
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

fn create_remote_to_local_plan(root_dir: &Path, snapshot: &Snapshot, remote_entries: Vec<PlanRemoteEntry>) -> RemoteToLocalPlan {
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

    let mut directories_to_create = remote_directories.into_iter().collect::<Vec<_>>();
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

    remote_files.sort_by(|left, right| left.0.cmp(&right.0));
    for (relative_path, entry) in remote_files {
        let target_path = normalize_path(&root_dir.join(&relative_path));
        let candidate = PlanDownloadCandidate {
            relative_path: relative_path.clone(),
            target_path,
            size: entry.size,
            remote_key: entry.key,
        };

        match local_files_by_relative_path.get(&relative_path) {
            None => download_candidates.push(candidate),
            Some(local_file) if local_file.size != entry.size => download_candidates.push(candidate),
            Some(_) => info_check_candidates.push(candidate),
        }
    }

    RemoteToLocalPlan {
        directories_to_create,
        download_candidates,
        info_check_candidates,
    }
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
