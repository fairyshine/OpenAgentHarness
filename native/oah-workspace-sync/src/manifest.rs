use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

use crate::path_rules::{
    build_remote_path, normalize_relative_path, should_exclude_relative_path,
    should_ignore_relative_path,
};

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PlanRemoteEntry {
    pub(crate) relative_path: String,
    pub(crate) key: String,
    pub(crate) size: u64,
    #[allow(dead_code)]
    pub(crate) last_modified_ms: Option<u128>,
    pub(crate) is_directory: bool,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SyncManifestFileEntry {
    pub(crate) size: u64,
    pub(crate) mtime_ms: u128,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SyncManifestDocument {
    pub(crate) version: u32,
    pub(crate) files: BTreeMap<String, SyncManifestFileEntry>,
    #[serde(default)]
    pub(crate) empty_directories: Vec<String>,
    #[serde(default)]
    pub(crate) storage_mode: Option<String>,
}

pub(crate) struct RemoteEntryListing {
    pub(crate) entries: Vec<PlanRemoteEntry>,
    pub(crate) has_sync_manifest: bool,
    pub(crate) bundle_entry: Option<PlanRemoteEntry>,
}

pub(crate) fn resolve_empty_remote_directories(
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

pub(crate) fn build_sync_manifest(
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

pub(crate) fn is_primary_bundle_manifest(document: &SyncManifestDocument) -> bool {
    matches!(
        document
            .storage_mode
            .as_deref()
            .map(|value| value.trim().to_ascii_lowercase()),
        Some(value) if value == "bundle" || value == "primary" || value == "bundle-only"
    )
}

pub(crate) fn create_remote_entries_from_manifest_document(
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
