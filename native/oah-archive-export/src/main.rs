use std::fs;
use std::io::{self, BufRead, Read, Write};
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use clap::{Parser, Subcommand};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::Value;

mod inspection;
mod rows;
mod schema;

use inspection::*;
use rows::*;
use schema::*;

const PROTOCOL_VERSION: u32 = 1;
const BINARY_NAME: &str = "oah-archive-export";
const BINARY_VERSION: &str = env!("CARGO_PKG_VERSION");

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
    WriteBundleStream,
    ServeWriteBundleStream,
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WriteBundleStreamHeader {
    output_path: String,
    archive_date: String,
    export_path: String,
    exported_at: String,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum WriteBundleStreamRecord {
    Header {
        #[serde(rename = "outputPath")]
        output_path: String,
        #[serde(rename = "archiveDate")]
        archive_date: String,
        #[serde(rename = "exportPath")]
        export_path: String,
        #[serde(rename = "exportedAt")]
        exported_at: String,
    },
    Archive {
        archive: Value,
    },
    Session {
        #[serde(rename = "archiveId")]
        archive_id: String,
        row: Value,
    },
    Run {
        #[serde(rename = "archiveId")]
        archive_id: String,
        row: Value,
    },
    Message {
        #[serde(rename = "archiveId")]
        archive_id: String,
        row: Value,
    },
    EngineMessage {
        #[serde(rename = "archiveId")]
        archive_id: String,
        row: Value,
    },
    RunStep {
        #[serde(rename = "archiveId")]
        archive_id: String,
        row: Value,
    },
    ToolCall {
        #[serde(rename = "archiveId")]
        archive_id: String,
        row: Value,
    },
    HookRun {
        #[serde(rename = "archiveId")]
        archive_id: String,
        row: Value,
    },
    Artifact {
        #[serde(rename = "archiveId")]
        archive_id: String,
        row: Value,
    },
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ServeWriteBundleStreamRecord {
    RequestStart {
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "outputPath")]
        output_path: String,
        #[serde(rename = "archiveDate")]
        archive_date: String,
        #[serde(rename = "exportPath")]
        export_path: String,
        #[serde(rename = "exportedAt")]
        exported_at: String,
    },
    RequestEnd {
        #[serde(rename = "requestId")]
        request_id: String,
    },
    Archive {
        archive: Value,
    },
    Session {
        #[serde(rename = "archiveId")]
        archive_id: String,
        row: Value,
    },
    Run {
        #[serde(rename = "archiveId")]
        archive_id: String,
        row: Value,
    },
    Message {
        #[serde(rename = "archiveId")]
        archive_id: String,
        row: Value,
    },
    EngineMessage {
        #[serde(rename = "archiveId")]
        archive_id: String,
        row: Value,
    },
    RunStep {
        #[serde(rename = "archiveId")]
        archive_id: String,
        row: Value,
    },
    ToolCall {
        #[serde(rename = "archiveId")]
        archive_id: String,
        row: Value,
    },
    HookRun {
        #[serde(rename = "archiveId")]
        archive_id: String,
        row: Value,
    },
    Artifact {
        #[serde(rename = "archiveId")]
        archive_id: String,
        row: Value,
    },
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ServeWriteBundleStreamResponse {
    ok: bool,
    protocol_version: u32,
    request_id: String,
    output_path: Option<String>,
    archive_date: Option<String>,
    archive_count: Option<usize>,
    code: Option<String>,
    message: Option<String>,
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
                .ok_or_else(|| {
                    format!(
                        "Failed to derive archive file name from {}.",
                        file_path.display()
                    )
                })?;
            fs::write(&output_path, format!("{checksum}  {file_name}\n")).map_err(|error| {
                format!(
                    "Failed to write checksum file {}: {error}",
                    output_path.display()
                )
            })?;

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
        Command::WriteBundleStream => {
            let response = write_bundle_stream()?;
            write_json(&response)
        }
        Command::ServeWriteBundleStream => serve_write_bundle_stream(),
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
    serde_json::to_writer(io::stdout(), value)
        .map_err(|error| format!("Failed to write stdout JSON: {error}"))?;
    println!();
    Ok(())
}

fn write_bundle(request: &WriteBundleRequest) -> Result<(), String> {
    let output_path = PathBuf::from(&request.output_path);
    if let Some(parent) = output_path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            format!(
                "Failed to create archive export directory {}: {error}",
                parent.display()
            )
        })?;
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

    let mut connection = Connection::open(&output_path).map_err(|error| {
        format!(
            "Failed to open archive sqlite bundle {}: {error}",
            output_path.display()
        )
    })?;
    apply_archive_write_pragmas(&connection)?;
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

fn write_bundle_stream() -> Result<WriteBundleResponse, String> {
    let stdin = io::stdin();
    write_bundle_stream_from_reader(stdin.lock())
}

struct ActiveServeWriteBundleRequest {
    request_id: String,
    output_path: String,
    archive_date: String,
    export_path: String,
    exported_at: String,
    connection: Connection,
    archive_count: usize,
    timezone: Option<String>,
    failed: Option<(String, String)>,
}

fn serve_write_bundle_stream() -> Result<(), String> {
    let stdin = io::stdin();
    let stdout = io::stdout();
    serve_write_bundle_stream_from_reader(stdin.lock(), stdout.lock())
}

fn serve_write_bundle_stream_from_reader<R: BufRead, W: Write>(
    reader: R,
    mut writer: W,
) -> Result<(), String> {
    let mut current_request: Option<ActiveServeWriteBundleRequest> = None;

    for (index, line_result) in reader.lines().enumerate() {
        let line = line_result
            .map_err(|error| format!("Failed to read stdin line {}: {error}", index + 1))?;
        if line.trim().is_empty() {
            continue;
        }

        let record: ServeWriteBundleStreamRecord =
            serde_json::from_str(&line).map_err(|error| {
                format!(
                    "Failed to parse archive export worker record on line {}: {error}",
                    index + 1
                )
            })?;

        match record {
            ServeWriteBundleStreamRecord::RequestStart {
                request_id,
                output_path,
                archive_date,
                export_path,
                exported_at,
            } => {
                if current_request.is_some() {
                    return Err(format!(
                        "Received request_start for {request_id} while another archive export request is still active."
                    ));
                }

                let connection = open_archive_bundle_connection(&output_path)?;
                connection
                    .execute_batch("begin immediate")
                    .map_err(|error| {
                        format!(
                            "Failed to begin archive sqlite transaction for {request_id}: {error}"
                        )
                    })?;

                current_request = Some(ActiveServeWriteBundleRequest {
                    request_id,
                    output_path,
                    archive_date,
                    export_path,
                    exported_at,
                    connection,
                    archive_count: 0,
                    timezone: None,
                    failed: None,
                });
            }
            ServeWriteBundleStreamRecord::RequestEnd { request_id } => {
                let mut request = current_request
                    .take()
                    .ok_or_else(|| format!("Received request_end for {request_id} without an active archive export request."))?;
                if request.request_id != request_id {
                    return Err(format!(
                        "Received request_end for {request_id}, but the active archive export request is {}.",
                        request.request_id
                    ));
                }

                let response = match request.failed.take() {
                    Some((code, message)) => {
                        let _ = request.connection.execute_batch("rollback");
                        ServeWriteBundleStreamResponse {
                            ok: false,
                            protocol_version: PROTOCOL_VERSION,
                            request_id,
                            output_path: Some(request.output_path),
                            archive_date: Some(request.archive_date),
                            archive_count: Some(request.archive_count),
                            code: Some(code),
                            message: Some(message),
                        }
                    }
                    None => {
                        insert_archive_manifest_row(
                            &request.connection,
                            &request.archive_date,
                            request.timezone.as_deref().unwrap_or("UTC"),
                            &request.exported_at,
                            request.archive_count,
                        )?;
                        request
                            .connection
                            .execute_batch("commit")
                            .map_err(|error| {
                                format!(
                                    "Failed to commit archive sqlite transaction for {}: {error}",
                                    request.request_id
                                )
                            })?;
                        ServeWriteBundleStreamResponse {
                            ok: true,
                            protocol_version: PROTOCOL_VERSION,
                            request_id,
                            output_path: Some(request.output_path),
                            archive_date: Some(request.archive_date),
                            archive_count: Some(request.archive_count),
                            code: None,
                            message: None,
                        }
                    }
                };

                serde_json::to_writer(&mut writer, &response).map_err(|error| {
                    format!("Failed to write archive export worker response: {error}")
                })?;
                writeln!(&mut writer).map_err(|error| {
                    format!("Failed to write archive export worker newline: {error}")
                })?;
                writer.flush().map_err(|error| {
                    format!("Failed to flush archive export worker response: {error}")
                })?;
            }
            other => {
                let request = current_request.as_mut().ok_or_else(|| {
                    "Received archive export row data without an active request.".to_string()
                })?;
                if request.failed.is_some() {
                    continue;
                }

                if let Err(error) = apply_serve_write_bundle_record(request, other) {
                    let _ = request.connection.execute_batch("rollback");
                    request.failed = Some(("archive_export_request_failed".to_string(), error));
                }
            }
        }
    }

    if let Some(request) = current_request {
        return Err(format!(
            "Archive export worker reached EOF while request {} was still active.",
            request.request_id
        ));
    }

    Ok(())
}

fn write_bundle_stream_from_reader<R: BufRead>(reader: R) -> Result<WriteBundleResponse, String> {
    let mut lines = reader.lines();

    let header = match lines.next() {
        None => return Err("Missing archive export stream header.".to_string()),
        Some(line) => parse_write_bundle_stream_header(
            &line.map_err(|error| format!("Failed to read stdin: {error}"))?,
        )?,
    };

    let output_path = PathBuf::from(&header.output_path);
    if let Some(parent) = output_path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            format!(
                "Failed to create archive export directory {}: {error}",
                parent.display()
            )
        })?;
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

    let mut connection = Connection::open(&output_path).map_err(|error| {
        format!(
            "Failed to open archive sqlite bundle {}: {error}",
            output_path.display()
        )
    })?;
    apply_archive_write_pragmas(&connection)?;
    apply_archive_schema(&connection)?;

    let transaction = connection
        .transaction()
        .map_err(|error| format!("Failed to open archive sqlite transaction: {error}"))?;

    let mut archive_count = 0usize;
    let mut timezone: Option<String> = None;

    for (index, line_result) in lines.enumerate() {
        let line = line_result
            .map_err(|error| format!("Failed to read stdin line {}: {error}", index + 2))?;
        if line.trim().is_empty() {
            continue;
        }

        match parse_write_bundle_stream_record(&line, index + 2)? {
            WriteBundleStreamRecord::Header { .. } => {
                return Err(format!(
                    "Unexpected stream header record at line {}.",
                    index + 2
                ));
            }
            WriteBundleStreamRecord::Archive { archive } => {
                if timezone.is_none() {
                    timezone = optional_str_field(&archive, "timezone")?;
                }
                insert_archive_row(
                    &transaction,
                    &header.archive_date,
                    &header.export_path,
                    &header.exported_at,
                    &archive,
                )?;
                archive_count += 1;
            }
            WriteBundleStreamRecord::Session { archive_id, row } => {
                insert_session_row(&transaction, &archive_id, &row)?;
            }
            WriteBundleStreamRecord::Run { archive_id, row } => {
                insert_run_row(&transaction, &archive_id, &row)?;
            }
            WriteBundleStreamRecord::Message { archive_id, row } => {
                insert_message_row(&transaction, &archive_id, &row)?;
            }
            WriteBundleStreamRecord::EngineMessage { archive_id, row } => {
                insert_runtime_message_row(&transaction, &archive_id, &row)?;
            }
            WriteBundleStreamRecord::RunStep { archive_id, row } => {
                insert_run_step_row(&transaction, &archive_id, &row)?;
            }
            WriteBundleStreamRecord::ToolCall { archive_id, row } => {
                insert_tool_call_row(&transaction, &archive_id, &row)?;
            }
            WriteBundleStreamRecord::HookRun { archive_id, row } => {
                insert_hook_run_row(&transaction, &archive_id, &row)?;
            }
            WriteBundleStreamRecord::Artifact { archive_id, row } => {
                insert_artifact_row(&transaction, &archive_id, &row)?;
            }
        }
    }

    insert_archive_manifest_row(
        &transaction,
        &header.archive_date,
        timezone.as_deref().unwrap_or("UTC"),
        &header.exported_at,
        archive_count,
    )?;
    transaction
        .commit()
        .map_err(|error| format!("Failed to commit archive sqlite transaction: {error}"))?;

    Ok(WriteBundleResponse {
        ok: true,
        protocol_version: PROTOCOL_VERSION,
        output_path: header.output_path,
        archive_date: header.archive_date,
        archive_count,
    })
}

fn open_archive_bundle_connection(output_path: &str) -> Result<Connection, String> {
    let output_path = PathBuf::from(output_path);
    if let Some(parent) = output_path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            format!(
                "Failed to create archive export directory {}: {error}",
                parent.display()
            )
        })?;
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

    let connection = Connection::open(&output_path).map_err(|error| {
        format!(
            "Failed to open archive sqlite bundle {}: {error}",
            output_path.display()
        )
    })?;
    connection.set_prepared_statement_cache_capacity(16);
    apply_archive_write_pragmas(&connection)?;
    apply_archive_schema(&connection)?;
    Ok(connection)
}

fn apply_serve_write_bundle_record(
    request: &mut ActiveServeWriteBundleRequest,
    record: ServeWriteBundleStreamRecord,
) -> Result<(), String> {
    match record {
        ServeWriteBundleStreamRecord::RequestStart { .. }
        | ServeWriteBundleStreamRecord::RequestEnd { .. } => Err(
            "Received worker request boundary inside active archive export request.".to_string(),
        ),
        ServeWriteBundleStreamRecord::Archive { archive } => {
            if request.timezone.is_none() {
                request.timezone = optional_str_field(&archive, "timezone")?;
            }
            insert_archive_row(
                &request.connection,
                &request.archive_date,
                &request.export_path,
                &request.exported_at,
                &archive,
            )?;
            request.archive_count += 1;
            Ok(())
        }
        ServeWriteBundleStreamRecord::Session { archive_id, row } => {
            insert_session_row(&request.connection, &archive_id, &row)
        }
        ServeWriteBundleStreamRecord::Run { archive_id, row } => {
            insert_run_row(&request.connection, &archive_id, &row)
        }
        ServeWriteBundleStreamRecord::Message { archive_id, row } => {
            insert_message_row(&request.connection, &archive_id, &row)
        }
        ServeWriteBundleStreamRecord::EngineMessage { archive_id, row } => {
            insert_runtime_message_row(&request.connection, &archive_id, &row)
        }
        ServeWriteBundleStreamRecord::RunStep { archive_id, row } => {
            insert_run_step_row(&request.connection, &archive_id, &row)
        }
        ServeWriteBundleStreamRecord::ToolCall { archive_id, row } => {
            insert_tool_call_row(&request.connection, &archive_id, &row)
        }
        ServeWriteBundleStreamRecord::HookRun { archive_id, row } => {
            insert_hook_run_row(&request.connection, &archive_id, &row)
        }
        ServeWriteBundleStreamRecord::Artifact { archive_id, row } => {
            insert_artifact_row(&request.connection, &archive_id, &row)
        }
    }
}

fn parse_write_bundle_stream_header(line: &str) -> Result<WriteBundleStreamHeader, String> {
    match parse_write_bundle_stream_record(line, 1)? {
        WriteBundleStreamRecord::Header {
            output_path,
            archive_date,
            export_path,
            exported_at,
        } => Ok(WriteBundleStreamHeader {
            output_path,
            archive_date,
            export_path,
            exported_at,
        }),
        _ => Err("Archive export stream must start with a header record.".to_string()),
    }
}

fn parse_write_bundle_stream_record(
    line: &str,
    line_number: usize,
) -> Result<WriteBundleStreamRecord, String> {
    serde_json::from_str(line).map_err(|error| {
        format!("Failed to parse archive export stream record on line {line_number}: {error}")
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::Cursor;
    use tempfile::tempdir;

    fn sample_archive() -> Value {
        json!({
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
        })
    }

    fn assert_expected_bundle_rows(output_path: &Path) {
        let connection = Connection::open(output_path).expect("open written sqlite");
        let archive_count: i64 = connection
            .query_row(
                "select archive_count from archive_manifest where archive_date = ?",
                ["2026-04-08"],
                |row| row.get(0),
            )
            .expect("manifest row");
        let message_content: String = connection
            .query_row(
                "select content from messages where id = ?",
                ["msg_1"],
                |row| row.get(0),
            )
            .expect("message row");
        let runtime_message_count: i64 = connection
            .query_row("select count(*) from runtime_messages", [], |row| {
                row.get(0)
            })
            .expect("runtime message count");
        let artifact_count: i64 = connection
            .query_row("select count(*) from artifacts", [], |row| row.get(0))
            .expect("artifact count");

        assert_eq!(archive_count, 1);
        assert_eq!(message_content, "\"hello\"");
        assert_eq!(runtime_message_count, 1);
        assert_eq!(artifact_count, 1);
    }

    fn append_archive_rows_to_stream(stream: &mut String, archive: &Value) {
        stream.push_str(&format!(
            "{}\n",
            json!({ "type": "archive", "archive": archive })
        ));
        stream.push_str(&format!(
            "{}\n",
            json!({
                "type": "session",
                "archiveId": "warc_1",
                "row": archive.get("sessions").and_then(Value::as_array).and_then(|rows| rows.first()).cloned().expect("session")
            })
        ));
        stream.push_str(&format!(
            "{}\n",
            json!({
                "type": "run",
                "archiveId": "warc_1",
                "row": archive.get("runs").and_then(Value::as_array).and_then(|rows| rows.first()).cloned().expect("run")
            })
        ));
        stream.push_str(&format!(
            "{}\n",
            json!({
                "type": "message",
                "archiveId": "warc_1",
                "row": archive.get("messages").and_then(Value::as_array).and_then(|rows| rows.first()).cloned().expect("message")
            })
        ));
        stream.push_str(&format!(
            "{}\n",
            json!({
                "type": "engine_message",
                "archiveId": "warc_1",
                "row": archive.get("engineMessages").and_then(Value::as_array).and_then(|rows| rows.first()).cloned().expect("engine message")
            })
        ));
        stream.push_str(&format!(
            "{}\n",
            json!({
                "type": "run_step",
                "archiveId": "warc_1",
                "row": archive.get("runSteps").and_then(Value::as_array).and_then(|rows| rows.first()).cloned().expect("run step")
            })
        ));
        stream.push_str(&format!(
            "{}\n",
            json!({
                "type": "tool_call",
                "archiveId": "warc_1",
                "row": archive.get("toolCalls").and_then(Value::as_array).and_then(|rows| rows.first()).cloned().expect("tool call")
            })
        ));
        stream.push_str(&format!(
            "{}\n",
            json!({
                "type": "hook_run",
                "archiveId": "warc_1",
                "row": archive.get("hookRuns").and_then(Value::as_array).and_then(|rows| rows.first()).cloned().expect("hook run")
            })
        ));
        stream.push_str(&format!(
            "{}\n",
            json!({
                "type": "artifact",
                "archiveId": "warc_1",
                "row": archive.get("artifacts").and_then(Value::as_array).and_then(|rows| rows.first()).cloned().expect("artifact")
            })
        ));
    }

    #[test]
    fn write_bundle_persists_expected_rows() {
        let temp = tempdir().expect("tempdir");
        let output_path = temp.path().join("2026-04-08.sqlite");
        let request = WriteBundleRequest {
            output_path: output_path.to_string_lossy().to_string(),
            archive_date: "2026-04-08".to_string(),
            export_path: "/exports/2026-04-08.sqlite".to_string(),
            exported_at: "2026-04-09T00:00:00.000Z".to_string(),
            archives: vec![sample_archive()],
        };

        write_bundle(&request).expect("write bundle");
        assert_expected_bundle_rows(&output_path);
    }

    #[test]
    fn write_bundle_stream_persists_expected_rows() {
        let temp = tempdir().expect("tempdir");
        let output_path = temp.path().join("2026-04-08-stream.sqlite");
        let archive = sample_archive();
        let mut stream = String::new();
        stream.push_str(&format!(
            "{}\n",
            json!({
                "type": "header",
                "outputPath": output_path.to_string_lossy(),
                "archiveDate": "2026-04-08",
                "exportPath": "/exports/2026-04-08-stream.sqlite",
                "exportedAt": "2026-04-09T00:00:00.000Z"
            })
        ));
        append_archive_rows_to_stream(&mut stream, &archive);

        let response =
            write_bundle_stream_from_reader(Cursor::new(stream)).expect("write bundle stream");
        assert_eq!(response.archive_count, 1);
        assert_expected_bundle_rows(&output_path);
    }

    #[test]
    fn serve_write_bundle_stream_processes_request_and_replies() {
        let temp = tempdir().expect("tempdir");
        let output_path = temp.path().join("2026-04-08-worker.sqlite");
        let archive = sample_archive();
        let mut input = String::new();
        input.push_str(&format!(
            "{}\n",
            json!({
                "type": "request_start",
                "requestId": "req_1",
                "outputPath": output_path.to_string_lossy(),
                "archiveDate": "2026-04-08",
                "exportPath": "/exports/2026-04-08-worker.sqlite",
                "exportedAt": "2026-04-09T00:00:00.000Z"
            })
        ));
        append_archive_rows_to_stream(&mut input, &archive);
        input.push_str(&format!(
            "{}\n",
            json!({ "type": "request_end", "requestId": "req_1" })
        ));

        let mut output = Vec::new();
        serve_write_bundle_stream_from_reader(Cursor::new(input), &mut output)
            .expect("serve worker request");

        let response: Value = serde_json::from_slice(&output).expect("parse worker response");
        assert_eq!(response.get("ok"), Some(&Value::Bool(true)));
        assert_eq!(
            response.get("requestId"),
            Some(&Value::String("req_1".to_string()))
        );
        assert_eq!(response.get("archiveCount"), Some(&Value::Number(1.into())));
        assert_expected_bundle_rows(&output_path);
    }

    #[test]
    fn write_bundle_stream_record_parser_accepts_engine_message() {
        let record = parse_write_bundle_stream_record(
            r#"{"type":"engine_message","archiveId":"warc_1","row":{"id":"emsg_1"}}"#,
            2,
        )
        .expect("parse stream record");

        match record {
            WriteBundleStreamRecord::EngineMessage { archive_id, row } => {
                assert_eq!(archive_id, "warc_1");
                assert_eq!(row.get("id"), Some(&Value::String("emsg_1".to_string())));
            }
            _ => panic!("expected engine message record"),
        }
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
        assert_eq!(
            inspection.leftover_temp_files,
            vec!["2026-04-08.sqlite.tmp"]
        );
        assert_eq!(inspection.unexpected_files, vec!["notes.txt"]);
        assert_eq!(inspection.missing_checksums, vec!["2026-04-08.sqlite"]);
        assert_eq!(
            inspection.orphan_checksums,
            vec!["2026-04-09.sqlite.sha256"]
        );
    }
}
