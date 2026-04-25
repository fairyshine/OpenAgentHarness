use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;

use aws_sdk_s3::types::{Delete, ObjectIdentifier};

use crate::bundle_policy::*;
use crate::bundle_transfer::*;
use crate::local_fs::*;
use crate::manifest::*;
use crate::object_store::*;
use crate::path_rules::*;
use crate::plan::*;
use crate::protocol::*;
use crate::snapshot::*;
use crate::sync_operations::*;
use crate::{elapsed_millis_u64, resolve_inline_upload_threshold_bytes, resolve_max_concurrency};

pub(crate) async fn sync_remote_to_local(
    request: SyncRemoteToLocalRequest,
) -> Result<SyncRemoteToLocalResponse, String> {
    let command_started_at = Instant::now();
    let excludes = normalize_exclude_paths(request.exclude_relative_paths);
    let preserve_top_level_names = normalize_exclude_paths(request.preserve_top_level_names);
    let max_concurrency = resolve_max_concurrency(request.max_concurrency);
    let sync_bundle_config = resolve_sync_bundle_config(request.sync_bundle.as_ref());
    let root_dir = PathBuf::from(&request.root_dir);
    let scan_started_at = Instant::now();
    let snapshot = collect_snapshot(&root_dir, &excludes)?;
    let mut phase_timings = SyncRemoteToLocalPhaseTimings {
        scan_ms: elapsed_millis_u64(scan_started_at),
        client_create_ms: 0,
        listing_ms: 0,
        manifest_read_ms: 0,
        plan_ms: 0,
        remove_ms: 0,
        mkdir_ms: 0,
        bundle_get_ms: 0,
        bundle_body_read_ms: 0,
        bundle_extract_ms: 0,
        bundle_extract_mkdir_us: 0,
        bundle_extract_replace_us: 0,
        bundle_extract_file_create_us: 0,
        bundle_extract_file_write_us: 0,
        bundle_extract_file_mtime_us: 0,
        bundle_extract_chmod_us: 0,
        bundle_extract_target_check_us: 0,
        bundle_extract_file_count: 0,
        bundle_extract_directory_count: 0,
        bundle_transport: "none".to_string(),
        bundle_extractor: "none".to_string(),
        bundle_bytes: 0,
        download_ms: 0,
        info_check_ms: 0,
        fingerprint_ms: 0,
        total_command_ms: 0,
    };

    let client_create_started_at = Instant::now();
    let client = create_s3_client(&request.object_store);
    phase_timings.client_create_ms = elapsed_millis_u64(client_create_started_at);
    let request_counts = Arc::new(NativeObjectStoreRequestCounter::default());
    if request.remote_entries.is_none() && sync_bundle_config.mode != SyncBundleMode::Off {
        let bundle_key =
            build_remote_path(&request.remote_prefix, INTERNAL_SYNC_BUNDLE_RELATIVE_PATH);
        let hydrate_result = maybe_hydrate_from_remote_sync_bundle(
            &client,
            &request.object_store,
            &root_dir,
            &bundle_key,
            true,
            request_counts.as_ref(),
        )
        .await?;
        record_hydrate_timings(&mut phase_timings, &hydrate_result);
        if hydrate_result.hydrated {
            let fingerprint_started_at = Instant::now();
            let hydrated_snapshot = collect_snapshot(&root_dir, &excludes)?;
            let local_fingerprint = create_fingerprint(&hydrated_snapshot);
            phase_timings.fingerprint_ms = elapsed_millis_u64(fingerprint_started_at);
            phase_timings.total_command_ms = elapsed_millis_u64(command_started_at);
            return Ok(SyncRemoteToLocalResponse {
                ok: true,
                protocol_version: PROTOCOL_VERSION,
                local_fingerprint,
                removed_path_count: 0,
                created_directory_count: 0,
                downloaded_file_count: hydrated_snapshot.files.len(),
                request_counts: request_counts.snapshot(),
                phase_timings: Some(phase_timings),
            });
        }
    }

    if request.remote_entries.is_none() && sync_bundle_config.layout == SyncBundleLayout::Primary {
        let manifest_read_started_at = Instant::now();
        let manifest_document = load_remote_sync_manifest_document(
            &client,
            &request.object_store,
            &request.remote_prefix,
            request_counts.as_ref(),
        )
        .await?;
        phase_timings.manifest_read_ms += elapsed_millis_u64(manifest_read_started_at);
        if let Some(manifest_document) = manifest_document {
            if is_primary_bundle_manifest(&manifest_document) {
                let remote_entries = create_remote_entries_from_manifest_document(
                    &manifest_document,
                    &request.remote_prefix,
                    &excludes,
                );
                let plan_started_at = Instant::now();
                let plan = create_remote_to_local_plan(
                    &root_dir,
                    &snapshot,
                    remote_entries.clone(),
                    preserve_top_level_names.clone(),
                );
                phase_timings.plan_ms += elapsed_millis_u64(plan_started_at);

                let remove_started_at = Instant::now();
                let removed_path_count =
                    remove_local_paths(plan.remove_paths.clone(), max_concurrency).await?;
                phase_timings.remove_ms += elapsed_millis_u64(remove_started_at);

                let mkdir_started_at = Instant::now();
                let created_directory_count = create_local_directories(
                    &root_dir,
                    plan.directories_to_create.clone(),
                    max_concurrency,
                )
                .await?;
                phase_timings.mkdir_ms += elapsed_millis_u64(mkdir_started_at);

                let bundle_key =
                    build_remote_path(&request.remote_prefix, INTERNAL_SYNC_BUNDLE_RELATIVE_PATH);
                let hydrate_result = maybe_hydrate_from_remote_sync_bundle(
                    &client,
                    &request.object_store,
                    &root_dir,
                    &bundle_key,
                    false,
                    request_counts.as_ref(),
                )
                .await?;
                record_hydrate_timings(&mut phase_timings, &hydrate_result);
                if hydrate_result.hydrated {
                    let manifest_files = manifest_document
                        .files
                        .iter()
                        .filter_map(|(relative_path, entry)| {
                            let normalized = normalize_relative_path(relative_path);
                            if normalized.is_empty()
                                || should_ignore_relative_path(&normalized)
                                || should_exclude_relative_path(&normalized, &excludes)
                            {
                                return None;
                            }
                            Some((normalized, entry.size, entry.mtime_ms))
                        })
                        .collect::<Vec<_>>();
                    let explicit_remote_directories = manifest_document
                        .empty_directories
                        .iter()
                        .map(|relative_path| normalize_relative_path(relative_path))
                        .filter(|relative_path| {
                            !relative_path.is_empty()
                                && !should_ignore_relative_path(relative_path)
                                && !should_exclude_relative_path(relative_path, &excludes)
                        })
                        .collect::<BTreeSet<_>>();
                    let remote_file_paths = manifest_files
                        .iter()
                        .map(|(relative_path, _, _)| relative_path.clone())
                        .collect::<BTreeSet<_>>();

                    let fingerprint_started_at = Instant::now();
                    let local_fingerprint = create_fingerprint_from_entries(
                        &manifest_files,
                        &resolve_empty_remote_directories(
                            &explicit_remote_directories,
                            &remote_file_paths,
                        ),
                    );
                    phase_timings.fingerprint_ms = elapsed_millis_u64(fingerprint_started_at);
                    phase_timings.total_command_ms = elapsed_millis_u64(command_started_at);
                    return Ok(SyncRemoteToLocalResponse {
                        ok: true,
                        protocol_version: PROTOCOL_VERSION,
                        local_fingerprint,
                        removed_path_count,
                        created_directory_count,
                        downloaded_file_count: manifest_files.len(),
                        request_counts: request_counts.snapshot(),
                        phase_timings: Some(phase_timings),
                    });
                }
            }
        }
    }

    let (remote_entries, has_sync_manifest, bundle_entry) = match request.remote_entries {
        Some(prefetched_remote_entries) => (
            prefetched_remote_entries,
            request.has_sync_manifest.unwrap_or(false),
            request.bundle_entry,
        ),
        None => {
            let listing_started_at = Instant::now();
            let remote_listing = list_remote_entries(
                &client,
                &request.object_store,
                &request.remote_prefix,
                request_counts.as_ref(),
            )
            .await?;
            phase_timings.listing_ms += elapsed_millis_u64(listing_started_at);
            (
                remote_listing.entries,
                remote_listing.has_sync_manifest,
                remote_listing.bundle_entry,
            )
        }
    };

    if let Some(bundle_entry) = bundle_entry.as_ref() {
        if should_attempt_sync_bundle_for_remote_entries(&remote_entries, sync_bundle_config) {
            let hydrate_result = maybe_hydrate_from_remote_sync_bundle(
                &client,
                &request.object_store,
                &root_dir,
                &bundle_entry.key,
                true,
                request_counts.as_ref(),
            )
            .await?;
            record_hydrate_timings(&mut phase_timings, &hydrate_result);
            if hydrate_result.hydrated {
                let fingerprint_started_at = Instant::now();
                let hydrated_snapshot = collect_snapshot(&root_dir, &excludes)?;
                let local_fingerprint = create_fingerprint(&hydrated_snapshot);
                phase_timings.fingerprint_ms = elapsed_millis_u64(fingerprint_started_at);
                phase_timings.total_command_ms = elapsed_millis_u64(command_started_at);
                return Ok(SyncRemoteToLocalResponse {
                    ok: true,
                    protocol_version: PROTOCOL_VERSION,
                    local_fingerprint,
                    removed_path_count: 0,
                    created_directory_count: 0,
                    downloaded_file_count: count_remote_file_entries(&remote_entries),
                    request_counts: request_counts.snapshot(),
                    phase_timings: Some(phase_timings),
                });
            }
        }
    }

    let manifest_read_started_at = Instant::now();
    let sync_manifest = Arc::new(
        load_remote_sync_manifest(
            &client,
            &request.object_store,
            &request.remote_prefix,
            has_sync_manifest,
            request_counts.as_ref(),
        )
        .await?,
    );
    phase_timings.manifest_read_ms += elapsed_millis_u64(manifest_read_started_at);
    let explicit_remote_directories = remote_entries
        .iter()
        .filter(|entry| entry.is_directory)
        .map(|entry| normalize_relative_path(&entry.relative_path))
        .filter(|relative_path| !relative_path.is_empty())
        .collect::<BTreeSet<_>>();
    let remote_file_paths = remote_entries
        .iter()
        .filter(|entry| !entry.is_directory)
        .map(|entry| normalize_relative_path(&entry.relative_path))
        .filter(|relative_path| !relative_path.is_empty())
        .collect::<BTreeSet<_>>();
    let plan_started_at = Instant::now();
    let plan = create_remote_to_local_plan(
        &root_dir,
        &snapshot,
        remote_entries,
        preserve_top_level_names,
    );
    phase_timings.plan_ms += elapsed_millis_u64(plan_started_at);

    let remove_started_at = Instant::now();
    let removed_path_count = remove_local_paths(plan.remove_paths.clone(), max_concurrency).await?;
    phase_timings.remove_ms += elapsed_millis_u64(remove_started_at);

    let mkdir_started_at = Instant::now();
    let created_directory_count = create_local_directories(
        &root_dir,
        plan.directories_to_create.clone(),
        max_concurrency,
    )
    .await?;
    phase_timings.mkdir_ms += elapsed_millis_u64(mkdir_started_at);

    let download_started_at = Instant::now();
    let downloaded_candidates = download_remote_candidates(
        &client,
        &request.object_store,
        Arc::clone(&request_counts),
        plan.download_candidates.clone(),
        max_concurrency,
    )
    .await?;
    phase_timings.download_ms += elapsed_millis_u64(download_started_at);

    let info_check_started_at = Instant::now();
    let info_checked_candidates = info_check_remote_candidates(
        &client,
        &request.object_store,
        Arc::clone(&sync_manifest),
        Arc::clone(&request_counts),
        plan.info_check_candidates.clone(),
        max_concurrency,
    )
    .await?;
    phase_timings.info_check_ms += elapsed_millis_u64(info_check_started_at);
    let downloaded_file_count = downloaded_candidates.len()
        + info_checked_candidates
            .iter()
            .filter(|candidate| candidate.downloaded)
            .count();
    let fingerprint_started_at = Instant::now();
    let local_fingerprint = create_fingerprint_from_entries(
        &downloaded_candidates
            .into_iter()
            .chain(info_checked_candidates.into_iter())
            .map(|candidate| (candidate.relative_path, candidate.size, candidate.mtime_ms))
            .collect::<Vec<_>>(),
        &resolve_empty_remote_directories(&explicit_remote_directories, &remote_file_paths),
    );
    phase_timings.fingerprint_ms = elapsed_millis_u64(fingerprint_started_at);
    phase_timings.total_command_ms = elapsed_millis_u64(command_started_at);

    Ok(SyncRemoteToLocalResponse {
        ok: true,
        protocol_version: PROTOCOL_VERSION,
        local_fingerprint,
        removed_path_count,
        created_directory_count,
        downloaded_file_count,
        request_counts: request_counts.snapshot(),
        phase_timings: Some(phase_timings),
    })
}

pub(crate) async fn sync_local_to_remote(
    request: SyncLocalToRemoteRequest,
) -> Result<SyncLocalToRemoteResponse, String> {
    let command_started_at = Instant::now();
    let excludes = normalize_exclude_paths(request.exclude_relative_paths);
    let max_concurrency = resolve_max_concurrency(request.max_concurrency);
    let inline_upload_threshold_bytes =
        resolve_inline_upload_threshold_bytes(request.inline_upload_threshold_bytes);
    let sync_bundle_config = resolve_sync_bundle_config(request.sync_bundle.as_ref());
    let root_dir = PathBuf::from(&request.root_dir);
    let scan_started_at = Instant::now();
    let snapshot = collect_snapshot(&root_dir, &excludes)?;
    let mut phase_timings = SyncLocalToRemotePhaseTimings {
        scan_ms: elapsed_millis_u64(scan_started_at),
        fingerprint_ms: 0,
        client_create_ms: 0,
        manifest_read_ms: 0,
        bundle_build_ms: 0,
        bundle_body_prepare_ms: 0,
        bundle_upload_ms: 0,
        bundle_transport: "none".to_string(),
        bundle_bytes: 0,
        manifest_write_ms: 0,
        delete_ms: 0,
        total_primary_path_ms: 0,
        total_command_ms: 0,
    };
    let fingerprint_started_at = Instant::now();
    let local_fingerprint = create_fingerprint(&snapshot);
    phase_timings.fingerprint_ms = elapsed_millis_u64(fingerprint_started_at);

    let client_create_started_at = Instant::now();
    let client = create_s3_client(&request.object_store);
    phase_timings.client_create_ms = elapsed_millis_u64(client_create_started_at);
    let request_counts = Arc::new(NativeObjectStoreRequestCounter::default());
    let snapshot_manifest_files = snapshot
        .files
        .iter()
        .map(|file| (file.relative_path.clone(), file.size, file.mtime_ms))
        .collect::<Vec<_>>();

    if sync_bundle_config.layout == SyncBundleLayout::Primary
        && should_attempt_sync_bundle_for_snapshot(&snapshot, sync_bundle_config)
    {
        let primary_path_started_at = Instant::now();
        let assume_empty_trusted_prefix =
            should_assume_empty_trusted_managed_prefix(&request.remote_prefix, sync_bundle_config);
        let existing_manifest_document = if assume_empty_trusted_prefix {
            None
        } else {
            let manifest_read_started_at = Instant::now();
            let document = load_remote_sync_manifest_document(
                &client,
                &request.object_store,
                &request.remote_prefix,
                request_counts.as_ref(),
            )
            .await?;
            phase_timings.manifest_read_ms = elapsed_millis_u64(manifest_read_started_at);
            document
        };
        let uploaded_file_count =
            count_snapshot_file_mutations(&snapshot, existing_manifest_document.as_ref());
        let deleted_remote_count =
            count_snapshot_deleted_files(&snapshot, existing_manifest_document.as_ref());
        let created_empty_directory_count = count_snapshot_created_empty_directories(
            &snapshot,
            existing_manifest_document.as_ref(),
        );
        let has_mutations = uploaded_file_count > 0
            || deleted_remote_count > 0
            || created_empty_directory_count > 0
            || !existing_manifest_document
                .as_ref()
                .map(is_primary_bundle_manifest)
                .unwrap_or(false);

        if has_mutations {
            let upload_result = upload_sync_bundle(
                &client,
                &request.object_store,
                &request.remote_prefix,
                &root_dir,
                &snapshot,
                &excludes,
                request_counts.as_ref(),
            )
            .await?;
            phase_timings.bundle_build_ms = upload_result.bundle_build_ms;
            phase_timings.bundle_body_prepare_ms = upload_result.bundle_body_prepare_ms;
            phase_timings.bundle_upload_ms = upload_result.bundle_upload_ms;
            phase_timings.bundle_transport = upload_result.bundle_transport.to_string();
            phase_timings.bundle_bytes = upload_result.bundle_bytes;

            let snapshot_file_paths = snapshot
                .files
                .iter()
                .map(|file| file.relative_path.as_str())
                .collect::<BTreeSet<_>>();
            let snapshot_empty_directories = snapshot
                .empty_directories
                .iter()
                .map(|relative_path| relative_path.as_str())
                .collect::<BTreeSet<_>>();

            let mut keys_to_delete =
                existing_manifest_document
                    .as_ref()
                    .map(|document| {
                        let remove_all_tracked_entries = !is_primary_bundle_manifest(document);
                        let mut keys = document
                            .files
                            .keys()
                            .filter(|relative_path| {
                                remove_all_tracked_entries
                                    || !snapshot_file_paths.contains(relative_path.as_str())
                            })
                            .map(|relative_path| {
                                build_remote_path(&request.remote_prefix, relative_path)
                            })
                            .collect::<Vec<_>>();
                        keys.extend(document.empty_directories.iter().filter_map(
                            |relative_path| {
                                let normalized = normalize_relative_path(relative_path);
                                if normalized.is_empty()
                                    || (!remove_all_tracked_entries
                                        && snapshot_empty_directories.contains(normalized.as_str()))
                                {
                                    return None;
                                }
                                Some(format!(
                                    "{}/",
                                    build_remote_path(&request.remote_prefix, &normalized)
                                ))
                            },
                        ));
                        keys
                    })
                    .unwrap_or_default();
            keys_to_delete.sort();
            keys_to_delete.dedup();

            if !keys_to_delete.is_empty() {
                let delete_started_at = Instant::now();
                for chunk in keys_to_delete.chunks(1000) {
                    if chunk.is_empty() {
                        continue;
                    }

                    let delete = Delete::builder()
                        .set_objects(Some(
                            chunk
                                .iter()
                                .map(|key| {
                                    ObjectIdentifier::builder()
                                        .key(key)
                                        .build()
                                        .map_err(|error| {
                                            format!(
                                                "Failed to prepare S3 delete object identifier: {error}"
                                            )
                                        })
                                })
                                .collect::<Result<Vec<_>, _>>()?,
                        ))
                        .build()
                        .map_err(|error| {
                            format!("Failed to prepare S3 delete request: {error}")
                        })?;

                    request_counts.increment_delete();
                    client
                        .delete_objects()
                        .bucket(&request.object_store.bucket)
                        .delete(delete)
                        .send()
                        .await
                        .map_err(|error| format!("Failed to delete S3 objects: {error}"))?;
                }
                phase_timings.delete_ms = elapsed_millis_u64(delete_started_at);
            }

            let manifest_write_started_at = Instant::now();
            write_remote_sync_manifest(
                &client,
                &request.object_store,
                &request.remote_prefix,
                &snapshot_manifest_files,
                &snapshot
                    .empty_directories
                    .iter()
                    .cloned()
                    .collect::<Vec<_>>(),
                Some("bundle"),
                existing_manifest_document.as_ref(),
                request_counts.as_ref(),
            )
            .await?;
            phase_timings.manifest_write_ms = elapsed_millis_u64(manifest_write_started_at);
        }

        mark_trusted_managed_prefix_seen(&request.remote_prefix);
        phase_timings.total_primary_path_ms = elapsed_millis_u64(primary_path_started_at);
        phase_timings.total_command_ms = elapsed_millis_u64(command_started_at);

        return Ok(SyncLocalToRemoteResponse {
            ok: true,
            protocol_version: PROTOCOL_VERSION,
            local_fingerprint,
            uploaded_file_count,
            deleted_remote_count,
            created_empty_directory_count,
            request_counts: request_counts.snapshot(),
            phase_timings: Some(phase_timings),
        });
    }

    let remote_listing = list_remote_entries(
        &client,
        &request.object_store,
        &request.remote_prefix,
        request_counts.as_ref(),
    )
    .await?;
    let remote_entries = remote_listing.entries;
    let bundle_entry = remote_listing.bundle_entry;
    let existing_manifest_document = if remote_listing.has_sync_manifest {
        load_remote_sync_manifest_document(
            &client,
            &request.object_store,
            &request.remote_prefix,
            request_counts.as_ref(),
        )
        .await?
    } else {
        None
    };
    let sync_manifest = Arc::new(
        existing_manifest_document
            .as_ref()
            .map(|document| {
                document
                    .files
                    .iter()
                    .filter_map(|(relative_path, entry)| {
                        let normalized = normalize_relative_path(relative_path);
                        if normalized.is_empty() || should_ignore_relative_path(&normalized) {
                            return None;
                        }
                        Some((normalized, entry.clone()))
                    })
                    .collect::<BTreeMap<_, _>>()
            })
            .unwrap_or_default(),
    );
    let remote_entries_by_relative_path = remote_entries
        .iter()
        .cloned()
        .map(|entry| (normalize_relative_path(&entry.relative_path), entry))
        .collect::<BTreeMap<_, _>>();
    let plan = create_local_to_remote_plan(&snapshot, remote_entries);

    let remote_entries_by_relative_path = Arc::new(remote_entries_by_relative_path);

    let uploaded_candidates = upload_local_candidates(
        &client,
        &request.object_store,
        &request.remote_prefix,
        Arc::clone(&request_counts),
        inline_upload_threshold_bytes,
        plan.upload_candidates.clone(),
        max_concurrency,
    )
    .await?;

    let info_checked_candidates = info_check_upload_candidates(
        &client,
        &request.object_store,
        &request.remote_prefix,
        Arc::clone(&remote_entries_by_relative_path),
        Arc::clone(&sync_manifest),
        Arc::clone(&request_counts),
        inline_upload_threshold_bytes,
        plan.info_check_candidates.clone(),
        max_concurrency,
    )
    .await?;

    let deleted_remote_count = plan.keys_to_delete.len();
    let uploaded_file_count = uploaded_candidates
        .into_iter()
        .filter(|uploaded| *uploaded)
        .count()
        + info_checked_candidates
            .into_iter()
            .filter(|uploaded| *uploaded)
            .count();

    let created_empty_directory_count = create_remote_empty_directories(
        &client,
        &request.object_store,
        &request.remote_prefix,
        Arc::clone(&request_counts),
        plan.empty_directories_to_create.clone(),
        max_concurrency,
    )
    .await?;

    let has_mutations =
        uploaded_file_count > 0 || deleted_remote_count > 0 || created_empty_directory_count > 0;

    for chunk in plan.keys_to_delete.chunks(1000) {
        if chunk.is_empty() {
            continue;
        }

        let delete = Delete::builder()
            .set_objects(Some(
                chunk
                    .iter()
                    .map(|key| {
                        ObjectIdentifier::builder()
                            .key(key)
                            .build()
                            .map_err(|error| {
                                format!("Failed to prepare S3 delete object identifier: {error}")
                            })
                    })
                    .collect::<Result<Vec<_>, _>>()?,
            ))
            .build()
            .map_err(|error| format!("Failed to prepare S3 delete request: {error}"))?;

        request_counts.increment_delete();
        client
            .delete_objects()
            .bucket(&request.object_store.bucket)
            .delete(delete)
            .send()
            .await
            .map_err(|error| format!("Failed to delete S3 objects: {error}"))?;
    }

    write_remote_sync_manifest(
        &client,
        &request.object_store,
        &request.remote_prefix,
        &snapshot_manifest_files,
        &snapshot
            .empty_directories
            .iter()
            .cloned()
            .collect::<Vec<_>>(),
        Some("objects"),
        existing_manifest_document.as_ref(),
        request_counts.as_ref(),
    )
    .await?;

    if has_mutations {
        if should_attempt_sync_bundle_for_snapshot(&snapshot, sync_bundle_config) {
            upload_sync_bundle(
                &client,
                &request.object_store,
                &request.remote_prefix,
                &root_dir,
                &snapshot,
                &excludes,
                request_counts.as_ref(),
            )
            .await?;
        } else if let Some(bundle_entry) = bundle_entry {
            delete_remote_object_if_present(
                &client,
                &request.object_store,
                &bundle_entry.key,
                request_counts.as_ref(),
            )
            .await?;
        }
    }

    prune_empty_local_directories(&root_dir).await?;
    phase_timings.total_command_ms = elapsed_millis_u64(command_started_at);
    Ok(SyncLocalToRemoteResponse {
        ok: true,
        protocol_version: PROTOCOL_VERSION,
        local_fingerprint,
        uploaded_file_count,
        deleted_remote_count,
        created_empty_directory_count,
        request_counts: request_counts.snapshot(),
        phase_timings: Some(phase_timings),
    })
}
