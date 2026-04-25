use crate::manifest::PlanRemoteEntry;
use crate::path_rules::{build_remote_path, normalize_path, should_ignore_relative_path};
use crate::plan::{
    create_local_to_remote_plan, create_remote_to_local_plan, create_seed_upload_plan,
};
use crate::protocol::{handle_worker_request, WorkerRequest, BINARY_NAME, PROTOCOL_VERSION};
use crate::sandbox_http::{
    sandbox_entry_file_stat, sandbox_file_matches, sandbox_mtime_matches,
    should_keep_remote_sandbox_entry, NativeSandboxHttpEntry, NativeSandboxHttpFileStat,
};
use crate::seed_archive::{build_seed_archive, BuildSeedArchiveRequest};
use crate::snapshot::{collect_snapshot, create_fingerprint, FileEntry, Snapshot};
use crate::sync_bundle::build_local_sync_bundle_to_memory_blocking;
use serde_json::Value;
use std::collections::BTreeSet;
use std::fs;
use std::io::Cursor;
use std::path::Path;

fn make_snapshot() -> Snapshot {
    let mut directories = BTreeSet::new();
    directories.insert("foo".to_string());
    directories.insert("foo/nested".to_string());
    directories.insert("keep".to_string());

    Snapshot {
        files: vec![
            FileEntry {
                relative_path: "foo/a.txt".to_string(),
                absolute_path: "/workspace/foo/a.txt".to_string(),
                size: 10,
                mtime_ms: 1000,
                mode: 0o644,
            },
            FileEntry {
                relative_path: "orphan.txt".to_string(),
                absolute_path: "/workspace/orphan.txt".to_string(),
                size: 4,
                mtime_ms: 2000,
                mode: 0o644,
            },
            FileEntry {
                relative_path: "keep/child.txt".to_string(),
                absolute_path: "/workspace/keep/child.txt".to_string(),
                size: 6,
                mtime_ms: 3000,
                mode: 0o644,
            },
        ],
        files_sorted_by_relative_path: false,
        directories,
        empty_directories: BTreeSet::new(),
        ignored_paths: vec!["/workspace/.DS_Store".to_string()],
    }
}

#[test]
fn fingerprint_matches_when_snapshot_files_are_marked_sorted() {
    let mut unsorted_snapshot = make_snapshot();
    unsorted_snapshot.files.reverse();
    unsorted_snapshot.files_sorted_by_relative_path = false;

    let mut sorted_snapshot = make_snapshot();
    sorted_snapshot
        .files
        .sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
    sorted_snapshot.files_sorted_by_relative_path = true;

    assert_eq!(
        create_fingerprint(&unsorted_snapshot),
        create_fingerprint(&sorted_snapshot)
    );
}

#[test]
fn local_to_remote_plan_splits_uploads_and_deletes() {
    let snapshot = make_snapshot();
    let plan = create_local_to_remote_plan(
        &snapshot,
        vec![
            PlanRemoteEntry {
                relative_path: "foo/a.txt".to_string(),
                key: "prefix/foo/a.txt".to_string(),
                size: 10,
                last_modified_ms: Some(1000),
                is_directory: false,
            },
            PlanRemoteEntry {
                relative_path: "unused.txt".to_string(),
                key: "prefix/unused.txt".to_string(),
                size: 5,
                last_modified_ms: Some(1000),
                is_directory: false,
            },
        ],
    );

    assert_eq!(plan.upload_candidates.len(), 2);
    assert_eq!(plan.upload_candidates[0].relative_path, "keep/child.txt");
    assert_eq!(plan.upload_candidates[1].relative_path, "orphan.txt");
    assert_eq!(plan.info_check_candidates.len(), 1);
    assert_eq!(plan.info_check_candidates[0].relative_path, "foo/a.txt");
    assert_eq!(plan.keys_to_delete, vec!["prefix/unused.txt".to_string()]);
}

#[test]
fn remote_to_local_plan_emits_downloads_and_removals() {
    let snapshot = make_snapshot();
    let plan = create_remote_to_local_plan(
        Path::new("/workspace"),
        &snapshot,
        vec![
            PlanRemoteEntry {
                relative_path: "foo/a.txt".to_string(),
                key: "prefix/foo/a.txt".to_string(),
                size: 10,
                last_modified_ms: Some(1000),
                is_directory: false,
            },
            PlanRemoteEntry {
                relative_path: "foo/b.txt".to_string(),
                key: "prefix/foo/b.txt".to_string(),
                size: 8,
                last_modified_ms: Some(1000),
                is_directory: false,
            },
        ],
        vec!["keep".to_string()],
    );

    assert_eq!(plan.download_candidates.len(), 1);
    assert_eq!(plan.download_candidates[0].relative_path, "foo/b.txt");
    assert_eq!(plan.info_check_candidates.len(), 1);
    assert_eq!(plan.info_check_candidates[0].relative_path, "foo/a.txt");
    assert!(plan
        .remove_paths
        .contains(&"/workspace/.DS_Store".to_string()));
    assert!(plan
        .remove_paths
        .contains(&"/workspace/orphan.txt".to_string()));
    assert!(plan
        .remove_paths
        .contains(&"/workspace/foo/nested".to_string()));
    assert!(!plan.remove_paths.contains(&"/workspace/keep".to_string()));
    assert!(!plan
        .remove_paths
        .contains(&"/workspace/keep/child.txt".to_string()));
}

#[test]
fn seed_upload_plan_maps_remote_paths_and_orders_parent_directories_first() {
    let snapshot = make_snapshot();
    let plan = create_seed_upload_plan(&snapshot, "/workspace/root/");

    assert_eq!(
        plan.directories,
        vec![
            "/workspace/root/foo".to_string(),
            "/workspace/root/keep".to_string(),
            "/workspace/root/foo/nested".to_string(),
        ]
    );
    assert_eq!(plan.files.len(), 3);
    assert_eq!(plan.files[0].remote_path, "/workspace/root/foo/a.txt");
    assert_eq!(plan.files[1].remote_path, "/workspace/root/keep/child.txt");
    assert_eq!(plan.files[2].remote_path, "/workspace/root/orphan.txt");
    assert_eq!(plan.files[1].mtime_ms, 3000);
}

#[test]
fn build_seed_archive_writes_tar_and_ignores_runtime_junk() {
    let temp = tempfile::tempdir().expect("tempdir");
    let root = temp.path().join("workspace");
    fs::create_dir_all(root.join("src")).expect("src");
    fs::create_dir_all(root.join("empty")).expect("empty");
    fs::create_dir_all(root.join("__pycache__")).expect("pycache");
    fs::write(root.join("src").join("main.txt"), "hello").expect("main");
    fs::write(root.join(".DS_Store"), "junk").expect("ds store");
    fs::write(root.join("__pycache__").join("main.pyc"), "junk").expect("pyc");

    let archive_path = temp.path().join("workspace-seed.tar");
    let response = build_seed_archive(
        BuildSeedArchiveRequest {
            root_dir: normalize_path(&root),
            archive_path: normalize_path(&archive_path),
        },
        PROTOCOL_VERSION,
    )
    .expect("build seed archive");

    assert_eq!(response.file_count, 1);
    assert_eq!(response.empty_directory_count, 1);
    assert!(response.archive_bytes > 0);

    let archive_file = fs::File::open(&archive_path).expect("archive");
    let mut archive = tar::Archive::new(archive_file);
    let names = archive
        .entries()
        .expect("entries")
        .map(|entry| {
            entry
                .expect("entry")
                .path()
                .expect("path")
                .to_string_lossy()
                .to_string()
        })
        .collect::<Vec<_>>();
    let normalized_names = names
        .iter()
        .map(|name| name.trim_end_matches('/').to_string())
        .collect::<Vec<_>>();

    assert!(normalized_names.contains(&"src/main.txt".to_string()));
    assert!(normalized_names.contains(&"empty".to_string()));
    assert!(!names.iter().any(|name| name.contains(".DS_Store")));
    assert!(!names.iter().any(|name| name.contains("__pycache__")));
}

#[test]
fn sync_bundle_from_snapshot_uses_filtered_entries() {
    let temp = tempfile::tempdir().expect("tempdir");
    let root = temp.path().join("workspace");
    fs::create_dir_all(root.join("src")).expect("src");
    fs::create_dir_all(root.join("empty")).expect("empty");
    fs::create_dir_all(root.join("__pycache__")).expect("pycache");
    fs::write(root.join("src").join("main.txt"), "hello").expect("main");
    fs::write(root.join(".DS_Store"), "junk").expect("ds store");
    fs::write(root.join("__pycache__").join("main.pyc"), "junk").expect("pyc");

    let snapshot = collect_snapshot(&root, &[]).expect("snapshot");
    let mut files = snapshot.files.clone();
    files.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
    let empty_directories = snapshot
        .empty_directories
        .iter()
        .cloned()
        .collect::<Vec<_>>();
    let bundle_bytes =
        build_local_sync_bundle_to_memory_blocking(&files, &empty_directories).expect("bundle");

    let mut archive = tar::Archive::new(Cursor::new(bundle_bytes));
    let names = archive
        .entries()
        .expect("entries")
        .map(|entry| {
            entry
                .expect("entry")
                .path()
                .expect("path")
                .to_string_lossy()
                .to_string()
        })
        .collect::<Vec<_>>();
    let normalized_names = names
        .iter()
        .map(|name| name.trim_end_matches('/').to_string())
        .collect::<Vec<_>>();

    assert!(normalized_names.contains(&"src/main.txt".to_string()));
    assert!(normalized_names.contains(&"empty".to_string()));
    assert!(!names.iter().any(|name| name.contains(".DS_Store")));
    assert!(!names.iter().any(|name| name.contains("__pycache__")));
}

#[test]
fn build_remote_path_trims_duplicate_separators() {
    assert_eq!(
        build_remote_path("/seed/workspace/", "/nested/file.txt"),
        "/seed/workspace/nested/file.txt"
    );
    assert_eq!(build_remote_path("", "/nested/file.txt"), "nested/file.txt");
    assert_eq!(build_remote_path("/seed/workspace/", ""), "/seed/workspace");
}

#[test]
fn ignore_internal_sync_sidecars() {
    assert!(should_ignore_relative_path(".oah-sync-manifest.json"));
    assert!(should_ignore_relative_path(".oah-sync-bundle.tar"));
    assert!(!should_ignore_relative_path("README.md"));
}

#[test]
fn sandbox_file_match_tolerates_sub_millisecond_mtime_drift() {
    let remote = NativeSandboxHttpFileStat {
        kind: "file".to_string(),
        size: 12,
        mtime_ms: 1_234.6,
    };

    assert!(sandbox_file_matches(12, 1_234, &remote));
    assert!(!sandbox_file_matches(11, 1_234, &remote));
    assert!(!sandbox_file_matches(12, 1_236, &remote));
}

#[test]
fn remote_sandbox_entry_keep_logic_respects_type_mismatches() {
    let expected_directories =
        BTreeSet::from(["/workspace".to_string(), "/workspace/nested".to_string()]);
    let expected_files = BTreeSet::from(["/workspace/README.md".to_string()]);

    assert!(should_keep_remote_sandbox_entry(
        &NativeSandboxHttpEntry {
            path: "/workspace/nested".to_string(),
            entry_type: "directory".to_string(),
            size_bytes: None,
            updated_at: None,
        },
        &expected_directories,
        &expected_files,
    ));
    assert!(should_keep_remote_sandbox_entry(
        &NativeSandboxHttpEntry {
            path: "/workspace/README.md".to_string(),
            entry_type: "file".to_string(),
            size_bytes: Some(12),
            updated_at: Some("2026-04-24T00:00:00.000Z".to_string()),
        },
        &expected_directories,
        &expected_files,
    ));
    assert!(!should_keep_remote_sandbox_entry(
        &NativeSandboxHttpEntry {
            path: "/workspace/nested".to_string(),
            entry_type: "file".to_string(),
            size_bytes: Some(12),
            updated_at: Some("2026-04-24T00:00:00.000Z".to_string()),
        },
        &expected_directories,
        &expected_files,
    ));
    assert!(!should_keep_remote_sandbox_entry(
        &NativeSandboxHttpEntry {
            path: "/workspace/stale.txt".to_string(),
            entry_type: "file".to_string(),
            size_bytes: Some(12),
            updated_at: Some("2026-04-24T00:00:00.000Z".to_string()),
        },
        &expected_directories,
        &expected_files,
    ));
}

#[test]
fn sandbox_entry_file_stat_uses_listing_metadata() {
    let entry = NativeSandboxHttpEntry {
        path: "/workspace/README.md".to_string(),
        entry_type: "file".to_string(),
        size_bytes: Some(12),
        updated_at: Some("2026-04-24T00:00:00.500Z".to_string()),
    };

    let stat = sandbox_entry_file_stat(&entry).expect("expected file stat");
    assert_eq!(stat.kind, "file");
    assert_eq!(stat.size, 12);
    assert!(sandbox_mtime_matches(1_776_988_800_500, stat.mtime_ms));
}

#[test]
fn worker_request_executes_version_command_and_includes_request_id() {
    let mut runtime = None;
    let response = handle_worker_request(
        WorkerRequest {
            request_id: "req_1".to_string(),
            command: "version".to_string(),
            payload: None,
            sent_at_ms: None,
        },
        &mut runtime,
    );

    assert_eq!(response.get("ok").and_then(Value::as_bool), Some(true));
    assert_eq!(
        response.get("requestId").and_then(Value::as_str),
        Some("req_1")
    );
    assert_eq!(
        response.get("name").and_then(Value::as_str),
        Some(BINARY_NAME)
    );
}

#[test]
fn worker_request_reports_unknown_command_error() {
    let mut runtime = None;
    let response = handle_worker_request(
        WorkerRequest {
            request_id: "req_2".to_string(),
            command: "unknown".to_string(),
            payload: None,
            sent_at_ms: None,
        },
        &mut runtime,
    );

    assert_eq!(response.get("ok").and_then(Value::as_bool), Some(false));
    assert_eq!(
        response.get("requestId").and_then(Value::as_str),
        Some("req_2")
    );
    assert!(response
        .get("message")
        .and_then(Value::as_str)
        .is_some_and(|message| message.contains("Unknown command")));
}
