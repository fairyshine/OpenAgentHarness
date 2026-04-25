use std::collections::HashSet;
use std::sync::{Mutex, OnceLock};

use serde::Deserialize;

use crate::manifest::PlanRemoteEntry;
use crate::snapshot::Snapshot;

const DEFAULT_SYNC_BUNDLE_MIN_FILE_COUNT: usize = 16;
const DEFAULT_SYNC_BUNDLE_MIN_TOTAL_BYTES: u64 = 128 * 1024;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeSyncBundleConfig {
    mode: Option<String>,
    min_file_count: Option<usize>,
    min_total_bytes: Option<u64>,
    layout: Option<String>,
    trust_managed_prefixes: Option<bool>,
}

#[derive(Clone, Copy, Eq, PartialEq)]
pub(crate) enum SyncBundleMode {
    Off,
    Auto,
    Force,
}

#[derive(Clone, Copy, Eq, PartialEq)]
pub(crate) enum SyncBundleLayout {
    Sidecar,
    Primary,
}

#[derive(Clone, Copy)]
pub(crate) struct ResolvedSyncBundleConfig {
    pub(crate) mode: SyncBundleMode,
    pub(crate) min_file_count: usize,
    pub(crate) min_total_bytes: u64,
    pub(crate) layout: SyncBundleLayout,
    pub(crate) trust_managed_prefixes: bool,
}

static TRUSTED_MANAGED_PREFIX_CACHE: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

pub(crate) fn resolve_sync_bundle_config(
    value: Option<&NativeSyncBundleConfig>,
) -> ResolvedSyncBundleConfig {
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

pub(crate) fn mark_trusted_managed_prefix_seen(remote_prefix: &str) {
    let cache = TRUSTED_MANAGED_PREFIX_CACHE.get_or_init(|| Mutex::new(HashSet::new()));
    if let Ok(mut seen) = cache.lock() {
        seen.insert(remote_prefix.to_string());
    }
}

pub(crate) fn should_assume_empty_trusted_managed_prefix(
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

pub(crate) fn should_attempt_sync_bundle_for_snapshot(
    snapshot: &Snapshot,
    config: ResolvedSyncBundleConfig,
) -> bool {
    let file_count = snapshot.files.len();
    let total_bytes = snapshot.files.iter().map(|file| file.size).sum::<u64>();
    should_attempt_sync_bundle(file_count, total_bytes, config)
}

pub(crate) fn should_attempt_sync_bundle_for_remote_entries(
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
