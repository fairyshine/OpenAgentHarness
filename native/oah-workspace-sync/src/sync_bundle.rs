use std::collections::HashSet;
use std::env;
use std::fs;
use std::io::{self, Cursor, Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command as ProcessCommand;
use std::time::Instant;

use filetime::{set_file_handle_times, FileTime};

use crate::path_rules::{
    normalize_relative_path, INTERNAL_SYNC_BUNDLE_RELATIVE_PATH,
    INTERNAL_SYNC_MANIFEST_RELATIVE_PATH,
};
use crate::snapshot::{FileEntry, Snapshot};

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
const RUST_SYNC_BUNDLE_EXTRACTOR_ENV: &str = "OAH_NATIVE_WORKSPACE_SYNC_RUST_BUNDLE_EXTRACTOR";

pub(super) enum BuiltSyncBundle {
    TempPath(tempfile::TempPath),
    Bytes(Vec<u8>),
}

#[derive(Clone, Copy)]
struct InMemorySyncBundleSourceByteRange {
    min: u64,
    max: u64,
}

#[derive(Clone, Default)]
pub(super) struct SyncBundleExtractTimings {
    pub(super) mkdir_us: u64,
    pub(super) replace_us: u64,
    pub(super) file_create_us: u64,
    pub(super) file_write_us: u64,
    pub(super) file_mtime_us: u64,
    pub(super) chmod_us: u64,
    pub(super) target_check_us: u64,
    pub(super) file_count: u64,
    pub(super) directory_count: u64,
}

pub(super) struct SyncBundleExtractOutcome {
    pub(super) extractor: &'static str,
    pub(super) timings: SyncBundleExtractTimings,
}

pub(super) fn write_snapshot_tar_archive<W: Write>(
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

pub(super) fn build_local_sync_bundle_to_memory_blocking(
    file_entries: &[FileEntry],
    empty_directories: &[String],
) -> Result<Vec<u8>, String> {
    write_snapshot_ustar_archive(Vec::new(), file_entries, empty_directories)
        .map_err(|error| format!("Failed to build in-memory sync bundle archive: {error}"))
}

pub(super) fn collect_bundle_relative_paths(snapshot: &Snapshot) -> Vec<String> {
    let mut relative_paths = snapshot
        .files
        .iter()
        .map(|file| file.relative_path.clone())
        .chain(snapshot.empty_directories.iter().cloned())
        .collect::<Vec<_>>();
    relative_paths.sort();
    relative_paths
}

pub(super) async fn build_local_sync_bundle(
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
                let file_entries_sorted = snapshot.files_sorted_by_relative_path;
                let empty_directories = snapshot
                    .empty_directories
                    .iter()
                    .cloned()
                    .collect::<Vec<_>>();
                if let Ok(bundle_bytes) = tokio::task::spawn_blocking(move || {
                    let mut file_entries = file_entries;
                    if !file_entries_sorted {
                        file_entries
                            .sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
                    }
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
    let file_entries_input_sorted = snapshot.files_sorted_by_relative_path;
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
        if !file_entries_input_sorted {
            file_entries.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
        }

        build_local_sync_bundle_blocking(file_entries, empty_directory_relative_paths)
            .map(BuiltSyncBundle::TempPath)
    })
    .await
    .map_err(|error| format!("Sync bundle worker task failed: {error}"))?
}

pub(super) fn unpack_sync_bundle_blocking(
    root_dir: PathBuf,
    bundle_path: PathBuf,
) -> Result<(), String> {
    let bundle_file = fs::File::open(&bundle_path).map_err(|error| {
        format!(
            "Failed to open sync bundle archive {}: {error}",
            bundle_path.display()
        )
    })?;
    unpack_sync_bundle_reader_blocking(root_dir, bundle_file)
}

pub(super) fn unpack_sync_bundle_bytes_blocking(
    root_dir: PathBuf,
    bundle_bytes: Vec<u8>,
    skip_existing_target_checks: bool,
) -> Result<SyncBundleExtractOutcome, String> {
    if should_use_rust_sync_bundle_extractor() {
        if let Some(timings) = try_unpack_ustar_bundle_bytes_blocking(
            &root_dir,
            &bundle_bytes,
            skip_existing_target_checks,
        )? {
            return Ok(SyncBundleExtractOutcome {
                extractor: "rust-ustar",
                timings,
            });
        }
    }

    unpack_sync_bundle_reader_blocking(root_dir, Cursor::new(bundle_bytes))?;
    Ok(SyncBundleExtractOutcome {
        extractor: "tar",
        timings: SyncBundleExtractTimings::default(),
    })
}

pub(super) fn resolve_in_memory_sync_bundle_extract_max_bytes() -> u64 {
    read_u64_env(IN_MEMORY_SYNC_BUNDLE_EXTRACT_MAX_BYTES_ENV)
        .unwrap_or(DEFAULT_IN_MEMORY_SYNC_BUNDLE_EXTRACT_MAX_BYTES)
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

pub(super) fn run_tar_with_file_list_to_path(
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

fn should_use_rust_sync_bundle_extractor() -> bool {
    read_bool_env(RUST_SYNC_BUNDLE_EXTRACTOR_ENV).unwrap_or(true)
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

fn parse_tar_octal_field(field: &[u8]) -> Option<u64> {
    let text = field
        .iter()
        .copied()
        .take_while(|byte| *byte != 0)
        .filter(|byte| !byte.is_ascii_whitespace())
        .collect::<Vec<_>>();
    if text.is_empty() {
        return Some(0);
    }

    std::str::from_utf8(&text)
        .ok()
        .and_then(|value| u64::from_str_radix(value, 8).ok())
}

fn tar_header_name(header: &[u8; TAR_BLOCK_SIZE]) -> Option<String> {
    let name_end = header[0..100]
        .iter()
        .position(|byte| *byte == 0)
        .unwrap_or(100);
    let name = std::str::from_utf8(&header[0..name_end]).ok()?;
    let prefix_end = header[345..500]
        .iter()
        .position(|byte| *byte == 0)
        .unwrap_or(155);
    let prefix = std::str::from_utf8(&header[345..345 + prefix_end]).ok()?;
    if prefix.is_empty() {
        Some(name.to_string())
    } else {
        Some(format!("{prefix}/{name}"))
    }
}

fn safe_bundle_relative_path(raw_path: &str) -> Option<PathBuf> {
    let normalized = normalize_relative_path(raw_path.trim_start_matches("./"));
    if normalized.is_empty() || normalized == "." {
        return None;
    }

    let mut relative_path = PathBuf::new();
    for segment in normalized.split('/') {
        if segment.is_empty() || segment == "." || segment == ".." {
            return None;
        }
        relative_path.push(segment);
    }
    Some(relative_path)
}

fn try_unpack_ustar_bundle_bytes_blocking(
    root_dir: &Path,
    bundle_bytes: &[u8],
    skip_existing_target_checks: bool,
) -> Result<Option<SyncBundleExtractTimings>, String> {
    if bundle_bytes.len() < TAR_BLOCK_SIZE * 2 || bundle_bytes.len() % TAR_BLOCK_SIZE != 0 {
        return Ok(None);
    }

    let mut timings = SyncBundleExtractTimings::default();
    let mkdir_started_at = Instant::now();
    fs::create_dir_all(root_dir).map_err(|error| {
        format!(
            "Failed to create local bundle root {}: {error}",
            root_dir.display()
        )
    })?;
    timings.mkdir_us += elapsed_micros_u64(mkdir_started_at);

    let mut offset = 0;
    let mut saw_entry = false;
    let mut created_directories = HashSet::new();
    created_directories.insert(root_dir.to_path_buf());
    while offset + TAR_BLOCK_SIZE <= bundle_bytes.len() {
        let header_slice = &bundle_bytes[offset..offset + TAR_BLOCK_SIZE];
        if header_slice.iter().all(|byte| *byte == 0) {
            return Ok(if saw_entry { Some(timings) } else { None });
        }

        let header: &[u8; TAR_BLOCK_SIZE] = header_slice
            .try_into()
            .map_err(|_| "Failed to read ustar header block.".to_string())?;
        if &header[257..263] != b"ustar\0" {
            return Ok(None);
        }

        let raw_path = tar_header_name(header).ok_or_else(|| {
            "Failed to decode ustar header path while extracting sync bundle.".to_string()
        })?;
        let Some(relative_path) = safe_bundle_relative_path(&raw_path) else {
            return Ok(None);
        };
        let size = parse_tar_octal_field(&header[124..136]).ok_or_else(|| {
            format!("Failed to parse ustar entry size for {raw_path} while extracting sync bundle.")
        })?;
        let mode = parse_tar_octal_field(&header[100..108]).unwrap_or(0o644) as u32;
        let mtime_seconds = parse_tar_octal_field(&header[136..148]).unwrap_or(0);
        let data_offset = offset + TAR_BLOCK_SIZE;
        let size_usize = usize::try_from(size).map_err(|_| {
            format!("Ustar entry {raw_path} is too large to extract on this platform.")
        })?;
        let data_end = data_offset.checked_add(size_usize).ok_or_else(|| {
            format!("Ustar entry {raw_path} overflowed while extracting sync bundle.")
        })?;
        if data_end > bundle_bytes.len() {
            return Ok(None);
        }

        let target_path = root_dir.join(&relative_path);
        match header[156] {
            b'0' | 0 => {
                if let Some(parent) = target_path.parent() {
                    let parent_path = parent.to_path_buf();
                    if created_directories.insert(parent_path.clone()) {
                        let mkdir_started_at = Instant::now();
                        fs::create_dir_all(&parent_path).map_err(|error| {
                            format!(
                                "Failed to create local bundle parent {}: {error}",
                                parent_path.display()
                            )
                        })?;
                        timings.mkdir_us += elapsed_micros_u64(mkdir_started_at);
                    }
                }
                if !skip_existing_target_checks {
                    let target_check_started_at = Instant::now();
                    let existing_directory =
                        matches!(fs::metadata(&target_path), Ok(metadata) if metadata.is_dir());
                    timings.target_check_us += elapsed_micros_u64(target_check_started_at);
                    if existing_directory {
                        let replace_started_at = Instant::now();
                        fs::remove_dir_all(&target_path).map_err(|error| {
                            format!(
                                "Failed to replace local bundle directory {}: {error}",
                                target_path.display()
                            )
                        })?;
                        timings.replace_us += elapsed_micros_u64(replace_started_at);
                    }
                }
                let file_create_started_at = Instant::now();
                let mut file = fs::File::create(&target_path).map_err(|error| {
                    format!(
                        "Failed to create local bundle file {}: {error}",
                        target_path.display()
                    )
                })?;
                timings.file_create_us += elapsed_micros_u64(file_create_started_at);
                let file_write_started_at = Instant::now();
                file.write_all(&bundle_bytes[data_offset..data_end])
                    .map_err(|error| {
                        format!(
                            "Failed to write local bundle file {}: {error}",
                            target_path.display()
                        )
                    })?;
                timings.file_write_us += elapsed_micros_u64(file_write_started_at);
                #[cfg(unix)]
                {
                    if mode & 0o7777 != 0o644 {
                        use std::os::unix::fs::PermissionsExt;
                        let permissions = fs::Permissions::from_mode(mode & 0o7777);
                        let chmod_started_at = Instant::now();
                        fs::set_permissions(&target_path, permissions).map_err(|error| {
                            format!(
                                "Failed to set permissions on local bundle file {}: {error}",
                                target_path.display()
                            )
                        })?;
                        timings.chmod_us += elapsed_micros_u64(chmod_started_at);
                    }
                }
                if mtime_seconds > 0 {
                    let file_mtime_started_at = Instant::now();
                    set_file_handle_times(
                        &file,
                        None,
                        Some(FileTime::from_unix_time(
                            mtime_seconds.min(i64::MAX as u64) as i64,
                            0,
                        )),
                    )
                    .map_err(|error| {
                        format!(
                            "Failed to set mtime on local bundle file {}: {error}",
                            target_path.display()
                        )
                    })?;
                    timings.file_mtime_us += elapsed_micros_u64(file_mtime_started_at);
                }
                timings.file_count += 1;
            }
            b'5' => {
                if created_directories.insert(target_path.clone()) {
                    let mkdir_started_at = Instant::now();
                    fs::create_dir_all(&target_path).map_err(|error| {
                        format!(
                            "Failed to create local bundle directory {}: {error}",
                            target_path.display()
                        )
                    })?;
                    timings.mkdir_us += elapsed_micros_u64(mkdir_started_at);
                }
                #[cfg(unix)]
                {
                    if mode & 0o7777 != 0o755 {
                        use std::os::unix::fs::PermissionsExt;
                        let permissions = fs::Permissions::from_mode(mode & 0o7777);
                        let chmod_started_at = Instant::now();
                        fs::set_permissions(&target_path, permissions).map_err(|error| {
                            format!(
                                "Failed to set permissions on local bundle directory {}: {error}",
                                target_path.display()
                            )
                        })?;
                        timings.chmod_us += elapsed_micros_u64(chmod_started_at);
                    }
                }
                timings.directory_count += 1;
            }
            _ => return Ok(None),
        }

        saw_entry = true;
        let padded_size = size_usize.div_ceil(TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;
        offset = data_offset
            .checked_add(padded_size)
            .ok_or_else(|| format!("Ustar entry {raw_path} overflowed archive bounds."))?;
    }

    Ok(None)
}

fn elapsed_micros_u64(started_at: Instant) -> u64 {
    u64::try_from(started_at.elapsed().as_micros()).unwrap_or(u64::MAX)
}
