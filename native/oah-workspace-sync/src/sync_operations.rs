use std::collections::BTreeMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use aws_sdk_s3::primitives::ByteStream;
use aws_sdk_s3::Client as S3Client;
use tokio::task::JoinSet;

use crate::local_fs::{ensure_local_directory, prepare_local_file_target, remove_local_path};
use crate::object_store::{
    download_remote_file, parse_object_mtime_ms, system_time_to_mtime_ms, upload_local_file,
    NativeObjectStoreConfig, NativeObjectStoreRequestCounter,
};
use crate::path_rules::build_remote_path;
use crate::plan::{PlanDownloadCandidate, PlanUploadCandidate};

pub(crate) struct RemoteDownloadOutcome {
    pub(crate) relative_path: String,
    pub(crate) size: u64,
    pub(crate) mtime_ms: u128,
    pub(crate) downloaded: bool,
}

pub(crate) async fn process_with_concurrency<T, R, F, Fut>(
    items: Vec<T>,
    max_concurrency: usize,
    worker: F,
) -> Result<Vec<R>, String>
where
    T: Send + 'static,
    R: Send + 'static,
    F: Fn(T) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = Result<R, String>> + Send + 'static,
{
    if items.is_empty() {
        return Ok(Vec::new());
    }

    let worker = Arc::new(worker);
    let mut pending = items.into_iter();
    let mut join_set = JoinSet::new();
    let mut in_flight = 0usize;
    let limit = max_concurrency.max(1);
    let mut results = Vec::new();

    loop {
        while in_flight < limit {
            let Some(item) = pending.next() else {
                break;
            };
            let worker = Arc::clone(&worker);
            join_set.spawn(async move { worker(item).await });
            in_flight += 1;
        }

        if in_flight == 0 {
            break;
        }

        let next = join_set.join_next().await.ok_or_else(|| {
            "Native workspace sync concurrency worker exited unexpectedly.".to_string()
        })?;
        in_flight -= 1;
        let result =
            next.map_err(|error| format!("Native workspace sync worker task failed: {error}"))??;
        results.push(result);
    }

    Ok(results)
}

pub(crate) async fn remove_local_paths(
    remove_paths: Vec<String>,
    max_concurrency: usize,
) -> Result<usize, String> {
    Ok(
        process_with_concurrency(remove_paths, max_concurrency, |target_path| async move {
            remove_local_path(Path::new(&target_path)).await
        })
        .await?
        .into_iter()
        .filter(|removed| *removed)
        .count(),
    )
}

pub(crate) async fn create_local_directories(
    root_dir: &Path,
    directories: Vec<String>,
    max_concurrency: usize,
) -> Result<usize, String> {
    tokio::fs::create_dir_all(root_dir).await.map_err(|error| {
        format!(
            "Failed to create local root directory {}: {error}",
            root_dir.display()
        )
    })?;

    let root_dir_for_directories = root_dir.to_path_buf();
    Ok(
        process_with_concurrency(directories, max_concurrency, move |relative_path| {
            let root_dir = root_dir_for_directories.clone();
            async move {
                let target_path = root_dir.join(relative_path);
                ensure_local_directory(&target_path).await
            }
        })
        .await?
        .into_iter()
        .filter(|created| *created)
        .count(),
    )
}

pub(crate) async fn download_remote_candidates(
    client: &S3Client,
    object_store: &NativeObjectStoreConfig,
    request_counts: Arc<NativeObjectStoreRequestCounter>,
    candidates: Vec<PlanDownloadCandidate>,
    max_concurrency: usize,
) -> Result<Vec<RemoteDownloadOutcome>, String> {
    let client_for_downloads = client.clone();
    let object_store_for_downloads = object_store.clone();
    process_with_concurrency(candidates, max_concurrency, move |candidate| {
        let client = client_for_downloads.clone();
        let object_store = object_store_for_downloads.clone();
        let request_counts = Arc::clone(&request_counts);
        async move {
            let target_path = PathBuf::from(&candidate.target_path);
            prepare_local_file_target(&target_path).await?;
            let mtime_ms = download_remote_file(
                &client,
                &object_store,
                &candidate.remote_key,
                &target_path,
                request_counts.as_ref(),
            )
            .await?;
            Ok(RemoteDownloadOutcome {
                relative_path: candidate.relative_path,
                size: candidate.size,
                mtime_ms,
                downloaded: true,
            })
        }
    })
    .await
}

pub(crate) async fn info_check_remote_candidates(
    client: &S3Client,
    object_store: &NativeObjectStoreConfig,
    sync_manifest: Arc<BTreeMap<String, crate::manifest::SyncManifestFileEntry>>,
    request_counts: Arc<NativeObjectStoreRequestCounter>,
    candidates: Vec<PlanDownloadCandidate>,
    max_concurrency: usize,
) -> Result<Vec<RemoteDownloadOutcome>, String> {
    let client_for_info_checks = client.clone();
    let object_store_for_info_checks = object_store.clone();
    process_with_concurrency(candidates, max_concurrency, move |candidate| {
        let client = client_for_info_checks.clone();
        let object_store = object_store_for_info_checks.clone();
        let sync_manifest = Arc::clone(&sync_manifest);
        let request_counts = Arc::clone(&request_counts);
        async move {
            let target_path = PathBuf::from(&candidate.target_path);
            let existing = prepare_local_file_target(&target_path).await?;

            let should_download: Result<(bool, Option<u128>), String> = match existing {
                Some(metadata) if metadata.len() == candidate.size => {
                    if let Some(manifest_entry) = sync_manifest.get(&candidate.relative_path) {
                        let local_mtime_ms =
                            metadata.modified().ok().and_then(system_time_to_mtime_ms);
                        if manifest_entry.size == candidate.size
                            && local_mtime_ms == Some(manifest_entry.mtime_ms)
                        {
                            return Ok(RemoteDownloadOutcome {
                                relative_path: candidate.relative_path,
                                size: candidate.size,
                                mtime_ms: manifest_entry.mtime_ms,
                                downloaded: false,
                            });
                        }
                    }

                    request_counts.increment_head();
                    let head = client
                        .head_object()
                        .bucket(&object_store.bucket)
                        .key(&candidate.remote_key)
                        .send()
                        .await;

                    match head {
                        Ok(head) => {
                            let remote_mtime_ms =
                                parse_object_mtime_ms(head.metadata()).or_else(|| {
                                    head.last_modified()
                                        .and_then(|value| value.to_millis().ok())
                                        .map(|value| value.max(0) as u128)
                                });
                            let local_mtime_ms =
                                metadata.modified().ok().and_then(system_time_to_mtime_ms);
                            match (remote_mtime_ms, local_mtime_ms) {
                                (Some(remote_mtime_ms), Some(local_mtime_ms)) => {
                                    if remote_mtime_ms != local_mtime_ms {
                                        Ok((true, None))
                                    } else {
                                        Ok((false, Some(local_mtime_ms)))
                                    }
                                }
                                _ => Ok((true, None)),
                            }
                        }
                        Err(_) => Ok((true, None)),
                    }
                }
                _ => Ok((true, None)),
            };

            let (should_download, existing_mtime_ms) = should_download?;
            if !should_download {
                return Ok(RemoteDownloadOutcome {
                    relative_path: candidate.relative_path,
                    size: candidate.size,
                    mtime_ms: existing_mtime_ms.unwrap_or_default(),
                    downloaded: false,
                });
            }

            let mtime_ms = download_remote_file(
                &client,
                &object_store,
                &candidate.remote_key,
                &target_path,
                request_counts.as_ref(),
            )
            .await?;
            Ok(RemoteDownloadOutcome {
                relative_path: candidate.relative_path,
                size: candidate.size,
                mtime_ms,
                downloaded: true,
            })
        }
    })
    .await
}

pub(crate) async fn upload_local_candidates(
    client: &S3Client,
    object_store: &NativeObjectStoreConfig,
    remote_prefix: &str,
    request_counts: Arc<NativeObjectStoreRequestCounter>,
    inline_upload_threshold_bytes: u64,
    candidates: Vec<PlanUploadCandidate>,
    max_concurrency: usize,
) -> Result<Vec<bool>, String> {
    let client_for_uploads = client.clone();
    let object_store_for_uploads = object_store.clone();
    let remote_prefix_for_uploads = remote_prefix.to_string();
    process_with_concurrency(candidates, max_concurrency, move |candidate| {
        let client = client_for_uploads.clone();
        let object_store = object_store_for_uploads.clone();
        let remote_prefix = remote_prefix_for_uploads.clone();
        let request_counts = Arc::clone(&request_counts);
        async move {
            let key = build_remote_path(&remote_prefix, &candidate.relative_path);
            upload_local_file(
                &client,
                &object_store,
                &key,
                &candidate.absolute_path,
                candidate.size,
                inline_upload_threshold_bytes,
                candidate.mtime_ms,
                request_counts.as_ref(),
            )
            .await
        }
    })
    .await
}

pub(crate) async fn info_check_upload_candidates(
    client: &S3Client,
    object_store: &NativeObjectStoreConfig,
    remote_prefix: &str,
    remote_entries: Arc<BTreeMap<String, crate::manifest::PlanRemoteEntry>>,
    sync_manifest: Arc<BTreeMap<String, crate::manifest::SyncManifestFileEntry>>,
    request_counts: Arc<NativeObjectStoreRequestCounter>,
    inline_upload_threshold_bytes: u64,
    candidates: Vec<PlanUploadCandidate>,
    max_concurrency: usize,
) -> Result<Vec<bool>, String> {
    let client_for_info_checks = client.clone();
    let object_store_for_info_checks = object_store.clone();
    let remote_prefix_for_info_checks = remote_prefix.to_string();
    process_with_concurrency(candidates, max_concurrency, move |candidate| {
        let client = client_for_info_checks.clone();
        let object_store = object_store_for_info_checks.clone();
        let remote_prefix = remote_prefix_for_info_checks.clone();
        let remote_entries = Arc::clone(&remote_entries);
        let sync_manifest = Arc::clone(&sync_manifest);
        let request_counts = Arc::clone(&request_counts);
        async move {
            let remote_entry = remote_entries.get(&candidate.relative_path).cloned();
            let should_upload = match remote_entry {
                None => true,
                Some(remote_entry) if remote_entry.is_directory => true,
                Some(remote_entry) => {
                    if let Some(manifest_entry) = sync_manifest.get(&candidate.relative_path) {
                        if manifest_entry.size == candidate.size
                            && manifest_entry.mtime_ms == candidate.mtime_ms
                        {
                            return Ok(false);
                        }
                    }

                    request_counts.increment_head();
                    let head = client
                        .head_object()
                        .bucket(&object_store.bucket)
                        .key(&remote_entry.key)
                        .send()
                        .await;

                    match head {
                        Ok(head) => match parse_object_mtime_ms(head.metadata()) {
                            Some(remote_mtime_ms) => remote_mtime_ms != candidate.mtime_ms,
                            None => head
                                .last_modified()
                                .and_then(|value| value.to_millis().ok())
                                .map(|value| value as i128)
                                .map(|value| value < candidate.mtime_ms as i128)
                                .unwrap_or(true),
                        },
                        Err(_) => true,
                    }
                }
            };

            if !should_upload {
                return Ok(false);
            }

            let key = build_remote_path(&remote_prefix, &candidate.relative_path);
            upload_local_file(
                &client,
                &object_store,
                &key,
                &candidate.absolute_path,
                candidate.size,
                inline_upload_threshold_bytes,
                candidate.mtime_ms,
                request_counts.as_ref(),
            )
            .await
        }
    })
    .await
}

pub(crate) async fn create_remote_empty_directories(
    client: &S3Client,
    object_store: &NativeObjectStoreConfig,
    remote_prefix: &str,
    request_counts: Arc<NativeObjectStoreRequestCounter>,
    relative_paths: Vec<String>,
    max_concurrency: usize,
) -> Result<usize, String> {
    let client_for_empty_directories = client.clone();
    let object_store_for_empty_directories = object_store.clone();
    let remote_prefix_for_empty_directories = remote_prefix.to_string();
    Ok(
        process_with_concurrency(relative_paths, max_concurrency, move |relative_path| {
            let client = client_for_empty_directories.clone();
            let object_store = object_store_for_empty_directories.clone();
            let remote_prefix = remote_prefix_for_empty_directories.clone();
            let request_counts = Arc::clone(&request_counts);
            async move {
                let key = format!("{}/", build_remote_path(&remote_prefix, &relative_path));
                request_counts.increment_put();
                client
                    .put_object()
                    .bucket(&object_store.bucket)
                    .key(key)
                    .body(ByteStream::from_static(b""))
                    .send()
                    .await
                    .map_err(|error| {
                        format!("Failed to create empty S3 directory marker: {error}")
                    })?;
                Ok(true)
            }
        })
        .await?
        .len(),
    )
}
