use std::path::Path;
use std::time::Instant;

use aws_sdk_s3::error::ProvideErrorMetadata;
use aws_sdk_s3::primitives::ByteStream;
use aws_sdk_s3::types::{Delete, ObjectIdentifier};
use aws_sdk_s3::Client as S3Client;
use tokio::io::AsyncWriteExt;

use crate::elapsed_millis_u64;
use crate::local_fs::is_local_directory_empty;
use crate::object_store::{NativeObjectStoreConfig, NativeObjectStoreRequestCounter};
use crate::path_rules::{build_remote_path, INTERNAL_SYNC_BUNDLE_RELATIVE_PATH};
use crate::protocol::SyncRemoteToLocalPhaseTimings;
use crate::snapshot::Snapshot;
use crate::sync_bundle::{
    build_local_sync_bundle, resolve_in_memory_sync_bundle_extract_max_bytes,
    unpack_sync_bundle_blocking, unpack_sync_bundle_bytes_blocking, BuiltSyncBundle,
    SyncBundleExtractTimings,
};

pub(crate) struct UploadSyncBundleResult {
    pub(crate) bundle_build_ms: u64,
    pub(crate) bundle_body_prepare_ms: u64,
    pub(crate) bundle_upload_ms: u64,
    pub(crate) bundle_transport: &'static str,
    pub(crate) bundle_bytes: u64,
}

pub(crate) async fn upload_sync_bundle(
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

pub(crate) async fn delete_remote_object_if_present(
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

#[derive(Clone)]
pub(crate) struct HydrateSyncBundleResult {
    pub(crate) hydrated: bool,
    bundle_get_ms: u64,
    bundle_body_read_ms: u64,
    bundle_extract_ms: u64,
    bundle_extract_timings: SyncBundleExtractTimings,
    bundle_transport: &'static str,
    bundle_extractor: &'static str,
    bundle_bytes: u64,
}

impl HydrateSyncBundleResult {
    fn not_found() -> Self {
        Self {
            hydrated: false,
            bundle_get_ms: 0,
            bundle_body_read_ms: 0,
            bundle_extract_ms: 0,
            bundle_extract_timings: SyncBundleExtractTimings::default(),
            bundle_transport: "none",
            bundle_extractor: "none",
            bundle_bytes: 0,
        }
    }
}

pub(crate) fn record_hydrate_timings(
    phase_timings: &mut SyncRemoteToLocalPhaseTimings,
    hydrate_result: &HydrateSyncBundleResult,
) {
    phase_timings.bundle_get_ms += hydrate_result.bundle_get_ms;
    phase_timings.bundle_body_read_ms += hydrate_result.bundle_body_read_ms;
    phase_timings.bundle_extract_ms += hydrate_result.bundle_extract_ms;
    phase_timings.bundle_extract_mkdir_us += hydrate_result.bundle_extract_timings.mkdir_us;
    phase_timings.bundle_extract_replace_us += hydrate_result.bundle_extract_timings.replace_us;
    phase_timings.bundle_extract_file_create_us +=
        hydrate_result.bundle_extract_timings.file_create_us;
    phase_timings.bundle_extract_file_write_us +=
        hydrate_result.bundle_extract_timings.file_write_us;
    phase_timings.bundle_extract_file_mtime_us +=
        hydrate_result.bundle_extract_timings.file_mtime_us;
    phase_timings.bundle_extract_chmod_us += hydrate_result.bundle_extract_timings.chmod_us;
    phase_timings.bundle_extract_target_check_us +=
        hydrate_result.bundle_extract_timings.target_check_us;
    phase_timings.bundle_extract_file_count += hydrate_result.bundle_extract_timings.file_count;
    phase_timings.bundle_extract_directory_count +=
        hydrate_result.bundle_extract_timings.directory_count;
    if hydrate_result.hydrated {
        phase_timings.bundle_transport = hydrate_result.bundle_transport.to_string();
        phase_timings.bundle_extractor = hydrate_result.bundle_extractor.to_string();
        phase_timings.bundle_bytes = hydrate_result.bundle_bytes;
    }
}

pub(crate) async fn maybe_hydrate_from_remote_sync_bundle(
    client: &S3Client,
    config: &NativeObjectStoreConfig,
    root_dir: &Path,
    bundle_key: &str,
    require_empty_root: bool,
    request_counter: &NativeObjectStoreRequestCounter,
) -> Result<HydrateSyncBundleResult, String> {
    if require_empty_root && !is_local_directory_empty(root_dir).await? {
        return Ok(HydrateSyncBundleResult::not_found());
    }

    let hydrated = async {
        let bundle_path = tempfile::NamedTempFile::new()
            .map_err(|error| format!("Failed to create temporary sync bundle file: {error}"))?
            .into_temp_path();
        request_counter.increment_get();
        let bundle_get_started_at = Instant::now();
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
                    return Ok(HydrateSyncBundleResult::not_found());
                }
                return Err(format!(
                    "Failed to download sync bundle {bundle_key}: {error}"
                ));
            }
        };
        let bundle_get_ms = elapsed_millis_u64(bundle_get_started_at);

        let content_length = response.content_length().unwrap_or_default().max(0) as u64;
        let extract_max_bytes = resolve_in_memory_sync_bundle_extract_max_bytes();
        if content_length > 0 && content_length <= extract_max_bytes {
            let body_read_started_at = Instant::now();
            let bundle_bytes = response
                .body
                .collect()
                .await
                .map_err(|error| format!("Failed to read sync bundle {bundle_key}: {error}"))?
                .into_bytes()
                .to_vec();
            let bundle_body_read_ms = elapsed_millis_u64(body_read_started_at);
            let bundle_bytes_len = bundle_bytes.len() as u64;
            let root_dir = root_dir.to_path_buf();
            let extract_started_at = Instant::now();
            let extract_outcome = tokio::task::spawn_blocking(move || {
                unpack_sync_bundle_bytes_blocking(root_dir, bundle_bytes, require_empty_root)
            })
            .await
            .map_err(|error| format!("Sync bundle extraction worker task failed: {error}"))??;
            return Ok(HydrateSyncBundleResult {
                hydrated: true,
                bundle_get_ms,
                bundle_body_read_ms,
                bundle_extract_ms: elapsed_millis_u64(extract_started_at),
                bundle_extract_timings: extract_outcome.timings,
                bundle_transport: "memory",
                bundle_extractor: extract_outcome.extractor,
                bundle_bytes: bundle_bytes_len,
            });
        }

        let body_read_started_at = Instant::now();
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
        let bundle_body_read_ms = elapsed_millis_u64(body_read_started_at);
        let bundle_bytes = tokio::fs::metadata(bundle_path.as_ref() as &Path)
            .await
            .map(|metadata| metadata.len())
            .unwrap_or(0);

        let root_dir = root_dir.to_path_buf();
        let bundle_path_buf = bundle_path.to_path_buf();
        let extract_started_at = Instant::now();
        tokio::task::spawn_blocking(move || unpack_sync_bundle_blocking(root_dir, bundle_path_buf))
            .await
            .map_err(|error| format!("Sync bundle extraction worker task failed: {error}"))??;
        Ok(HydrateSyncBundleResult {
            hydrated: true,
            bundle_get_ms,
            bundle_body_read_ms,
            bundle_extract_ms: elapsed_millis_u64(extract_started_at),
            bundle_extract_timings: SyncBundleExtractTimings::default(),
            bundle_transport: "tempfile",
            bundle_extractor: "tar",
            bundle_bytes,
        })
    }
    .await;

    match hydrated {
        Ok(found) => Ok(found),
        Err(_) => {
            let _ = tokio::fs::remove_dir_all(root_dir).await;
            let _ = tokio::fs::create_dir_all(root_dir).await;
            Ok(HydrateSyncBundleResult::not_found())
        }
    }
}
