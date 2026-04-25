use serde_json::{json, Value};
use std::collections::HashMap;
use std::env;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::thread;
use std::time::Duration;

const MAX_BODY_BYTES: usize = 1024 * 1024;

#[derive(Clone, Debug)]
struct Config {
    host: String,
    port: u16,
    auth_token: Option<String>,
    compose_file: Option<String>,
    project_name: String,
    service: String,
    command: String,
}

#[derive(Debug)]
struct ReconcileInput {
    timestamp: String,
    desired_replicas: i64,
}

#[derive(Debug)]
struct ManagedContainer {
    running: bool,
}

#[derive(Debug)]
struct CommandOutput {
    code: i32,
    stdout: String,
    stderr: String,
}

fn main() {
    let config = match load_config() {
        Ok(config) => config,
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1);
        }
    };
    let bind_addr = format!("{}:{}", config.host, config.port);
    let listener = match TcpListener::bind(&bind_addr) {
        Ok(listener) => listener,
        Err(error) => {
            eprintln!("failed to bind {bind_addr}: {error}");
            std::process::exit(1);
        }
    };

    println!(
        "Open Agent Harness native compose scaler listening on http://{}:{} for {}/{}",
        config.host, config.port, config.project_name, config.service
    );

    for stream in listener.incoming() {
        match stream {
            Ok(stream) => {
                let request_config = config.clone();
                thread::spawn(move || {
                    if let Err(error) = handle_connection(stream, &request_config) {
                        eprintln!("request failed: {error}");
                    }
                });
            }
            Err(error) => eprintln!("failed to accept connection: {error}"),
        }
    }
}

fn load_config() -> Result<Config, String> {
    let host = read_env("OAH_COMPOSE_SCALER_HOST").unwrap_or_else(|| "0.0.0.0".to_string());
    let port = read_env("OAH_COMPOSE_SCALER_PORT")
        .and_then(|raw| raw.parse::<u16>().ok())
        .filter(|port| *port > 0)
        .unwrap_or(8790);
    let compose_file = read_env("OAH_COMPOSE_SCALER_COMPOSE_FILE");
    let project_name = read_env("OAH_COMPOSE_SCALER_PROJECT_NAME")
        .or_else(|| read_env("COMPOSE_PROJECT_NAME"))
        .ok_or_else(|| {
            "compose scaler requires OAH_COMPOSE_SCALER_PROJECT_NAME or COMPOSE_PROJECT_NAME."
                .to_string()
        })?;
    let service =
        read_env("OAH_COMPOSE_SCALER_SERVICE").unwrap_or_else(|| "oah-sandbox".to_string());
    if service.is_empty() {
        return Err("compose scaler requires OAH_COMPOSE_SCALER_SERVICE.".to_string());
    }

    Ok(Config {
        host,
        port,
        auth_token: read_env("OAH_COMPOSE_SCALER_AUTH_TOKEN"),
        compose_file,
        project_name,
        service,
        command: read_env("OAH_COMPOSE_SCALER_COMMAND").unwrap_or_else(|| "docker".to_string()),
    })
}

fn read_env(name: &str) -> Option<String> {
    env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn handle_connection(mut stream: TcpStream, config: &Config) -> Result<(), String> {
    stream
        .set_read_timeout(Some(Duration::from_secs(10)))
        .map_err(|error| error.to_string())?;
    stream
        .set_write_timeout(Some(Duration::from_secs(10)))
        .map_err(|error| error.to_string())?;

    let request = read_http_request(&mut stream)?;
    if request.method == "GET" && request.path == "/healthz" {
        return send_json(&mut stream, 200, &json!({ "ok": true }));
    }

    if request.method != "POST" || request.path != "/reconcile" {
        return send_json(&mut stream, 404, &json!({ "error": "not_found" }));
    }

    if let Some(auth_token) = &config.auth_token {
        let authorization = request
            .headers
            .get("authorization")
            .map(String::as_str)
            .unwrap_or("");
        if authorization != format!("Bearer {auth_token}") {
            return send_json(&mut stream, 401, &json!({ "error": "unauthorized" }));
        }
    }

    let body = if request.body.is_empty() {
        json!({})
    } else {
        serde_json::from_slice::<Value>(&request.body)
            .map_err(|error| format!("invalid JSON request body: {error}"))?
    };

    match reconcile(config, &body) {
        Ok(result) => send_json(&mut stream, 200, &result),
        Err(error) => send_json(&mut stream, 500, &json!({ "error": error })),
    }
}

struct HttpRequest {
    method: String,
    path: String,
    headers: HashMap<String, String>,
    body: Vec<u8>,
}

fn read_http_request(stream: &mut TcpStream) -> Result<HttpRequest, String> {
    let mut header_bytes = Vec::new();
    let mut byte = [0_u8; 1];
    while !header_bytes.ends_with(b"\r\n\r\n") {
        let read = stream.read(&mut byte).map_err(|error| error.to_string())?;
        if read == 0 {
            return Err("connection closed while reading request headers".to_string());
        }
        header_bytes.push(byte[0]);
        if header_bytes.len() > 64 * 1024 {
            return Err("request headers exceed 64KB".to_string());
        }
    }

    let header_text = String::from_utf8(header_bytes)
        .map_err(|error| format!("request headers are not valid UTF-8: {error}"))?;
    let mut lines = header_text.split("\r\n");
    let request_line = lines
        .next()
        .ok_or_else(|| "missing request line".to_string())?;
    let mut request_parts = request_line.split_whitespace();
    let method = request_parts
        .next()
        .ok_or_else(|| "missing request method".to_string())?
        .to_string();
    let path = request_parts
        .next()
        .ok_or_else(|| "missing request path".to_string())?
        .split('?')
        .next()
        .unwrap_or("")
        .to_string();

    let mut headers = HashMap::new();
    for line in lines {
        if line.is_empty() {
            continue;
        }
        if let Some((name, value)) = line.split_once(':') {
            headers.insert(name.trim().to_ascii_lowercase(), value.trim().to_string());
        }
    }

    let body = if headers
        .get("transfer-encoding")
        .is_some_and(|value| value.to_ascii_lowercase().contains("chunked"))
    {
        read_chunked_body(stream)?
    } else {
        let content_length = headers
            .get("content-length")
            .and_then(|value| value.parse::<usize>().ok())
            .unwrap_or(0);
        if content_length > MAX_BODY_BYTES {
            return Err("request body exceeds 1MB".to_string());
        }

        let mut body = vec![0_u8; content_length];
        if content_length > 0 {
            stream
                .read_exact(&mut body)
                .map_err(|error| format!("failed to read request body: {error}"))?;
        }
        body
    };

    Ok(HttpRequest {
        method,
        path,
        headers,
        body,
    })
}

fn read_chunked_body(stream: &mut TcpStream) -> Result<Vec<u8>, String> {
    let mut body = Vec::new();

    loop {
        let size_line = read_crlf_line(stream)?;
        let size_text = size_line.split(';').next().unwrap_or("").trim();
        let chunk_size = usize::from_str_radix(size_text, 16)
            .map_err(|error| format!("invalid chunk size {size_text:?}: {error}"))?;
        if chunk_size == 0 {
            loop {
                let trailer_line = read_crlf_line(stream)?;
                if trailer_line.is_empty() {
                    break;
                }
            }
            break;
        }

        if body.len() + chunk_size > MAX_BODY_BYTES {
            return Err("request body exceeds 1MB".to_string());
        }

        let mut chunk = vec![0_u8; chunk_size];
        stream
            .read_exact(&mut chunk)
            .map_err(|error| format!("failed to read chunked request body: {error}"))?;
        body.extend_from_slice(&chunk);

        let mut crlf = [0_u8; 2];
        stream
            .read_exact(&mut crlf)
            .map_err(|error| format!("failed to read chunk terminator: {error}"))?;
        if crlf != *b"\r\n" {
            return Err("invalid chunk terminator".to_string());
        }
    }

    Ok(body)
}

fn read_crlf_line(stream: &mut TcpStream) -> Result<String, String> {
    let mut bytes = Vec::new();
    let mut byte = [0_u8; 1];
    while !bytes.ends_with(b"\r\n") {
        let read = stream.read(&mut byte).map_err(|error| error.to_string())?;
        if read == 0 {
            return Err("connection closed while reading chunked request".to_string());
        }
        bytes.push(byte[0]);
        if bytes.len() > 8 * 1024 {
            return Err("chunked request line exceeds 8KB".to_string());
        }
    }
    bytes.truncate(bytes.len().saturating_sub(2));
    String::from_utf8(bytes)
        .map_err(|error| format!("chunked request line is not valid UTF-8: {error}"))
}

fn send_json(stream: &mut TcpStream, status: u16, payload: &Value) -> Result<(), String> {
    let reason = match status {
        200 => "OK",
        401 => "Unauthorized",
        404 => "Not Found",
        500 => "Internal Server Error",
        _ => "OK",
    };
    let body = serde_json::to_vec(payload)
        .map_err(|error| format!("failed to serialize response: {error}"))?;
    let header = format!(
        "HTTP/1.1 {status} {reason}\r\ncontent-type: application/json; charset=utf-8\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
        body.len()
    );
    stream
        .write_all(header.as_bytes())
        .and_then(|_| stream.write_all(&body))
        .map_err(|error| format!("failed to write response: {error}"))
}

fn reconcile(config: &Config, request: &Value) -> Result<Value, String> {
    let input_value = request
        .get("input")
        .ok_or_else(|| "reconcile request is missing input.".to_string())?;
    let input = parse_reconcile_input(input_value)?;
    let allow_scale_down = request
        .get("allowScaleDown")
        .and_then(Value::as_bool)
        .ok_or_else(|| "reconcile request allowScaleDown must be a boolean.".to_string())?;

    let containers = list_managed_containers(config)?;
    let running_count = containers
        .iter()
        .filter(|container| container.running)
        .count() as i64;
    let target_ref = json!({
        "platform": "docker_compose",
        "kind": "service",
        "name": config.service
    });

    if !allow_scale_down && input.desired_replicas < running_count {
        return Ok(json!({
            "kind": "docker_compose",
            "attempted": true,
            "applied": false,
            "desiredReplicas": input.desired_replicas,
            "observedReplicas": running_count,
            "appliedReplicas": running_count,
            "outcome": "blocked_scale_down",
            "at": input.timestamp,
            "phase": "blocked",
            "reasonCode": "scale_down_disabled",
            "targetRef": target_ref,
            "message": "scale down blocked by controller policy"
        }));
    }

    if input.desired_replicas == running_count {
        return Ok(json!({
            "kind": "docker_compose",
            "attempted": true,
            "applied": false,
            "desiredReplicas": input.desired_replicas,
            "observedReplicas": running_count,
            "appliedReplicas": running_count,
            "outcome": "steady",
            "at": input.timestamp,
            "phase": "steady",
            "targetRef": target_ref
        }));
    }

    let mut args = compose_args(
        config,
        &[
            "up".to_string(),
            "-d".to_string(),
            "--no-deps".to_string(),
            "--scale".to_string(),
            format!("{}={}", config.service, input.desired_replicas),
            config.service.clone(),
        ],
    );
    let output = run_command(config, &mut args)?;
    if output.code != 0 {
        return Err(first_non_empty(
            &output.stderr,
            &output.stdout,
            "docker compose reconcile failed",
        ));
    }

    let mut result = json!({
        "kind": "docker_compose",
        "attempted": true,
        "applied": true,
        "desiredReplicas": input.desired_replicas,
        "observedReplicas": running_count,
        "appliedReplicas": input.desired_replicas,
        "outcome": "scaled",
        "at": input.timestamp,
        "phase": "accepted",
        "reasonCode": "scale_request_accepted",
        "targetRef": target_ref
    });
    if !output.stdout.trim().is_empty() {
        result["message"] = json!(output.stdout.trim());
    }
    Ok(result)
}

fn parse_reconcile_input(input: &Value) -> Result<ReconcileInput, String> {
    let timestamp = input
        .get("timestamp")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "reconcile request input.timestamp must be a non-empty string.".to_string())?
        .to_string();

    for field in [
        "desiredReplicas",
        "suggestedReplicas",
        "activeReplicas",
        "activeSlots",
        "busySlots",
    ] {
        if !input.get(field).is_some_and(Value::is_number) {
            return Err(format!(
                "reconcile request input.{field} must be a finite number."
            ));
        }
    }

    let reason = input
        .get("reason")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty());
    if reason.is_none() {
        return Err("reconcile request input.reason must be a non-empty string.".to_string());
    }

    let desired_replicas = input
        .get("desiredReplicas")
        .and_then(Value::as_i64)
        .ok_or_else(|| "reconcile request input.desiredReplicas must be an integer.".to_string())?;

    Ok(ReconcileInput {
        timestamp,
        desired_replicas,
    })
}

fn list_managed_containers(config: &Config) -> Result<Vec<ManagedContainer>, String> {
    if let Ok(containers) = list_managed_containers_via_docker_api(config) {
        return Ok(containers);
    }

    let mut list_args = compose_args(
        config,
        &[
            "ps".to_string(),
            "-a".to_string(),
            "-q".to_string(),
            config.service.clone(),
        ],
    );
    let list_output = run_command(config, &mut list_args)?;
    if list_output.code != 0 {
        return Err(first_non_empty(
            &list_output.stderr,
            &list_output.stdout,
            "failed to list docker compose containers",
        ));
    }

    let ids: Vec<String> = list_output
        .stdout
        .split_whitespace()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .collect();
    if ids.is_empty() {
        return Ok(Vec::new());
    }

    let mut inspect_args = vec![config.command.clone(), "inspect".to_string()];
    inspect_args.extend(ids);
    let inspect_output = run_command(config, &mut inspect_args)?;
    if inspect_output.code != 0 {
        return Err(first_non_empty(
            &inspect_output.stderr,
            &inspect_output.stdout,
            "failed to inspect docker compose containers",
        ));
    }

    let inspected = serde_json::from_str::<Value>(&inspect_output.stdout)
        .map_err(|error| format!("failed to parse docker inspect output: {error}"))?;
    let entries = inspected
        .as_array()
        .ok_or_else(|| "docker inspect output must be an array".to_string())?;

    Ok(entries
        .iter()
        .map(|entry| ManagedContainer {
            running: entry
                .get("State")
                .and_then(|state| state.get("Running"))
                .and_then(Value::as_bool)
                .unwrap_or(false),
        })
        .collect())
}

fn list_managed_containers_via_docker_api(
    config: &Config,
) -> Result<Vec<ManagedContainer>, String> {
    let socket_path = docker_socket_path()?;
    let filters = serde_json::to_string(&json!({
        "label": [
            format!("com.docker.compose.project={}", config.project_name),
            format!("com.docker.compose.service={}", config.service)
        ]
    }))
    .map_err(|error| format!("failed to build Docker API filters: {error}"))?;
    let path = format!(
        "/containers/json?all=1&filters={}",
        percent_encode(filters.as_bytes())
    );
    let body = docker_api_get(&socket_path, &path)?;
    let listed = serde_json::from_slice::<Value>(&body)
        .map_err(|error| format!("failed to parse Docker API container list: {error}"))?;
    let entries = listed
        .as_array()
        .ok_or_else(|| "Docker API container list must be an array".to_string())?;

    Ok(entries
        .iter()
        .map(|entry| ManagedContainer {
            running: entry
                .get("State")
                .and_then(Value::as_str)
                .is_some_and(|state| state == "running"),
        })
        .collect())
}

fn docker_socket_path() -> Result<String, String> {
    let Some(docker_host) = read_env("DOCKER_HOST") else {
        return Ok("/var/run/docker.sock".to_string());
    };
    if let Some(path) = docker_host.strip_prefix("unix://") {
        if !path.is_empty() {
            return Ok(path.to_string());
        }
    }
    Err(format!(
        "Docker API observation only supports unix:// DOCKER_HOST, got {docker_host}"
    ))
}

fn docker_api_get(socket_path: &str, path: &str) -> Result<Vec<u8>, String> {
    let mut stream = UnixStream::connect(socket_path)
        .map_err(|error| format!("failed to connect Docker socket {socket_path}: {error}"))?;
    stream
        .set_read_timeout(Some(Duration::from_secs(10)))
        .map_err(|error| error.to_string())?;
    stream
        .set_write_timeout(Some(Duration::from_secs(10)))
        .map_err(|error| error.to_string())?;

    let request = format!("GET {path} HTTP/1.1\r\nHost: docker\r\nConnection: close\r\n\r\n");
    stream
        .write_all(request.as_bytes())
        .map_err(|error| format!("failed to write Docker API request: {error}"))?;

    let mut response = Vec::new();
    stream
        .read_to_end(&mut response)
        .map_err(|error| format!("failed to read Docker API response: {error}"))?;
    let Some(header_end) = find_header_end(&response) else {
        return Err("Docker API response is missing headers".to_string());
    };

    let headers = String::from_utf8_lossy(&response[..header_end]);
    let mut header_lines = headers.split("\r\n");
    let status_line = header_lines
        .next()
        .ok_or_else(|| "Docker API response is missing a status line".to_string())?;
    let status = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|value| value.parse::<u16>().ok())
        .ok_or_else(|| format!("Docker API response has an invalid status line: {status_line}"))?;
    if !(200..300).contains(&status) {
        let body = String::from_utf8_lossy(&response[header_end + 4..]);
        return Err(format!(
            "Docker API request failed with HTTP {status}: {}",
            body.trim()
        ));
    }

    let body = response[header_end + 4..].to_vec();
    if headers
        .to_ascii_lowercase()
        .contains("transfer-encoding: chunked")
    {
        return decode_chunked_bytes(&body);
    }
    Ok(body)
}

fn find_header_end(bytes: &[u8]) -> Option<usize> {
    bytes.windows(4).position(|window| window == b"\r\n\r\n")
}

fn decode_chunked_bytes(bytes: &[u8]) -> Result<Vec<u8>, String> {
    let mut index = 0;
    let mut decoded = Vec::new();

    loop {
        let line_end = bytes[index..]
            .windows(2)
            .position(|window| window == b"\r\n")
            .map(|offset| index + offset)
            .ok_or_else(|| "chunked Docker API response is missing chunk size".to_string())?;
        let size_text = std::str::from_utf8(&bytes[index..line_end])
            .map_err(|error| format!("chunk size is not valid UTF-8: {error}"))?
            .split(';')
            .next()
            .unwrap_or("")
            .trim();
        let chunk_size = usize::from_str_radix(size_text, 16)
            .map_err(|error| format!("invalid Docker API chunk size {size_text:?}: {error}"))?;
        index = line_end + 2;
        if chunk_size == 0 {
            break;
        }

        let chunk_end = index
            .checked_add(chunk_size)
            .ok_or_else(|| "Docker API chunk size overflowed".to_string())?;
        if chunk_end + 2 > bytes.len() {
            return Err("Docker API chunk exceeds response body".to_string());
        }
        decoded.extend_from_slice(&bytes[index..chunk_end]);
        if &bytes[chunk_end..chunk_end + 2] != b"\r\n" {
            return Err("Docker API chunk is missing CRLF terminator".to_string());
        }
        index = chunk_end + 2;
    }

    Ok(decoded)
}

fn percent_encode(bytes: &[u8]) -> String {
    let mut encoded = String::with_capacity(bytes.len());
    for byte in bytes {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                encoded.push(*byte as char)
            }
            _ => encoded.push_str(&format!("%{byte:02X}")),
        }
    }
    encoded
}

fn compose_args(config: &Config, tail: &[String]) -> Vec<String> {
    let mut args = vec![config.command.clone(), "compose".to_string()];
    if let Some(compose_file) = &config.compose_file {
        args.push("-f".to_string());
        args.push(compose_file.clone());
    }
    args.push("-p".to_string());
    args.push(config.project_name.clone());
    args.extend(tail.iter().cloned());
    args
}

fn run_command(config: &Config, args: &mut [String]) -> Result<CommandOutput, String> {
    let Some(program) = args.first() else {
        return Err("empty command".to_string());
    };

    let mut command = Command::new(program);
    command.args(&args[1..]);
    if let Some(cwd) = compose_target_cwd(config) {
        command.current_dir(cwd);
    }

    let output = command
        .output()
        .map_err(|error| format!("failed to run {}: {error}", args.join(" ")))?;
    Ok(CommandOutput {
        code: output.status.code().unwrap_or(1),
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
    })
}

fn compose_target_cwd(config: &Config) -> Option<PathBuf> {
    config
        .compose_file
        .as_ref()
        .and_then(|compose_file| Path::new(compose_file).parent())
        .map(Path::to_path_buf)
}

fn first_non_empty(stderr: &str, stdout: &str, fallback: &str) -> String {
    let stderr = stderr.trim();
    if !stderr.is_empty() {
        return stderr.to_string();
    }
    let stdout = stdout.trim();
    if !stdout.is_empty() {
        return stdout.to_string();
    }
    fallback.to_string()
}
