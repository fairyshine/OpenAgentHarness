use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use serde::Serialize;

use crate::manifest::{PlanRemoteEntry, SyncManifestDocument};
use crate::path_rules::{
    add_directory_with_parents, build_remote_path, normalize_path, normalize_relative_path,
    should_preserve_top_level_name,
};
use crate::snapshot::Snapshot;

pub(crate) struct LocalToRemotePlan {
    pub(crate) upload_candidates: Vec<PlanUploadCandidate>,
    pub(crate) info_check_candidates: Vec<PlanUploadCandidate>,
    pub(crate) empty_directories_to_create: Vec<String>,
    pub(crate) keys_to_delete: Vec<String>,
}

pub(crate) struct RemoteToLocalPlan {
    pub(crate) remove_paths: Vec<String>,
    pub(crate) directories_to_create: Vec<String>,
    pub(crate) download_candidates: Vec<PlanDownloadCandidate>,
    pub(crate) info_check_candidates: Vec<PlanDownloadCandidate>,
}

pub(crate) struct SeedUploadPlan {
    pub(crate) directories: Vec<String>,
    pub(crate) files: Vec<PlanSeedUploadFile>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PlanUploadCandidate {
    pub(crate) relative_path: String,
    pub(crate) absolute_path: String,
    pub(crate) size: u64,
    pub(crate) mtime_ms: u128,
    pub(crate) remote_key: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PlanDownloadCandidate {
    pub(crate) relative_path: String,
    pub(crate) target_path: String,
    pub(crate) size: u64,
    pub(crate) remote_key: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PlanSeedUploadFile {
    pub(crate) relative_path: String,
    pub(crate) absolute_path: String,
    pub(crate) remote_path: String,
    pub(crate) size: u64,
    pub(crate) mtime_ms: u128,
}

pub(crate) fn count_snapshot_file_mutations(
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

pub(crate) fn count_snapshot_deleted_files(
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

pub(crate) fn count_snapshot_created_empty_directories(
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

pub(crate) fn count_remote_file_entries(remote_entries: &[PlanRemoteEntry]) -> usize {
    remote_entries
        .iter()
        .filter(|entry| !entry.is_directory)
        .count()
}

pub(crate) fn create_local_to_remote_plan(
    snapshot: &Snapshot,
    remote_entries: Vec<PlanRemoteEntry>,
) -> LocalToRemotePlan {
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

pub(crate) fn create_remote_to_local_plan(
    root_dir: &Path,
    snapshot: &Snapshot,
    remote_entries: Vec<PlanRemoteEntry>,
    preserve_top_level_names: Vec<String>,
) -> RemoteToLocalPlan {
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

pub(crate) fn create_seed_upload_plan(
    snapshot: &Snapshot,
    remote_base_path: &str,
) -> SeedUploadPlan {
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
