use std::fs;
use std::io::Write;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::path_rules::normalize_path;
use crate::snapshot::collect_snapshot;
use crate::sync_bundle::{
    collect_bundle_relative_paths, run_tar_with_file_list_to_path, write_snapshot_tar_archive,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BuildSeedArchiveRequest {
    pub(crate) root_dir: String,
    pub(crate) archive_path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BuildSeedArchiveResponse {
    pub(crate) ok: bool,
    pub(crate) protocol_version: u32,
    pub(crate) archive_path: String,
    pub(crate) archive_bytes: u64,
    pub(crate) file_count: usize,
    pub(crate) empty_directory_count: usize,
}

pub(crate) fn build_seed_archive(
    request: BuildSeedArchiveRequest,
    protocol_version: u32,
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
        protocol_version,
        archive_path: normalize_path(&archive_path),
        archive_bytes,
        file_count: snapshot.files.len(),
        empty_directory_count: snapshot.empty_directories.len(),
    })
}
