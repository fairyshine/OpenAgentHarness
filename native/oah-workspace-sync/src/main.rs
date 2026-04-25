use std::process::ExitCode;
use std::time::Instant;

mod bundle_policy;
mod bundle_transfer;
mod local_fs;
mod manifest;
mod object_store;
mod object_sync;
mod path_rules;
mod plan;
mod protocol;
mod sandbox_http;
mod sandbox_sync;
mod seed_archive;
mod snapshot;
mod sync_bundle;
mod sync_operations;

use protocol::{run, ErrorResponse, PROTOCOL_VERSION};

const INLINE_UPLOAD_THRESHOLD_BYTES: u64 = 128 * 1024;

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            let payload = ErrorResponse {
                ok: false,
                protocol_version: PROTOCOL_VERSION,
                code: "native_workspace_sync_failed",
                message: error,
            };
            let rendered = serde_json::to_string(&payload).unwrap_or_else(|serialization_error| {
                format!(
                    "{{\"ok\":false,\"protocolVersion\":{},\"code\":\"native_workspace_sync_failed\",\"message\":\"{}\"}}",
                    PROTOCOL_VERSION, serialization_error
                )
            });
            eprintln!("{rendered}");
            ExitCode::FAILURE
        }
    }
}

fn resolve_max_concurrency(value: Option<usize>) -> usize {
    value.filter(|value| *value > 0).unwrap_or(1)
}

fn resolve_inline_upload_threshold_bytes(value: Option<u64>) -> u64 {
    value
        .filter(|value| *value > 0)
        .unwrap_or(INLINE_UPLOAD_THRESHOLD_BYTES)
}

pub(crate) fn elapsed_millis_u64(started_at: Instant) -> u64 {
    started_at.elapsed().as_millis().min(u128::from(u64::MAX)) as u64
}

#[cfg(test)]
mod tests;
