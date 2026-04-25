use std::collections::BTreeSet;
use std::path::PathBuf;
use std::sync::Arc;

use crate::path_rules::{build_remote_path, normalize_exclude_paths};
use crate::plan::create_seed_upload_plan;
use crate::protocol::{
    SyncLocalToSandboxHttpRequest, SyncLocalToSandboxHttpResponse, PROTOCOL_VERSION,
};
use crate::sandbox_http::{
    prune_unexpected_remote_sandbox_entries, sandbox_file_matches, NativeSandboxHttpClient,
};
use crate::snapshot::{collect_snapshot, create_fingerprint};
use crate::sync_operations::process_with_concurrency;

pub(crate) async fn sync_local_to_sandbox_http(
    request: SyncLocalToSandboxHttpRequest,
) -> Result<SyncLocalToSandboxHttpResponse, String> {
    let excludes = normalize_exclude_paths(request.exclude_relative_paths);
    let max_concurrency = crate::resolve_max_concurrency(request.max_concurrency);
    let snapshot = collect_snapshot(&PathBuf::from(&request.root_dir), &excludes)?;
    let local_fingerprint = create_fingerprint(&snapshot);
    let plan = create_seed_upload_plan(&snapshot, &request.remote_root_path);
    let empty_directories_to_create = snapshot
        .empty_directories
        .iter()
        .map(|relative_path| build_remote_path(&request.remote_root_path, relative_path))
        .collect::<BTreeSet<_>>();
    let sandbox_client = NativeSandboxHttpClient::new(&request.sandbox)?;

    let root_path = request.remote_root_path.clone();
    let root_directory_exists =
        if let Some(existing_root) = sandbox_client.stat_path(&root_path).await? {
            if existing_root.kind != "directory" {
                sandbox_client.delete_entry(&root_path, true).await?;
                false
            } else {
                true
            }
        } else {
            false
        };
    if !root_directory_exists {
        sandbox_client.create_directory(&root_path).await?;
    }
    let expected_directories = plan.directories.iter().cloned().collect::<BTreeSet<_>>();
    let expected_files = plan
        .files
        .iter()
        .map(|file| file.remote_path.clone())
        .collect::<BTreeSet<_>>();
    let remote_state = prune_unexpected_remote_sandbox_entries(
        &sandbox_client,
        &root_path,
        &expected_directories,
        &expected_files,
    )
    .await?;
    let directories_to_create = empty_directories_to_create
        .iter()
        .filter(|remote_path| !remote_state.existing_directories.contains(*remote_path))
        .cloned()
        .collect::<Vec<_>>();

    let sandbox_client_for_directories = sandbox_client.clone();
    let created_directory_count =
        process_with_concurrency(directories_to_create, max_concurrency, move |remote_path| {
            let sandbox_client = sandbox_client_for_directories.clone();
            async move {
                sandbox_client.create_directory(&remote_path).await?;
                Ok(true)
            }
        })
        .await?
        .len()
            + if root_directory_exists { 0 } else { 1 };

    let sandbox_client_for_uploads = sandbox_client.clone();
    let remote_file_stats = Arc::new(remote_state.existing_file_stats);
    let uploaded_file_count =
        process_with_concurrency(plan.files.clone(), max_concurrency, move |file| {
            let sandbox_client = sandbox_client_for_uploads.clone();
            let remote_file_stats = Arc::clone(&remote_file_stats);
            async move {
                if let Some(remote_stat) = remote_file_stats.get(&file.remote_path) {
                    if sandbox_file_matches(file.size, file.mtime_ms, remote_stat) {
                        return Ok(false);
                    }
                }
                let data = tokio::fs::read(&file.absolute_path)
                    .await
                    .map_err(|error| {
                        format!(
                            "Failed to read local file {} for sandbox upload: {error}",
                            file.absolute_path
                        )
                    })?;
                sandbox_client
                    .upload_file(&file.remote_path, data, file.mtime_ms)
                    .await?;
                Ok(true)
            }
        })
        .await?
        .into_iter()
        .filter(|uploaded| *uploaded)
        .count();

    Ok(SyncLocalToSandboxHttpResponse {
        ok: true,
        protocol_version: PROTOCOL_VERSION,
        local_fingerprint,
        created_directory_count,
        uploaded_file_count,
    })
}
