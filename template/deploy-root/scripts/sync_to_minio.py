#!/usr/bin/env python3

from __future__ import annotations

import argparse
import os
import subprocess
import sys
import time
from pathlib import Path

MANAGED_PATH_DIR_NAMES: dict[str, str] = {
    "workspace_dir": "workspaces",
    "runtime_dir": "runtimes",
    "model_dir": "models",
    "tool_dir": "tools",
    "skill_dir": "skills",
    "archive_dir": "archives",
}

REMOTE_PREFIX_BY_PATH_KEY: dict[str, str] = {
    "workspace_dir": "workspace",
    "runtime_dir": "runtime",
    "model_dir": "model",
    "tool_dir": "tool",
    "skill_dir": "skill",
    "archive_dir": "archive",
}


def default_root() -> str:
    return str(Path(__file__).resolve().parent.parent)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Sync OAH deploy-root source directories into an S3-compatible bucket via dockerized aws-cli."
    )
    parser.add_argument(
        "--root",
        default=os.environ.get("OAH_DEPLOY_ROOT") or default_root(),
        help=(
            "Deploy root directory. Defaults to $OAH_DEPLOY_ROOT or the parent of this script. "
            "Expected layout: <root>/source, <root>/scripts, <root>/server.docker.yaml."
        ),
    )
    parser.add_argument(
        "--bucket",
        default="test-oah-server",
        help="Target bucket name. Defaults to test-oah-server.",
    )
    parser.add_argument(
        "--aws-endpoint-url",
        default=os.environ.get("MINIO_AWS_ENDPOINT_URL", "http://host.docker.internal:9000"),
        help="S3-compatible endpoint reachable from the aws-cli Docker container.",
    )
    parser.add_argument(
        "--access-key",
        default=os.environ.get("MINIO_ROOT_USER", "oahadmin"),
        help="Object storage access key. Defaults to oahadmin.",
    )
    parser.add_argument(
        "--secret-key",
        default=os.environ.get("MINIO_ROOT_PASSWORD", "oahadmin123"),
        help="Object storage secret key. Defaults to oahadmin123.",
    )
    parser.add_argument(
        "--region",
        default=os.environ.get("AWS_REGION", "us-east-1"),
        help="AWS region passed to aws-cli. Defaults to us-east-1.",
    )
    parser.add_argument(
        "--source-root",
        default=None,
        help="Source directory root. Defaults to <root>/source.",
    )
    parser.add_argument(
        "--delete",
        action="store_true",
        help="Delete remote objects missing locally for readonly prefixes.",
    )
    parser.add_argument(
        "--include-workspaces",
        action="store_true",
        help="Also sync source/workspaces -> s3://.../workspace/.",
    )
    parser.add_argument(
        "--delete-workspaces",
        action="store_true",
        help="Allow --delete on the workspace prefix too. Requires --include-workspaces.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print the sync plan without executing aws-cli commands.",
    )
    parser.add_argument(
        "--retries",
        type=int,
        default=2,
        help="Retry count for transient docker/aws failures. Defaults to 2.",
    )
    args = parser.parse_args()

    if args.retries < 0:
        parser.error("--retries must be >= 0")
    if args.delete_workspaces and not args.include_workspaces:
        parser.error("--delete-workspaces requires --include-workspaces")

    return args


def aws_docker_command(
    aws_args: list[str],
    *,
    endpoint_url: str,
    access_key: str,
    secret_key: str,
    region: str,
    mount_dir: Path | None = None,
) -> list[str]:
    command = [
        "docker",
        "run",
        "--rm",
        "-e",
        f"AWS_ACCESS_KEY_ID={access_key}",
        "-e",
        f"AWS_SECRET_ACCESS_KEY={secret_key}",
        "-e",
        f"AWS_DEFAULT_REGION={region}",
    ]

    if mount_dir is not None:
        command.extend(["-v", f"{mount_dir}:/sync-source:ro"])

    command.extend(["amazon/aws-cli:latest", "--endpoint-url", endpoint_url, *aws_args])
    return command


def run_command(command: list[str], *, dry_run: bool, retries: int, context_label: str) -> None:
    printable = " ".join(subprocess.list2cmdline([part]) for part in command)

    for attempt in range(retries + 1):
        print(f"$ {printable}")
        if dry_run:
            return

        result = subprocess.run(command)
        if result.returncode == 0:
            return

        if attempt == retries:
            raise SystemExit(result.returncode)

        wait_seconds = attempt + 1
        print(
            f"{context_label} failed (attempt {attempt + 1}/{retries + 1}). Retrying in {wait_seconds}s...",
            file=sys.stderr,
        )
        time.sleep(wait_seconds)


def ensure_bucket(args: argparse.Namespace) -> None:
    head_cmd = aws_docker_command(
        ["s3api", "head-bucket", "--bucket", args.bucket],
        endpoint_url=args.aws_endpoint_url,
        access_key=args.access_key,
        secret_key=args.secret_key,
        region=args.region,
    )

    if args.dry_run:
        print(f"Would ensure bucket exists: {args.bucket}")
        return

    result = subprocess.run(head_cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if result.returncode == 0:
        print(f"Bucket already exists: {args.bucket}")
        return

    create_cmd = aws_docker_command(
        ["s3api", "create-bucket", "--bucket", args.bucket],
        endpoint_url=args.aws_endpoint_url,
        access_key=args.access_key,
        secret_key=args.secret_key,
        region=args.region,
    )
    run_command(create_cmd, dry_run=False, retries=args.retries, context_label="create-bucket")


def load_publish_paths(root: Path, source_root: Path | None) -> dict[str, Path]:
    resolved_source_root = source_root or (root / "source").resolve()
    return {
        path_key: (resolved_source_root / directory_name).resolve()
        for path_key, directory_name in MANAGED_PATH_DIR_NAMES.items()
    }


def sync_directory(args: argparse.Namespace, path_key: str, directory: Path) -> None:
    remote_prefix = REMOTE_PREFIX_BY_PATH_KEY[path_key]

    if path_key == "workspace_dir" and not args.include_workspaces:
        print(f"Skipping {directory} -> s3://{args.bucket}/{remote_prefix}/ (workspace sync is opt-in).")
        return

    if not directory.exists():
        print(f"Skipping missing directory for {path_key}: {directory}")
        return

    if not directory.is_dir():
        print(f"Skipping non-directory path for {path_key}: {directory}")
        return

    sync_args = [
        "s3",
        "sync",
        "/sync-source",
        f"s3://{args.bucket}/{remote_prefix}/",
        "--exclude",
        ".DS_Store",
        "--exclude",
        "*/.DS_Store",
        "--exclude",
        "__pycache__/*",
        "--exclude",
        "*/__pycache__/*",
        "--exclude",
        "*.pyc",
        "--exclude",
        "*.db-shm",
        "--exclude",
        "*.db-wal",
    ]

    allow_delete = args.delete and (path_key != "workspace_dir" or args.delete_workspaces)
    if allow_delete:
        sync_args.append("--delete")

    sync_cmd = aws_docker_command(
        sync_args,
        endpoint_url=args.aws_endpoint_url,
        access_key=args.access_key,
        secret_key=args.secret_key,
        region=args.region,
        mount_dir=directory,
    )
    run_command(sync_cmd, dry_run=args.dry_run, retries=args.retries, context_label=f"sync {path_key}")


def main() -> int:
    args = parse_args()
    root = Path(args.root).expanduser().resolve()
    if not root.exists():
        raise SystemExit(f"Deploy root not found: {root}")

    source_root = Path(args.source_root).expanduser().resolve() if args.source_root else None
    path_map = load_publish_paths(root, source_root)

    print(f"Deploy root: {root}")
    print(f"Docker aws-cli endpoint: {args.aws_endpoint_url}")
    print(f"Target bucket: {args.bucket}")
    print(f"Source root: {source_root or (root / 'source').resolve()}")

    ensure_bucket(args)
    for path_key, directory in path_map.items():
        sync_directory(args, path_key, directory)

    print("Sync complete.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
