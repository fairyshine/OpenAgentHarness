use std::collections::{BTreeMap, HashMap};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use aws_credential_types::Credentials;
use aws_sdk_s3::config::Region;
use aws_sdk_s3::primitives::ByteStream;
use aws_sdk_s3::Client as S3Client;
use filetime::{set_file_mtime, FileTime};
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::manifest::{
    build_sync_manifest, PlanRemoteEntry, RemoteEntryListing, SyncManifestDocument,
    SyncManifestFileEntry,
};
use crate::path_rules::{
    build_remote_path, normalize_relative_path, relative_path_from_remote_key,
    should_ignore_relative_path, INTERNAL_SYNC_BUNDLE_RELATIVE_PATH,
    INTERNAL_SYNC_MANIFEST_RELATIVE_PATH,
};

const OBJECT_MTIME_METADATA_KEY: &str = "oah-mtime-ms";

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeObjectStoreConfig {
    pub(crate) bucket: String,
    pub(crate) region: String,
    pub(crate) endpoint: Option<String>,
    pub(crate) force_path_style: Option<bool>,
    pub(crate) access_key: Option<String>,
    pub(crate) secret_key: Option<String>,
    pub(crate) session_token: Option<String>,
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ObjectStoreRequestCounts {
    pub(crate) list_requests: usize,
    pub(crate) get_requests: usize,
    pub(crate) head_requests: usize,
    pub(crate) put_requests: usize,
    pub(crate) delete_requests: usize,
}

#[derive(Default)]
pub(crate) struct NativeObjectStoreRequestCounter {
    list_requests: AtomicUsize,
    get_requests: AtomicUsize,
    head_requests: AtomicUsize,
    put_requests: AtomicUsize,
    delete_requests: AtomicUsize,
}

impl NativeObjectStoreRequestCounter {
    pub(crate) fn increment_list(&self) {
        self.list_requests.fetch_add(1, Ordering::Relaxed);
    }

    pub(crate) fn increment_get(&self) {
        self.get_requests.fetch_add(1, Ordering::Relaxed);
    }

    pub(crate) fn increment_head(&self) {
        self.head_requests.fetch_add(1, Ordering::Relaxed);
    }

    pub(crate) fn increment_put(&self) {
        self.put_requests.fetch_add(1, Ordering::Relaxed);
    }

    pub(crate) fn increment_delete(&self) {
        self.delete_requests.fetch_add(1, Ordering::Relaxed);
    }

    pub(crate) fn snapshot(&self) -> ObjectStoreRequestCounts {
        ObjectStoreRequestCounts {
            list_requests: self.list_requests.load(Ordering::Relaxed),
            get_requests: self.get_requests.load(Ordering::Relaxed),
            head_requests: self.head_requests.load(Ordering::Relaxed),
            put_requests: self.put_requests.load(Ordering::Relaxed),
            delete_requests: self.delete_requests.load(Ordering::Relaxed),
        }
    }
}

pub(crate) fn create_s3_client(config: &NativeObjectStoreConfig) -> S3Client {
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

pub(crate) fn parse_object_mtime_ms(metadata: Option<&HashMap<String, String>>) -> Option<u128> {
    metadata
        .and_then(|metadata| metadata.get(OBJECT_MTIME_METADATA_KEY))
        .and_then(|value| value.parse::<u128>().ok())
        .filter(|value| *value > 0)
}

pub(crate) fn system_time_to_mtime_ms(value: SystemTime) -> Option<u128> {
    value
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|duration| duration.as_millis())
}

pub(crate) async fn list_remote_entries(
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

pub(crate) async fn load_remote_sync_manifest_document(
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

pub(crate) async fn load_remote_sync_manifest(
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

pub(crate) async fn write_remote_sync_manifest(
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

pub(crate) async fn upload_local_file(
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

pub(crate) async fn download_remote_file(
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

fn file_time_from_mtime_ms(value: u128) -> FileTime {
    let seconds = (value / 1000).min(i64::MAX as u128) as i64;
    let nanos = ((value % 1000) * 1_000_000) as u32;
    FileTime::from_unix_time(seconds, nanos)
}
