use std::fs;
use std::io;
use std::path::Path;

use sha2::{Digest, Sha256};

pub(crate) struct ArchiveDirectoryInspection {
    pub(crate) unexpected_directories: Vec<String>,
    pub(crate) leftover_temp_files: Vec<String>,
    pub(crate) unexpected_files: Vec<String>,
    pub(crate) missing_checksums: Vec<String>,
    pub(crate) orphan_checksums: Vec<String>,
}

pub(crate) fn inspect_export_root(
    export_root: &Path,
) -> Result<ArchiveDirectoryInspection, String> {
    let entries = match fs::read_dir(export_root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Ok(ArchiveDirectoryInspection {
                unexpected_directories: Vec::new(),
                leftover_temp_files: Vec::new(),
                unexpected_files: Vec::new(),
                missing_checksums: Vec::new(),
                orphan_checksums: Vec::new(),
            })
        }
        Err(error) => {
            return Err(format!(
                "Failed to inspect archive export directory {}: {error}",
                export_root.display()
            ))
        }
    };

    let mut unexpected_directories = Vec::new();
    let mut leftover_temp_files = Vec::new();
    let mut unexpected_files = Vec::new();
    let mut bundle_names = Vec::new();
    let mut checksum_names = Vec::new();

    for entry in entries {
        let entry = entry
            .map_err(|error| format!("Failed to read archive export directory entry: {error}"))?;
        let name = entry.file_name().to_string_lossy().to_string();
        let file_type = entry.file_type().map_err(|error| {
            format!("Failed to inspect archive export entry type for {name}: {error}")
        })?;

        if file_type.is_dir() {
            unexpected_directories.push(name);
            continue;
        }

        if name.ends_with(".tmp") {
            leftover_temp_files.push(name);
            continue;
        }

        if is_archive_bundle_name(&name) {
            bundle_names.push(name);
            continue;
        }

        if is_archive_checksum_name(&name) {
            checksum_names.push(name);
            continue;
        }

        unexpected_files.push(name);
    }

    bundle_names.sort();
    checksum_names.sort();
    let mut missing_checksums = Vec::new();
    for bundle_name in &bundle_names {
        let checksum_name = format!("{bundle_name}.sha256");
        if !checksum_names
            .iter()
            .any(|candidate| candidate == &checksum_name)
        {
            missing_checksums.push(bundle_name.clone());
        }
    }

    let mut orphan_checksums = Vec::new();
    for checksum_name in &checksum_names {
        let bundle_name = checksum_name
            .strip_suffix(".sha256")
            .unwrap_or(checksum_name);
        if !bundle_names
            .iter()
            .any(|candidate| candidate == bundle_name)
        {
            orphan_checksums.push(checksum_name.clone());
        }
    }

    unexpected_directories.sort();
    leftover_temp_files.sort();
    unexpected_files.sort();

    Ok(ArchiveDirectoryInspection {
        unexpected_directories,
        leftover_temp_files,
        unexpected_files,
        missing_checksums,
        orphan_checksums,
    })
}

pub(crate) fn sha256_file(file_path: &Path) -> Result<String, String> {
    let bytes = fs::read(file_path).map_err(|error| {
        format!(
            "Failed to read archive file {}: {error}",
            file_path.display()
        )
    })?;
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    Ok(format!("{:x}", hasher.finalize()))
}

fn is_archive_bundle_name(file_name: &str) -> bool {
    is_archive_date_prefix(file_name, ".sqlite")
}

fn is_archive_checksum_name(file_name: &str) -> bool {
    is_archive_date_prefix(file_name, ".sqlite.sha256")
}

fn is_archive_date_prefix(file_name: &str, suffix: &str) -> bool {
    if !file_name.ends_with(suffix) {
        return false;
    }

    let prefix = &file_name[..file_name.len() - suffix.len()];
    let bytes = prefix.as_bytes();
    bytes.len() == 10
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| index == 4 || index == 7 || byte.is_ascii_digit())
}
