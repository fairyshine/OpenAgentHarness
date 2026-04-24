use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use clap::{Parser, Subcommand};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

const PROTOCOL_VERSION: u32 = 1;
const BINARY_NAME: &str = "oah-archive-export";
const BINARY_VERSION: &str = env!("CARGO_PKG_VERSION");

const ARCHIVE_SCHEMA_STATEMENTS: [&str; 10] = [
    r#"create table if not exists archive_manifest (
    archive_date text primary key,
    timezone text not null,
    exported_at text not null,
    archive_count integer not null
  )"#,
    r#"create table if not exists archives (
    archive_id text primary key,
    workspace_id text not null,
    scope_type text not null,
    scope_id text not null,
    archive_date text not null,
    archived_at text not null,
    deleted_at text not null,
    timezone text not null,
    exported_at text,
    export_path text,
    workspace_name text not null,
    root_path text not null,
    workspace_snapshot text not null
  )"#,
    r#"create table if not exists sessions (
    archive_id text not null,
    id text not null,
    workspace_id text not null,
    subject_ref text not null,
    model_ref text,
    agent_name text,
    active_agent_name text not null,
    title text,
    status text not null,
    last_run_at text,
    created_at text not null,
    updated_at text not null,
    payload text not null,
    primary key (archive_id, id)
  )"#,
    r#"create table if not exists runs (
    archive_id text not null,
    id text not null,
    workspace_id text not null,
    session_id text,
    parent_run_id text,
    trigger_type text not null,
    trigger_ref text,
    agent_name text,
    effective_agent_name text not null,
    status text not null,
    created_at text not null,
    started_at text,
    heartbeat_at text,
    ended_at text,
    payload text not null,
    primary key (archive_id, id)
  )"#,
    r#"create table if not exists messages (
    archive_id text not null,
    id text not null,
    session_id text not null,
    run_id text,
    role text not null,
    created_at text not null,
    content text not null,
    metadata text,
    primary key (archive_id, id)
  )"#,
    r#"create table if not exists runtime_messages (
    archive_id text not null,
    id text not null,
    session_id text not null,
    run_id text,
    role text not null,
    kind text not null,
    created_at text not null,
    content text not null,
    metadata text,
    primary key (archive_id, id)
  )"#,
    r#"create table if not exists run_steps (
    archive_id text not null,
    id text not null,
    run_id text not null,
    seq integer not null,
    step_type text not null,
    name text,
    agent_name text,
    status text not null,
    started_at text,
    ended_at text,
    input text,
    output text,
    primary key (archive_id, id)
  )"#,
    r#"create table if not exists tool_calls (
    archive_id text not null,
    id text not null,
    run_id text not null,
    step_id text,
    source_type text not null,
    tool_name text not null,
    status text not null,
    duration_ms integer,
    started_at text not null,
    ended_at text not null,
    request text,
    response text,
    primary key (archive_id, id)
  )"#,
    r#"create table if not exists hook_runs (
    archive_id text not null,
    id text not null,
    run_id text not null,
    hook_name text not null,
    event_name text not null,
    status text not null,
    started_at text not null,
    ended_at text not null,
    capabilities text not null,
    patch text,
    error_message text,
    primary key (archive_id, id)
  )"#,
    r#"create table if not exists artifacts (
    archive_id text not null,
    id text not null,
    run_id text not null,
    type text not null,
    path text,
    content_ref text,
    created_at text not null,
    metadata text,
    primary key (archive_id, id)
  )"#,
];

#[derive(Parser)]
#[command(name = BINARY_NAME, version = BINARY_VERSION, about = "Open Agent Harness native archive export utilities.")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    Version,
    InspectExportRoot,
    WriteChecksum,
    WriteBundle,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct VersionResponse<'a> {
    ok: bool,
    protocol_version: u32,
    name: &'a str,
    version: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ErrorResponse {
    ok: bool,
    protocol_version: u32,
    code: &'static str,
    message: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct InspectExportRootRequest {
    export_root: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct InspectExportRootResponse {
    ok: bool,
    protocol_version: u32,
    unexpected_directories: Vec<String>,
    leftover_temp_files: Vec<String>,
    unexpected_files: Vec<String>,
    missing_checksums: Vec<String>,
    orphan_checksums: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WriteChecksumRequest {
    file_path: String,
    output_path: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WriteChecksumResponse {
    ok: bool,
    protocol_version: u32,
    file_path: String,
    output_path: String,
    checksum: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WriteBundleRequest {
    output_path: String,
    archive_date: String,
    export_path: String,
    exported_at: String,
    archives: Vec<Value>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WriteBundleResponse {
    ok: bool,
    protocol_version: u32,
    output_path: String,
    archive_date: String,
    archive_count: usize,
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    match run(cli.command) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            let response = ErrorResponse {
                ok: false,
                protocol_version: PROTOCOL_VERSION,
                code: "archive_export_failed",
                message: error,
            };
            let _ = serde_json::to_writer(io::stderr(), &response);
            eprintln!();
            ExitCode::FAILURE
        }
    }
}

fn run(command: Command) -> Result<(), String> {
    match command {
        Command::Version => write_json(&VersionResponse {
            ok: true,
            protocol_version: PROTOCOL_VERSION,
            name: BINARY_NAME,
            version: BINARY_VERSION,
        }),
        Command::InspectExportRoot => {
            let request: InspectExportRootRequest = read_stdin_json()?;
            let inspection = inspect_export_root(Path::new(&request.export_root))?;
            write_json(&InspectExportRootResponse {
                ok: true,
                protocol_version: PROTOCOL_VERSION,
                unexpected_directories: inspection.unexpected_directories,
                leftover_temp_files: inspection.leftover_temp_files,
                unexpected_files: inspection.unexpected_files,
                missing_checksums: inspection.missing_checksums,
                orphan_checksums: inspection.orphan_checksums,
            })
        }
        Command::WriteChecksum => {
            let request: WriteChecksumRequest = read_stdin_json()?;
            let file_path = PathBuf::from(&request.file_path);
            let output_path = request
                .output_path
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from(format!("{}.sha256", request.file_path)));
            let checksum = sha256_file(&file_path)?;
            let file_name = file_path
                .file_name()
                .and_then(|value| value.to_str())
                .ok_or_else(|| format!("Failed to derive archive file name from {}.", file_path.display()))?;
            fs::write(&output_path, format!("{checksum}  {file_name}\n"))
                .map_err(|error| format!("Failed to write checksum file {}: {error}", output_path.display()))?;

            write_json(&WriteChecksumResponse {
                ok: true,
                protocol_version: PROTOCOL_VERSION,
                file_path: file_path.to_string_lossy().to_string(),
                output_path: output_path.to_string_lossy().to_string(),
                checksum,
            })
        }
        Command::WriteBundle => {
            let request: WriteBundleRequest = read_stdin_json()?;
            write_bundle(&request)?;
            write_json(&WriteBundleResponse {
                ok: true,
                protocol_version: PROTOCOL_VERSION,
                output_path: request.output_path,
                archive_date: request.archive_date,
                archive_count: request.archives.len(),
            })
        }
    }
}

fn read_stdin_json<T: for<'de> Deserialize<'de>>() -> Result<T, String> {
    let mut input = String::new();
    io::stdin()
        .read_to_string(&mut input)
        .map_err(|error| format!("Failed to read stdin: {error}"))?;
    serde_json::from_str(&input).map_err(|error| format!("Failed to parse stdin JSON: {error}"))
}

fn write_json<T: Serialize>(value: &T) -> Result<(), String> {
    serde_json::to_writer(io::stdout(), value).map_err(|error| format!("Failed to write stdout JSON: {error}"))?;
    println!();
    Ok(())
}

struct ArchiveDirectoryInspection {
    unexpected_directories: Vec<String>,
    leftover_temp_files: Vec<String>,
    unexpected_files: Vec<String>,
    missing_checksums: Vec<String>,
    orphan_checksums: Vec<String>,
}

fn inspect_export_root(export_root: &Path) -> Result<ArchiveDirectoryInspection, String> {
    let entries = match fs::read_dir(export_root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Ok(ArchiveDirectoryInspection {
                unexpected_directories: Vec::new(),
                leftover_temp_files: Vec::new(),
                unexpected_files: Vec::new(),
                missing_checksums: Vec::new(),
                orphan_checksums: Vec::new(),
            })
        }
        Err(error) => {
            return Err(format!(
                "Failed to inspect archive export directory {}: {error}",
                export_root.display()
            ))
        }
    };

    let mut unexpected_directories = Vec::new();
    let mut leftover_temp_files = Vec::new();
    let mut unexpected_files = Vec::new();
    let mut bundle_names = Vec::new();
    let mut checksum_names = Vec::new();

    for entry in entries {
        let entry = entry.map_err(|error| format!("Failed to read archive export directory entry: {error}"))?;
        let name = entry.file_name().to_string_lossy().to_string();
        let file_type = entry
            .file_type()
            .map_err(|error| format!("Failed to inspect archive export entry type for {name}: {error}"))?;

        if file_type.is_dir() {
            unexpected_directories.push(name);
            continue;
        }

        if name.ends_with(".tmp") {
            leftover_temp_files.push(name);
            continue;
        }

        if is_archive_bundle_name(&name) {
            bundle_names.push(name);
            continue;
        }

        if is_archive_checksum_name(&name) {
            checksum_names.push(name);
            continue;
        }

        unexpected_files.push(name);
    }

    bundle_names.sort();
    checksum_names.sort();
    let mut missing_checksums = Vec::new();
    for bundle_name in &bundle_names {
        let checksum_name = format!("{bundle_name}.sha256");
        if !checksum_names.iter().any(|candidate| candidate == &checksum_name) {
            missing_checksums.push(bundle_name.clone());
        }
    }

    let mut orphan_checksums = Vec::new();
    for checksum_name in &checksum_names {
        let bundle_name = checksum_name.strip_suffix(".sha256").unwrap_or(checksum_name);
        if !bundle_names.iter().any(|candidate| candidate == bundle_name) {
            orphan_checksums.push(checksum_name.clone());
        }
    }

    unexpected_directories.sort();
    leftover_temp_files.sort();
    unexpected_files.sort();

    Ok(ArchiveDirectoryInspection {
        unexpected_directories,
        leftover_temp_files,
        unexpected_files,
        missing_checksums,
        orphan_checksums,
    })
}

fn write_bundle(request: &WriteBundleRequest) -> Result<(), String> {
    let output_path = PathBuf::from(&request.output_path);
    if let Some(parent) = output_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create archive export directory {}: {error}", parent.display()))?;
    }

    match fs::remove_file(&output_path) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(format!(
                "Failed to clear previous archive bundle {}: {error}",
                output_path.display()
            ))
        }
    }

    let mut connection = Connection::open(&output_path)
        .map_err(|error| format!("Failed to open archive sqlite bundle {}: {error}", output_path.display()))?;
    apply_archive_schema(&connection)?;

    let transaction = connection
        .transaction()
        .map_err(|error| format!("Failed to open archive sqlite transaction: {error}"))?;
    insert_archive_rows(
        &transaction,
        &request.archive_date,
        &request.export_path,
        &request.exported_at,
        &request.archives,
    )?;
    transaction
        .commit()
        .map_err(|error| format!("Failed to commit archive sqlite transaction: {error}"))?;

    Ok(())
}

fn apply_archive_schema(connection: &Connection) -> Result<(), String> {
    for statement in ARCHIVE_SCHEMA_STATEMENTS {
        connection
            .execute(statement, [])
            .map_err(|error| format!("Failed to apply archive sqlite schema: {error}"))?;
    }

    Ok(())
}

fn insert_archive_rows(
    connection: &Connection,
    archive_date: &str,
    export_path: &str,
    exported_at: &str,
    archives: &[Value],
) -> Result<(), String> {
    let timezone = archives
        .first()
        .and_then(|archive| archive.get("timezone"))
        .and_then(|value| value.as_str())
        .unwrap_or("UTC");

    connection
        .execute(
            "insert or replace into archive_manifest (archive_date, timezone, exported_at, archive_count) values (?, ?, ?, ?)",
            params![archive_date, timezone, exported_at, archives.len() as i64],
        )
        .map_err(|error| format!("Failed to write archive manifest row: {error}"))?;

    for archive in archives {
        let archive_id = required_str_field(archive, "id", "archive")?;
        let workspace_id = required_str_field(archive, "workspaceId", "archive")?;
        let scope_type = required_str_field(archive, "scopeType", "archive")?;
        let scope_id = required_str_field(archive, "scopeId", "archive")?;
        let archived_at = required_str_field(archive, "archivedAt", "archive")?;
        let deleted_at = required_str_field(archive, "deletedAt", "archive")?;
        let timezone = required_str_field(archive, "timezone", "archive")?;
        let workspace = required_value_field(archive, "workspace", "archive")?;
        let workspace_name = required_str_field(workspace, "name", "archive.workspace")?;
        let root_path = required_str_field(workspace, "rootPath", "archive.workspace")?;
        let workspace_snapshot = json_text(workspace)?;

        connection
            .execute(
                "insert or replace into archives (
                archive_id, workspace_id, scope_type, scope_id, archive_date, archived_at, deleted_at, timezone, exported_at, export_path, workspace_name, root_path, workspace_snapshot
              ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                params![
                    archive_id,
                    workspace_id,
                    scope_type,
                    scope_id,
                    archive_date,
                    archived_at,
                    deleted_at,
                    timezone,
                    exported_at,
                    export_path,
                    workspace_name,
                    root_path,
                    workspace_snapshot
                ],
            )
            .map_err(|error| format!("Failed to write archive row for {archive_id}: {error}"))?;

        for session in required_array_field(archive, "sessions", "archive")? {
            connection
                .execute(
                    "insert or replace into sessions (
                    archive_id, id, workspace_id, subject_ref, model_ref, agent_name, active_agent_name, title, status, last_run_at, created_at, updated_at, payload
                  ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    params![
                        archive_id,
                        required_str_field(session, "id", "session")?,
                        required_str_field(session, "workspaceId", "session")?,
                        required_str_field(session, "subjectRef", "session")?,
                        optional_str_field(session, "modelRef")?,
                        optional_str_field(session, "agentName")?,
                        required_str_field(session, "activeAgentName", "session")?,
                        optional_str_field(session, "title")?,
                        required_str_field(session, "status", "session")?,
                        optional_str_field(session, "lastRunAt")?,
                        required_str_field(session, "createdAt", "session")?,
                        required_str_field(session, "updatedAt", "session")?,
                        json_text(session)?
                    ],
                )
                .map_err(|error| format!("Failed to write session row for archive {archive_id}: {error}"))?;
        }

        for run in required_array_field(archive, "runs", "archive")? {
            connection
                .execute(
                    "insert or replace into runs (
                    archive_id, id, workspace_id, session_id, parent_run_id, trigger_type, trigger_ref, agent_name, effective_agent_name, status, created_at, started_at, heartbeat_at, ended_at, payload
                  ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    params![
                        archive_id,
                        required_str_field(run, "id", "run")?,
                        required_str_field(run, "workspaceId", "run")?,
                        optional_str_field(run, "sessionId")?,
                        optional_str_field(run, "parentRunId")?,
                        required_str_field(run, "triggerType", "run")?,
                        optional_str_field(run, "triggerRef")?,
                        optional_str_field(run, "agentName")?,
                        required_str_field(run, "effectiveAgentName", "run")?,
                        required_str_field(run, "status", "run")?,
                        required_str_field(run, "createdAt", "run")?,
                        optional_str_field(run, "startedAt")?,
                        optional_str_field(run, "heartbeatAt")?,
                        optional_str_field(run, "endedAt")?,
                        json_text(run)?
                    ],
                )
                .map_err(|error| format!("Failed to write run row for archive {archive_id}: {error}"))?;
        }

        for message in required_array_field(archive, "messages", "archive")? {
            connection
                .execute(
                    "insert or replace into messages (
                    archive_id, id, session_id, run_id, role, created_at, content, metadata
                  ) values (?, ?, ?, ?, ?, ?, ?, ?)",
                    params![
                        archive_id,
                        required_str_field(message, "id", "message")?,
                        required_str_field(message, "sessionId", "message")?,
                        optional_str_field(message, "runId")?,
                        required_str_field(message, "role", "message")?,
                        required_str_field(message, "createdAt", "message")?,
                        json_text(required_value_field(message, "content", "message")?)?,
                        optional_json_text_non_null(message.get("metadata"))?
                    ],
                )
                .map_err(|error| format!("Failed to write message row for archive {archive_id}: {error}"))?;
        }

        for engine_message in required_array_field(archive, "engineMessages", "archive")? {
            connection
                .execute(
                    "insert or replace into runtime_messages (
                    archive_id, id, session_id, run_id, role, kind, created_at, content, metadata
                  ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    params![
                        archive_id,
                        required_str_field(engine_message, "id", "engineMessage")?,
                        required_str_field(engine_message, "sessionId", "engineMessage")?,
                        optional_str_field(engine_message, "runId")?,
                        required_str_field(engine_message, "role", "engineMessage")?,
                        required_str_field(engine_message, "kind", "engineMessage")?,
                        required_str_field(engine_message, "createdAt", "engineMessage")?,
                        json_text(required_value_field(engine_message, "content", "engineMessage")?)?,
                        optional_json_text_non_null(engine_message.get("metadata"))?
                    ],
                )
                .map_err(|error| format!("Failed to write runtime message row for archive {archive_id}: {error}"))?;
        }

        for run_step in required_array_field(archive, "runSteps", "archive")? {
            connection
                .execute(
                    "insert or replace into run_steps (
                    archive_id, id, run_id, seq, step_type, name, agent_name, status, started_at, ended_at, input, output
                  ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    params![
                        archive_id,
                        required_str_field(run_step, "id", "runStep")?,
                        required_str_field(run_step, "runId", "runStep")?,
                        required_i64_field(run_step, "seq", "runStep")?,
                        required_str_field(run_step, "stepType", "runStep")?,
                        optional_str_field(run_step, "name")?,
                        optional_str_field(run_step, "agentName")?,
                        required_str_field(run_step, "status", "runStep")?,
                        optional_str_field(run_step, "startedAt")?,
                        optional_str_field(run_step, "endedAt")?,
                        optional_json_text_present(run_step.get("input"))?,
                        optional_json_text_present(run_step.get("output"))?
                    ],
                )
                .map_err(|error| format!("Failed to write run step row for archive {archive_id}: {error}"))?;
        }

        for tool_call in required_array_field(archive, "toolCalls", "archive")? {
            connection
                .execute(
                    "insert or replace into tool_calls (
                    archive_id, id, run_id, step_id, source_type, tool_name, status, duration_ms, started_at, ended_at, request, response
                  ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    params![
                        archive_id,
                        required_str_field(tool_call, "id", "toolCall")?,
                        required_str_field(tool_call, "runId", "toolCall")?,
                        optional_str_field(tool_call, "stepId")?,
                        required_str_field(tool_call, "sourceType", "toolCall")?,
                        required_str_field(tool_call, "toolName", "toolCall")?,
                        required_str_field(tool_call, "status", "toolCall")?,
                        optional_i64_field(tool_call, "durationMs")?,
                        required_str_field(tool_call, "startedAt", "toolCall")?,
                        required_str_field(tool_call, "endedAt", "toolCall")?,
                        optional_json_text_non_null(tool_call.get("request"))?,
                        optional_json_text_non_null(tool_call.get("response"))?
                    ],
                )
                .map_err(|error| format!("Failed to write tool call row for archive {archive_id}: {error}"))?;
        }

        for hook_run in required_array_field(archive, "hookRuns", "archive")? {
            connection
                .execute(
                    "insert or replace into hook_runs (
                    archive_id, id, run_id, hook_name, event_name, status, started_at, ended_at, capabilities, patch, error_message
                  ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    params![
                        archive_id,
                        required_str_field(hook_run, "id", "hookRun")?,
                        required_str_field(hook_run, "runId", "hookRun")?,
                        required_str_field(hook_run, "hookName", "hookRun")?,
                        required_str_field(hook_run, "eventName", "hookRun")?,
                        required_str_field(hook_run, "status", "hookRun")?,
                        required_str_field(hook_run, "startedAt", "hookRun")?,
                        required_str_field(hook_run, "endedAt", "hookRun")?,
                        json_text(required_value_field(hook_run, "capabilities", "hookRun")?)?,
                        optional_json_text_non_null(hook_run.get("patch"))?,
                        optional_str_field(hook_run, "errorMessage")?
                    ],
                )
                .map_err(|error| format!("Failed to write hook run row for archive {archive_id}: {error}"))?;
        }

        for artifact in required_array_field(archive, "artifacts", "archive")? {
            connection
                .execute(
                    "insert or replace into artifacts (
                    archive_id, id, run_id, type, path, content_ref, created_at, metadata
                  ) values (?, ?, ?, ?, ?, ?, ?, ?)",
                    params![
                        archive_id,
                        required_str_field(artifact, "id", "artifact")?,
                        required_str_field(artifact, "runId", "artifact")?,
                        required_str_field(artifact, "type", "artifact")?,
                        optional_str_field(artifact, "path")?,
                        optional_str_field(artifact, "contentRef")?,
                        required_str_field(artifact, "createdAt", "artifact")?,
                        optional_json_text_non_null(artifact.get("metadata"))?
                    ],
                )
                .map_err(|error| format!("Failed to write artifact row for archive {archive_id}: {error}"))?;
        }
    }

    Ok(())
}

fn required_value_field<'a>(value: &'a Value, key: &str, context: &str) -> Result<&'a Value, String> {
    value
        .get(key)
        .ok_or_else(|| format!("Missing required field {context}.{key}."))
}

fn required_array_field<'a>(value: &'a Value, key: &str, context: &str) -> Result<&'a Vec<Value>, String> {
    required_value_field(value, key, context)?
        .as_array()
        .ok_or_else(|| format!("Expected {context}.{key} to be an array."))
}

fn required_str_field<'a>(value: &'a Value, key: &str, context: &str) -> Result<&'a str, String> {
    required_value_field(value, key, context)?
        .as_str()
        .ok_or_else(|| format!("Expected {context}.{key} to be a string."))
}

fn optional_str_field(value: &Value, key: &str) -> Result<Option<String>, String> {
    match value.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(result)) => Ok(Some(result.clone())),
        Some(_) => Err(format!("Expected optional field {key} to be a string when present.")),
    }
}

fn required_i64_field(value: &Value, key: &str, context: &str) -> Result<i64, String> {
    let field = required_value_field(value, key, context)?;
    field
        .as_i64()
        .or_else(|| field.as_u64().map(|candidate| candidate as i64))
        .ok_or_else(|| format!("Expected {context}.{key} to be an integer."))
}

fn optional_i64_field(value: &Value, key: &str) -> Result<Option<i64>, String> {
    match value.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(candidate) => candidate
            .as_i64()
            .or_else(|| candidate.as_u64().map(|item| item as i64))
            .map(Some)
            .ok_or_else(|| format!("Expected optional field {key} to be an integer when present.")),
    }
}

fn json_text(value: &Value) -> Result<String, String> {
    serde_json::to_string(value).map_err(|error| format!("Failed to serialize JSON payload: {error}"))
}

fn optional_json_text_present(value: Option<&Value>) -> Result<Option<String>, String> {
    match value {
        None => Ok(None),
        Some(candidate) => Ok(Some(json_text(candidate)?)),
    }
}

fn optional_json_text_non_null(value: Option<&Value>) -> Result<Option<String>, String> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(candidate) => Ok(Some(json_text(candidate)?)),
    }
}

fn is_archive_bundle_name(file_name: &str) -> bool {
    is_archive_date_prefix(file_name, ".sqlite")
}

fn is_archive_checksum_name(file_name: &str) -> bool {
    is_archive_date_prefix(file_name, ".sqlite.sha256")
}

fn is_archive_date_prefix(file_name: &str, suffix: &str) -> bool {
    if !file_name.ends_with(suffix) {
        return false;
    }

    let prefix = &file_name[..file_name.len() - suffix.len()];
    let bytes = prefix.as_bytes();
    bytes.len() == 10
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| index == 4 || index == 7 || byte.is_ascii_digit())
}

fn sha256_file(file_path: &Path) -> Result<String, String> {
    let bytes = fs::read(file_path)
        .map_err(|error| format!("Failed to read archive file {}: {error}", file_path.display()))?;
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    Ok(format!("{:x}", hasher.finalize()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tempfile::tempdir;

    #[test]
    fn write_bundle_persists_expected_rows() {
        let temp = tempdir().expect("tempdir");
        let output_path = temp.path().join("2026-04-08.sqlite");
        let request = WriteBundleRequest {
            output_path: output_path.to_string_lossy().to_string(),
            archive_date: "2026-04-08".to_string(),
            export_path: "/exports/2026-04-08.sqlite".to_string(),
            exported_at: "2026-04-09T00:00:00.000Z".to_string(),
            archives: vec![json!({
                "id": "warc_1",
                "workspaceId": "ws_1",
                "scopeType": "workspace",
                "scopeId": "ws_1",
                "archiveDate": "2026-04-08",
                "archivedAt": "2026-04-08T12:00:00.000Z",
                "deletedAt": "2026-04-08T12:00:00.000Z",
                "timezone": "Asia/Shanghai",
                "workspace": {
                    "id": "ws_1",
                    "name": "demo",
                    "rootPath": "/tmp/demo"
                },
                "sessions": [{
                    "id": "ses_1",
                    "workspaceId": "ws_1",
                    "subjectRef": "dev:test",
                    "activeAgentName": "builder",
                    "status": "active",
                    "createdAt": "2026-04-08T11:00:00.000Z",
                    "updatedAt": "2026-04-08T12:00:00.000Z"
                }],
                "runs": [{
                    "id": "run_1",
                    "workspaceId": "ws_1",
                    "sessionId": "ses_1",
                    "triggerType": "message",
                    "effectiveAgentName": "builder",
                    "status": "completed",
                    "createdAt": "2026-04-08T11:05:00.000Z"
                }],
                "messages": [{
                    "id": "msg_1",
                    "sessionId": "ses_1",
                    "runId": "run_1",
                    "role": "assistant",
                    "content": "hello",
                    "createdAt": "2026-04-08T11:06:00.000Z"
                }],
                "engineMessages": [{
                    "id": "emsg_1",
                    "sessionId": "ses_1",
                    "runId": "run_1",
                    "role": "assistant",
                    "kind": "assistant_text",
                    "content": "runtime hello",
                    "createdAt": "2026-04-08T11:06:01.000Z"
                }],
                "runSteps": [{
                    "id": "step_1",
                    "runId": "run_1",
                    "seq": 1,
                    "stepType": "model",
                    "status": "completed",
                    "createdAt": "ignored",
                    "input": null
                }],
                "toolCalls": [{
                    "id": "tool_1",
                    "runId": "run_1",
                    "sourceType": "engine",
                    "toolName": "read_file",
                    "status": "completed",
                    "startedAt": "2026-04-08T11:07:00.000Z",
                    "endedAt": "2026-04-08T11:07:01.000Z"
                }],
                "hookRuns": [{
                    "id": "hook_1",
                    "runId": "run_1",
                    "hookName": "post-run",
                    "eventName": "run.completed",
                    "status": "completed",
                    "startedAt": "2026-04-08T11:08:00.000Z",
                    "endedAt": "2026-04-08T11:08:01.000Z",
                    "capabilities": ["patch"]
                }],
                "artifacts": [{
                    "id": "artifact_1",
                    "runId": "run_1",
                    "type": "file",
                    "createdAt": "2026-04-08T11:09:00.000Z"
                }]
            })],
        };

        write_bundle(&request).expect("write bundle");

        let connection = Connection::open(&output_path).expect("open written sqlite");
        let archive_count: i64 = connection
            .query_row(
                "select archive_count from archive_manifest where archive_date = ?",
                ["2026-04-08"],
                |row| row.get(0),
            )
            .expect("manifest row");
        let message_content: String = connection
            .query_row("select content from messages where id = ?", ["msg_1"], |row| row.get(0))
            .expect("message row");
        let runtime_message_count: i64 = connection
            .query_row("select count(*) from runtime_messages", [], |row| row.get(0))
            .expect("runtime message count");
        let artifact_count: i64 = connection
            .query_row("select count(*) from artifacts", [], |row| row.get(0))
            .expect("artifact count");

        assert_eq!(archive_count, 1);
        assert_eq!(message_content, "\"hello\"");
        assert_eq!(runtime_message_count, 1);
        assert_eq!(artifact_count, 1);
    }

    #[test]
    fn inspect_export_root_reports_expected_issues() {
        let temp = tempdir().expect("tempdir");
        fs::create_dir_all(temp.path().join("manual")).expect("manual dir");
        fs::write(temp.path().join("2026-04-08.sqlite"), "bundle").expect("bundle");
        fs::write(temp.path().join("2026-04-08.sqlite.tmp"), "temp").expect("temp");
        fs::write(temp.path().join("2026-04-09.sqlite.sha256"), "deadbeef").expect("checksum");
        fs::write(temp.path().join("notes.txt"), "note").expect("note");

        let inspection = inspect_export_root(temp.path()).expect("inspect");
        assert_eq!(inspection.unexpected_directories, vec!["manual"]);
        assert_eq!(inspection.leftover_temp_files, vec!["2026-04-08.sqlite.tmp"]);
        assert_eq!(inspection.unexpected_files, vec!["notes.txt"]);
        assert_eq!(inspection.missing_checksums, vec!["2026-04-08.sqlite"]);
        assert_eq!(inspection.orphan_checksums, vec!["2026-04-09.sqlite.sha256"]);
    }
}
