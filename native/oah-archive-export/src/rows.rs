use rusqlite::{params, Connection};
use serde_json::Value;

use crate::schema::*;

pub(crate) fn apply_archive_write_pragmas(connection: &Connection) -> Result<(), String> {
    connection
        .pragma_update(None, "journal_mode", "MEMORY")
        .map_err(|error| {
            format!("Failed to configure archive sqlite journal_mode pragma: {error}")
        })?;
    connection
        .pragma_update(None, "synchronous", "OFF")
        .map_err(|error| {
            format!("Failed to configure archive sqlite synchronous pragma: {error}")
        })?;
    connection
        .pragma_update(None, "temp_store", "MEMORY")
        .map_err(|error| {
            format!("Failed to configure archive sqlite temp_store pragma: {error}")
        })?;
    Ok(())
}

pub(crate) fn insert_archive_rows(
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

    insert_archive_manifest_row(
        connection,
        archive_date,
        timezone,
        exported_at,
        archives.len(),
    )?;

    for archive in archives {
        let archive_id = required_str_field(archive, "id", "archive")?.to_string();
        insert_archive_row(connection, archive_date, export_path, exported_at, archive)?;

        for session in required_array_field(archive, "sessions", "archive")? {
            insert_session_row(connection, &archive_id, session)?;
        }

        for run in required_array_field(archive, "runs", "archive")? {
            insert_run_row(connection, &archive_id, run)?;
        }

        for message in required_array_field(archive, "messages", "archive")? {
            insert_message_row(connection, &archive_id, message)?;
        }

        for engine_message in required_array_field(archive, "engineMessages", "archive")? {
            insert_runtime_message_row(connection, &archive_id, engine_message)?;
        }

        for run_step in required_array_field(archive, "runSteps", "archive")? {
            insert_run_step_row(connection, &archive_id, run_step)?;
        }

        for tool_call in required_array_field(archive, "toolCalls", "archive")? {
            insert_tool_call_row(connection, &archive_id, tool_call)?;
        }

        for hook_run in required_array_field(archive, "hookRuns", "archive")? {
            insert_hook_run_row(connection, &archive_id, hook_run)?;
        }

        for artifact in required_array_field(archive, "artifacts", "archive")? {
            insert_artifact_row(connection, &archive_id, artifact)?;
        }
    }

    Ok(())
}

pub(crate) fn insert_archive_manifest_row(
    connection: &Connection,
    archive_date: &str,
    timezone: &str,
    exported_at: &str,
    archive_count: usize,
) -> Result<(), String> {
    connection
        .prepare_cached(INSERT_ARCHIVE_MANIFEST_SQL)
        .map_err(|error| format!("Failed to prepare archive manifest statement: {error}"))?
        .execute(params![
            archive_date,
            timezone,
            exported_at,
            archive_count as i64
        ])
        .map_err(|error| format!("Failed to write archive manifest row: {error}"))?;
    Ok(())
}

pub(crate) fn insert_archive_row(
    connection: &Connection,
    archive_date: &str,
    export_path: &str,
    exported_at: &str,
    archive: &Value,
) -> Result<(), String> {
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
        .prepare_cached(INSERT_ARCHIVE_SQL)
        .map_err(|error| format!("Failed to prepare archive row statement: {error}"))?
        .execute(params![
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
        ])
        .map_err(|error| format!("Failed to write archive row for {archive_id}: {error}"))?;
    Ok(())
}

pub(crate) fn insert_session_row(
    connection: &Connection,
    archive_id: &str,
    session: &Value,
) -> Result<(), String> {
    connection
        .prepare_cached(INSERT_SESSION_SQL)
        .map_err(|error| format!("Failed to prepare session row statement: {error}"))?
        .execute(params![
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
        ])
        .map_err(|error| {
            format!("Failed to write session row for archive {archive_id}: {error}")
        })?;
    Ok(())
}

pub(crate) fn insert_run_row(
    connection: &Connection,
    archive_id: &str,
    run: &Value,
) -> Result<(), String> {
    connection
        .prepare_cached(INSERT_RUN_SQL)
        .map_err(|error| format!("Failed to prepare run row statement: {error}"))?
        .execute(params![
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
        ])
        .map_err(|error| format!("Failed to write run row for archive {archive_id}: {error}"))?;
    Ok(())
}

pub(crate) fn insert_message_row(
    connection: &Connection,
    archive_id: &str,
    message: &Value,
) -> Result<(), String> {
    connection
        .prepare_cached(INSERT_MESSAGE_SQL)
        .map_err(|error| format!("Failed to prepare message row statement: {error}"))?
        .execute(params![
            archive_id,
            required_str_field(message, "id", "message")?,
            required_str_field(message, "sessionId", "message")?,
            optional_str_field(message, "runId")?,
            required_str_field(message, "role", "message")?,
            required_str_field(message, "createdAt", "message")?,
            json_text(required_value_field(message, "content", "message")?)?,
            optional_json_text_non_null(message.get("metadata"))?
        ])
        .map_err(|error| {
            format!("Failed to write message row for archive {archive_id}: {error}")
        })?;
    Ok(())
}

pub(crate) fn insert_runtime_message_row(
    connection: &Connection,
    archive_id: &str,
    engine_message: &Value,
) -> Result<(), String> {
    connection
        .prepare_cached(INSERT_RUNTIME_MESSAGE_SQL)
        .map_err(|error| format!("Failed to prepare runtime message row statement: {error}"))?
        .execute(params![
            archive_id,
            required_str_field(engine_message, "id", "engineMessage")?,
            required_str_field(engine_message, "sessionId", "engineMessage")?,
            optional_str_field(engine_message, "runId")?,
            required_str_field(engine_message, "role", "engineMessage")?,
            required_str_field(engine_message, "kind", "engineMessage")?,
            required_str_field(engine_message, "createdAt", "engineMessage")?,
            json_text(required_value_field(
                engine_message,
                "content",
                "engineMessage"
            )?)?,
            optional_json_text_non_null(engine_message.get("metadata"))?
        ])
        .map_err(|error| {
            format!("Failed to write runtime message row for archive {archive_id}: {error}")
        })?;
    Ok(())
}

pub(crate) fn insert_run_step_row(
    connection: &Connection,
    archive_id: &str,
    run_step: &Value,
) -> Result<(), String> {
    connection
        .prepare_cached(INSERT_RUN_STEP_SQL)
        .map_err(|error| format!("Failed to prepare run step row statement: {error}"))?
        .execute(params![
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
        ])
        .map_err(|error| {
            format!("Failed to write run step row for archive {archive_id}: {error}")
        })?;
    Ok(())
}

pub(crate) fn insert_tool_call_row(
    connection: &Connection,
    archive_id: &str,
    tool_call: &Value,
) -> Result<(), String> {
    connection
        .prepare_cached(INSERT_TOOL_CALL_SQL)
        .map_err(|error| format!("Failed to prepare tool call row statement: {error}"))?
        .execute(params![
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
        ])
        .map_err(|error| {
            format!("Failed to write tool call row for archive {archive_id}: {error}")
        })?;
    Ok(())
}

pub(crate) fn insert_hook_run_row(
    connection: &Connection,
    archive_id: &str,
    hook_run: &Value,
) -> Result<(), String> {
    connection
        .prepare_cached(INSERT_HOOK_RUN_SQL)
        .map_err(|error| format!("Failed to prepare hook run row statement: {error}"))?
        .execute(params![
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
        ])
        .map_err(|error| {
            format!("Failed to write hook run row for archive {archive_id}: {error}")
        })?;
    Ok(())
}

pub(crate) fn insert_artifact_row(
    connection: &Connection,
    archive_id: &str,
    artifact: &Value,
) -> Result<(), String> {
    connection
        .prepare_cached(INSERT_ARTIFACT_SQL)
        .map_err(|error| format!("Failed to prepare artifact row statement: {error}"))?
        .execute(params![
            archive_id,
            required_str_field(artifact, "id", "artifact")?,
            required_str_field(artifact, "runId", "artifact")?,
            required_str_field(artifact, "type", "artifact")?,
            optional_str_field(artifact, "path")?,
            optional_str_field(artifact, "contentRef")?,
            required_str_field(artifact, "createdAt", "artifact")?,
            optional_json_text_non_null(artifact.get("metadata"))?
        ])
        .map_err(|error| {
            format!("Failed to write artifact row for archive {archive_id}: {error}")
        })?;
    Ok(())
}

fn required_value_field<'a>(
    value: &'a Value,
    key: &str,
    context: &str,
) -> Result<&'a Value, String> {
    value
        .get(key)
        .ok_or_else(|| format!("Missing required field {context}.{key}."))
}

fn required_array_field<'a>(
    value: &'a Value,
    key: &str,
    context: &str,
) -> Result<&'a Vec<Value>, String> {
    required_value_field(value, key, context)?
        .as_array()
        .ok_or_else(|| format!("Expected {context}.{key} to be an array."))
}

fn required_str_field<'a>(value: &'a Value, key: &str, context: &str) -> Result<&'a str, String> {
    required_value_field(value, key, context)?
        .as_str()
        .ok_or_else(|| format!("Expected {context}.{key} to be a string."))
}

pub(crate) fn optional_str_field(value: &Value, key: &str) -> Result<Option<String>, String> {
    match value.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(result)) => Ok(Some(result.clone())),
        Some(_) => Err(format!(
            "Expected optional field {key} to be a string when present."
        )),
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
    serde_json::to_string(value)
        .map_err(|error| format!("Failed to serialize JSON payload: {error}"))
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
