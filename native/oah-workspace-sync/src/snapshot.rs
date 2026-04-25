use std::collections::BTreeSet;
use std::fs;
use std::io;
use std::path::Path;
use std::time::UNIX_EPOCH;

use serde::Serialize;
use sha1::{Digest, Sha1};

use crate::path_rules::{
    normalize_path, normalize_relative_path, should_exclude_relative_path,
    should_ignore_relative_path,
};

#[derive(Default)]
pub(crate) struct Snapshot {
    pub(crate) files: Vec<FileEntry>,
    pub(crate) files_sorted_by_relative_path: bool,
    pub(crate) directories: BTreeSet<String>,
    pub(crate) empty_directories: BTreeSet<String>,
    pub(crate) ignored_paths: Vec<String>,
}

#[derive(Clone)]
pub(crate) struct FileEntry {
    pub(crate) relative_path: String,
    pub(crate) absolute_path: String,
    pub(crate) size: u64,
    pub(crate) mtime_ms: u128,
    pub(crate) mode: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ScanFileEntry {
    pub(crate) relative_path: String,
    pub(crate) absolute_path: String,
    pub(crate) size: u64,
    pub(crate) mtime_ms: u128,
}

pub(crate) fn collect_snapshot(root_dir: &Path, excludes: &[String]) -> Result<Snapshot, String> {
    match fs::metadata(root_dir) {
        Ok(metadata) if metadata.is_dir() => {
            let mut snapshot = Snapshot::default();
            walk_directory(root_dir, root_dir, excludes, &mut snapshot)?;
            snapshot.files_sorted_by_relative_path = true;
            Ok(snapshot)
        }
        Ok(_) => Ok(Snapshot::default()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(Snapshot::default()),
        Err(error) => Err(format!("Failed to stat {}: {error}", root_dir.display())),
    }
}

pub(crate) fn create_fingerprint(snapshot: &Snapshot) -> String {
    let mut hash = Sha1::new();
    if snapshot.files_sorted_by_relative_path {
        for file in &snapshot.files {
            hash.update(
                format!(
                    "file:{}:{}:{}\n",
                    file.relative_path, file.size, file.mtime_ms
                )
                .as_bytes(),
            );
        }
    } else {
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
    }

    for relative_directory in &snapshot.empty_directories {
        hash.update(format!("dir:{relative_directory}\n").as_bytes());
    }

    format!("{:x}", hash.finalize())
}

pub(crate) fn create_fingerprint_from_entries(
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
