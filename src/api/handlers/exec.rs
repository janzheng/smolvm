//! Command execution handlers.

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Path, Query, State,
    },
    response::{
        sse::{Event, KeepAlive, Sse},
        IntoResponse,
    },
    Json,
};
use std::convert::Infallible;
use std::io::{BufRead, BufReader, Seek, SeekFrom};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use crate::api::error::{classify_ensure_running_error, ApiError};
use crate::api::state::{ensure_running_and_persist, with_sandbox_client, ApiState};
use crate::api::types::{
    ApiErrorResponse, EnvVar, ExecRequest, ExecResponse, LogsQuery, RunRequest,
};
use crate::api::validation::validate_command;
use futures_util::stream::StreamExt;
use futures_util::sink::SinkExt;
use smolvm_protocol::AgentResponse;
use tokio::sync::Semaphore;

use crate::api::state::SandboxEntry;

// User switching is now handled agent-side via setuid/setgid in the wire protocol.
// The old `wrap_command_for_user` su -l approach has been removed.

/// Sanitize env vars and inject proxy defaults for a sandbox.
///
/// When a sandbox has secrets configured:
/// 1. Strip user-provided env vars that match protected key names (e.g., ANTHROPIC_API_KEY)
/// 2. Inject proxy defaults (BASE_URL + placeholder key) for any keys not already set
///
/// This prevents real API keys from entering the VM via `--env` overrides.
fn apply_secret_proxy_env(
    env: &mut Vec<(String, String)>,
    entry: &SandboxEntry,
    state: &ApiState,
) {
    if entry.default_env.is_empty() && entry.secrets.is_empty() {
        return;
    }

    let config_guard = state.proxy_config.read();
    if let Some(ref proxy_config) = *config_guard {
        let stripped = proxy_config.sanitize_env(env, &entry.secrets, &entry.default_env);
        if stripped > 0 {
            tracing::warn!(
                count = stripped,
                "stripped env var(s) that conflict with secret proxy"
            );
        }
    } else {
        // No proxy config — just inject defaults without stripping
        let user_keys: std::collections::HashSet<_> = env.iter().map(|(k, _)| k.clone()).collect();
        for (k, v) in &entry.default_env {
            if !user_keys.contains(k) {
                env.push((k.clone(), v.clone()));
            }
        }
    }
}

/// Execute a command in a sandbox.
///
/// This executes directly in the VM (not in a container).
#[utoipa::path(
    post,
    path = "/api/v1/sandboxes/{id}/exec",
    tag = "Execution",
    params(
        ("id" = String, Path, description = "Sandbox name")
    ),
    request_body = ExecRequest,
    responses(
        (status = 200, description = "Command executed", body = ExecResponse),
        (status = 400, description = "Invalid request", body = ApiErrorResponse),
        (status = 404, description = "Sandbox not found", body = ApiErrorResponse),
        (status = 500, description = "Execution failed", body = ApiErrorResponse)
    )
)]
pub async fn exec_command(
    State(state): State<Arc<ApiState>>,
    Path(id): Path<String>,
    Json(req): Json<ExecRequest>,
) -> Result<Json<ExecResponse>, ApiError> {
    validate_command(&req.command)?;

    let entry = state.get_sandbox(&id)?;

    // Ensure sandbox is running and persist state to DB
    ensure_running_and_persist(&state, &id, &entry)
        .await
        .map_err(classify_ensure_running_error)?;

    let command = req.command.clone();
    let mut env = EnvVar::to_tuples(&req.env);
    let workdir = req.workdir.clone();
    let timeout = req.timeout_secs.map(Duration::from_secs);
    let user = req.user.clone();

    // Sanitize env vars and inject proxy defaults
    {
        let entry_lock = entry.lock();
        apply_secret_proxy_env(&mut env, &entry_lock, &state);
    }

    crate::api::metrics::record_exec_called();
    let exec_start = std::time::Instant::now();

    let (exit_code, stdout, stderr) =
        with_sandbox_client(&entry, move |c| c.vm_exec_as(command, env, workdir, timeout, user)).await?;

    crate::api::metrics::record_exec_duration(exec_start.elapsed().as_secs_f64());

    Ok(Json(ExecResponse {
        exit_code,
        stdout,
        stderr,
    }))
}

/// Run a command in an image.
///
/// This creates a temporary overlay from the image and runs the command.
#[utoipa::path(
    post,
    path = "/api/v1/sandboxes/{id}/run",
    tag = "Execution",
    params(
        ("id" = String, Path, description = "Sandbox name")
    ),
    request_body = RunRequest,
    responses(
        (status = 200, description = "Command executed", body = ExecResponse),
        (status = 400, description = "Invalid request", body = ApiErrorResponse),
        (status = 404, description = "Sandbox not found", body = ApiErrorResponse),
        (status = 500, description = "Execution failed", body = ApiErrorResponse)
    )
)]
pub async fn run_command(
    State(state): State<Arc<ApiState>>,
    Path(id): Path<String>,
    Json(req): Json<RunRequest>,
) -> Result<Json<ExecResponse>, ApiError> {
    validate_command(&req.command)?;

    let entry = state.get_sandbox(&id)?;

    // Ensure sandbox is running and persist state to DB
    ensure_running_and_persist(&state, &id, &entry)
        .await
        .map_err(classify_ensure_running_error)?;

    let image = req.image.clone();
    let command = req.command.clone();
    let mut env = EnvVar::to_tuples(&req.env);
    let workdir = req.workdir.clone();
    let timeout = req.timeout_secs.map(Duration::from_secs);
    let user = req.user.clone();

    // Get mounts from sandbox config (converted to protocol format)
    // Also sanitize env vars for secret proxy protection
    let mounts_config = {
        let entry = entry.lock();
        apply_secret_proxy_env(&mut env, &entry, &state);
        entry
            .mounts
            .iter()
            .enumerate()
            .map(|(i, m)| {
                let tag = crate::agent::mount_tag(i);
                (tag, m.target.clone(), m.readonly)
            })
            .collect::<Vec<_>>()
    };

    let (exit_code, stdout, stderr) = with_sandbox_client(&entry, move |c| {
        c.run_with_mounts_timeout_and_user(&image, command, env, workdir, mounts_config, timeout, user)
    })
    .await?;

    Ok(Json(ExecResponse {
        exit_code,
        stdout,
        stderr,
    }))
}

/// Maximum number of concurrent log-follow SSE streams.
/// Each follower polls via `spawn_blocking` every 100ms, so capping concurrency
/// prevents blocking-pool saturation under high follower counts.
static LOG_FOLLOW_SEMAPHORE: std::sync::LazyLock<Semaphore> =
    std::sync::LazyLock::new(|| Semaphore::new(16));

/// Stream sandbox console logs via SSE.
#[utoipa::path(
    get,
    path = "/api/v1/sandboxes/{id}/logs",
    tag = "Logs",
    params(
        ("id" = String, Path, description = "Sandbox name"),
        ("follow" = Option<bool>, Query, description = "Follow the logs (like tail -f)"),
        ("tail" = Option<usize>, Query, description = "Number of lines to show from the end")
    ),
    responses(
        (status = 200, description = "Log stream (SSE)", content_type = "text/event-stream"),
        (status = 404, description = "Sandbox or log file not found", body = ApiErrorResponse)
    )
)]
pub async fn stream_logs(
    State(state): State<Arc<ApiState>>,
    Path(id): Path<String>,
    Query(query): Query<LogsQuery>,
) -> Result<Sse<impl tokio_stream::Stream<Item = Result<Event, Infallible>>>, ApiError> {
    let entry = state.get_sandbox(&id)?;

    // Get console log path
    let log_path: PathBuf = {
        let entry = entry.lock();
        entry
            .manager
            .console_log()
            .ok_or_else(|| ApiError::NotFound("console log not configured".into()))?
            .to_path_buf()
    };

    // Check if file exists (blocking check is acceptable here since it's fast)
    let path_check = log_path.clone();
    let exists = tokio::task::spawn_blocking(move || path_check.exists())
        .await
        .map_err(ApiError::internal)?;

    if !exists {
        return Err(ApiError::NotFound(format!(
            "log file not found: {}",
            log_path.display()
        )));
    }

    let follow = query.follow;
    let tail = query.tail;

    // Validate tail value upfront
    const MAX_TAIL_LINES: usize = 10_000;
    if let Some(n) = tail {
        if n > MAX_TAIL_LINES {
            return Err(ApiError::BadRequest(format!(
                "tail value {} exceeds maximum of {}",
                n, MAX_TAIL_LINES,
            )));
        }
    }

    // Acquire a follow permit if the client wants to follow. This limits
    // concurrent long-lived polling streams to prevent blocking-pool saturation.
    // The permit is moved into the stream so it's held for the stream's lifetime.
    let follow_permit = if follow {
        Some(
            LOG_FOLLOW_SEMAPHORE
                .try_acquire()
                .map_err(|_| ApiError::Conflict("too many concurrent log followers".into()))?,
        )
    } else {
        None
    };

    // For tail, read last N lines upfront using spawn_blocking with bounded memory
    let (initial_lines, start_pos) = if let Some(n) = tail {
        let path = log_path.clone();
        tokio::task::spawn_blocking(move || read_last_n_lines_bounded(&path, n))
            .await
            .map_err(ApiError::internal)?
            .map_err(ApiError::internal)?
    } else {
        (Vec::new(), 0)
    };

    // Create the SSE stream
    let stream = async_stream::stream! {
        // Hold the follow permit for the stream's lifetime so it's released
        // when the client disconnects or the stream ends.
        let _permit = follow_permit;

        // Emit initial tail lines first
        for line in initial_lines {
            yield Ok(Event::default().data(line));
        }

        if tail.is_some() && !follow {
            return;
        }

        // For following or full read, poll the file for new content
        let mut pos = if tail.is_some() { start_pos } else { 0 };
        let mut partial_line = String::new();

        loop {
            // Read new content in spawn_blocking
            let path = log_path.clone();
            let current_pos = pos;

            let result = tokio::task::spawn_blocking(move || {
                read_from_position(&path, current_pos)
            })
            .await
            .unwrap_or_else(|e| Err(std::io::Error::other(e)));

            match result {
                Ok((new_data, new_pos)) => {
                    pos = new_pos;
                    if !new_data.is_empty() {
                        partial_line.push_str(&new_data);
                        // Yield complete lines
                        while let Some(newline_pos) = partial_line.find('\n') {
                            let line = partial_line[..newline_pos].trim_end_matches('\r').to_string();
                            partial_line = partial_line[newline_pos + 1..].to_string();
                            yield Ok(Event::default().data(line));
                        }
                        // Flush partial line if it exceeds the safety cap
                        if partial_line.len() > MAX_PARTIAL_LINE {
                            yield Ok(Event::default().data(partial_line.clone()));
                            partial_line.clear();
                        }
                    }
                }
                Err(e) => {
                    yield Ok(Event::default().data(format!("error: {}", e)));
                    break;
                }
            }

            if !follow {
                // Yield any remaining partial line
                if !partial_line.is_empty() {
                    yield Ok(Event::default().data(partial_line.clone()));
                }
                break;
            }

            // Wait before polling again
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    };

    Ok(Sse::new(stream).keep_alive(KeepAlive::default()))
}

/// Read the last N lines from a file using a bounded ring buffer.
/// Returns (lines, file_position_at_end) for follow mode.
fn read_last_n_lines_bounded(
    path: &std::path::Path,
    n: usize,
) -> std::io::Result<(Vec<String>, u64)> {
    use std::collections::VecDeque;

    let file = std::fs::File::open(path)?;
    let metadata = file.metadata()?;
    let file_len = metadata.len();

    // n == 0 means "no tail lines" — skip reading the file entirely
    if n == 0 {
        return Ok((Vec::new(), file_len));
    }

    let reader = BufReader::new(file);

    // Use a ring buffer to keep only the last N lines in memory
    let mut ring: VecDeque<String> = VecDeque::with_capacity(n + 1);

    for line in reader.lines() {
        let line = line?;
        if ring.len() == n {
            ring.pop_front();
        }
        ring.push_back(line);
    }

    Ok((ring.into_iter().collect(), file_len))
}

/// Maximum bytes to read per poll cycle (64 KiB).
/// Bounds memory usage per follower and prevents a single large write from
/// blocking the async runtime.
const MAX_READ_CHUNK: u64 = 64 * 1024;

/// Maximum size of the partial (incomplete) line buffer (1 MiB).
/// If a log produces data without newlines beyond this limit, the partial
/// buffer is flushed as-is to prevent unbounded memory growth.
const MAX_PARTIAL_LINE: usize = 1024 * 1024;

/// Read new content from a file starting at a given position.
/// Reads at most `MAX_READ_CHUNK` bytes per call.
fn read_from_position(path: &std::path::Path, pos: u64) -> std::io::Result<(String, u64)> {
    use std::io::Read as _;

    let mut file = std::fs::File::open(path)?;
    let metadata = file.metadata()?;
    let file_len = metadata.len();

    if pos >= file_len {
        // No new content
        return Ok((String::new(), pos));
    }

    file.seek(SeekFrom::Start(pos))?;
    let to_read = std::cmp::min(file_len - pos, MAX_READ_CHUNK) as usize;
    let mut buf = vec![0u8; to_read];
    file.read_exact(&mut buf)?;
    let new_pos = pos + to_read as u64;

    let text = String::from_utf8_lossy(&buf).into_owned();
    Ok((text, new_pos))
}

/// Stream exec output over WebSocket.
///
/// The client sends the first message as a JSON `ExecRequest`, then receives
/// streaming output as JSON messages with `type` field ("stdout", "stderr",
/// "exit", "error").
pub async fn exec_stream(
    State(state): State<Arc<ApiState>>,
    Path(id): Path<String>,
    ws: WebSocketUpgrade,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_exec_ws(state, id, socket))
}

/// WebSocket message sent to clients.
#[derive(serde::Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum WsExecMessage {
    Stdout { data: String },
    Stderr { data: String },
    Exit { code: i32 },
    Error { message: String },
}

/// WebSocket message received from clients for interactive terminal.
#[derive(serde::Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum WsTerminalInput {
    /// Stdin data (base64-encoded bytes for binary safety).
    Stdin { data: String },
    /// Terminal resize event.
    Resize { cols: u16, rows: u16 },
}

/// Interactive terminal WebSocket endpoint.
///
/// Unlike `exec_stream`, this endpoint supports bidirectional communication:
/// - Client → Server: stdin data and resize events
/// - Server → Client: stdout, stderr, exit, error
///
/// First message must be an ExecRequest JSON. Subsequent messages are
/// WsTerminalInput (stdin/resize).
pub async fn exec_interactive(
    State(state): State<Arc<ApiState>>,
    Path(id): Path<String>,
    ws: WebSocketUpgrade,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_interactive_ws(state, id, socket))
}

async fn handle_interactive_ws(state: Arc<ApiState>, id: String, socket: WebSocket) {
    use crate::agent::InteractiveInput;
    use tokio::sync::mpsc;

    let (mut ws_sender, mut ws_receiver) = socket.split();

    // Read first message as ExecRequest
    let req: ExecRequest = match ws_receiver.next().await {
        Some(Ok(Message::Text(text))) => match serde_json::from_str(&text) {
            Ok(req) => req,
            Err(e) => {
                let msg = WsExecMessage::Error {
                    message: format!("invalid request: {}", e),
                };
                let _ = ws_sender
                    .send(Message::Text(serde_json::to_string(&msg).unwrap().into()))
                    .await;
                return;
            }
        },
        _ => {
            let msg = WsExecMessage::Error {
                message: "expected JSON text message with ExecRequest".into(),
            };
            let _ = ws_sender
                .send(Message::Text(serde_json::to_string(&msg).unwrap().into()))
                .await;
            return;
        }
    };

    if req.command.is_empty() {
        let msg = WsExecMessage::Error {
            message: "command cannot be empty".into(),
        };
        let _ = ws_sender
            .send(Message::Text(serde_json::to_string(&msg).unwrap().into()))
            .await;
        return;
    }

    // Get sandbox and ensure running
    let entry = match state.get_sandbox(&id) {
        Ok(e) => e,
        Err(e) => {
            let msg = WsExecMessage::Error {
                message: format!("{:?}", e),
            };
            let _ = ws_sender
                .send(Message::Text(serde_json::to_string(&msg).unwrap().into()))
                .await;
            return;
        }
    };

    if let Err(e) = ensure_running_and_persist(&state, &id, &entry)
        .await
        .map_err(classify_ensure_running_error)
    {
        let msg = WsExecMessage::Error {
            message: format!("{:?}", e),
        };
        let _ = ws_sender
            .send(Message::Text(serde_json::to_string(&msg).unwrap().into()))
            .await;
        return;
    }

    // Channels for bidirectional communication
    let (output_tx, mut output_rx) = mpsc::channel::<AgentResponse>(64);
    let (stdin_tx, stdin_rx) = std::sync::mpsc::channel::<InteractiveInput>();

    let command = req.command.clone();
    let mut env = EnvVar::to_tuples(&req.env);
    let workdir = req.workdir.clone();
    let timeout = req.timeout_secs.map(Duration::from_secs);

    // Sanitize env vars and inject proxy defaults
    {
        let entry_lock = entry.lock();
        apply_secret_proxy_env(&mut env, &entry_lock, &state);
    }

    // Spawn the blocking exec task
    let manager = {
        let entry = entry.lock();
        std::sync::Arc::clone(&entry.manager)
    };

    // Bridge std channel to tokio channel for output
    let (std_output_tx, std_output_rx) = std::sync::mpsc::channel::<AgentResponse>();
    let output_tx_bridge = output_tx.clone();
    std::thread::spawn(move || {
        while let Ok(msg) = std_output_rx.recv() {
            let is_exit = matches!(msg, AgentResponse::Exited { .. });
            if output_tx_bridge.blocking_send(msg).is_err() {
                break;
            }
            if is_exit {
                break;
            }
        }
    });

    tokio::task::spawn_blocking(move || {
        match manager.connect() {
            Ok(mut client) => {
                let _ = client.vm_exec_interactive_streaming(
                    command, env, workdir, timeout, true, std_output_tx, stdin_rx,
                );
            }
            Err(e) => {
                tracing::error!(error = %e, "failed to connect for interactive exec");
                let _ = output_tx.blocking_send(AgentResponse::Error {
                    message: format!("connection failed: {}", e),
                    code: None,
                });
            }
        }
    });

    // Task to read from WebSocket and forward to stdin channel
    let stdin_tx_clone = stdin_tx.clone();
    tokio::spawn(async move {
        while let Some(msg_result) = ws_receiver.next().await {
            match msg_result {
                Ok(Message::Text(text)) => {
                    if let Ok(input) = serde_json::from_str::<WsTerminalInput>(&text) {
                        match input {
                            WsTerminalInput::Stdin { data } => {
                                // Data is sent as plain text (not base64) for simplicity
                                let _ = stdin_tx_clone
                                    .send(InteractiveInput::Data(data.into_bytes()));
                            }
                            WsTerminalInput::Resize { cols, rows } => {
                                let _ =
                                    stdin_tx_clone.send(InteractiveInput::Resize { cols, rows });
                            }
                        }
                    }
                }
                Ok(Message::Binary(data)) => {
                    // Raw binary data treated as stdin
                    let _ = stdin_tx_clone.send(InteractiveInput::Data(data.to_vec()));
                }
                Ok(Message::Close(_)) | Err(_) => {
                    let _ = stdin_tx_clone.send(InteractiveInput::Eof);
                    break;
                }
                _ => {}
            }
        }
    });

    // Forward output to WebSocket
    while let Some(resp) = output_rx.recv().await {
        let ws_msg = match resp {
            AgentResponse::Stdout { data } => {
                let text = String::from_utf8_lossy(&data).to_string();
                WsExecMessage::Stdout { data: text }
            }
            AgentResponse::Stderr { data } => {
                let text = String::from_utf8_lossy(&data).to_string();
                WsExecMessage::Stderr { data: text }
            }
            AgentResponse::Exited { exit_code } => {
                let msg = WsExecMessage::Exit { code: exit_code };
                let _ = ws_sender
                    .send(Message::Text(serde_json::to_string(&msg).unwrap().into()))
                    .await;
                break;
            }
            AgentResponse::Error { message, .. } => WsExecMessage::Error { message },
            _ => continue,
        };

        if ws_sender
            .send(Message::Text(serde_json::to_string(&ws_msg).unwrap().into()))
            .await
            .is_err()
        {
            break;
        }
    }
}

// ============================================================================
// Tests
// ============================================================================

// Note: wrap_command_for_user tests were removed when user switching moved
// to the agent side (setuid/setgid in wire protocol).
// Secret proxy env sanitization tests live in proxy::handler::tests.

async fn handle_exec_ws(state: Arc<ApiState>, id: String, mut socket: WebSocket) {
    // Read first message as ExecRequest
    let req: ExecRequest = match socket.recv().await {
        Some(Ok(Message::Text(text))) => match serde_json::from_str(&text) {
            Ok(req) => req,
            Err(e) => {
                let msg = WsExecMessage::Error {
                    message: format!("invalid request: {}", e),
                };
                let _ = socket
                    .send(Message::Text(serde_json::to_string(&msg).unwrap().into()))
                    .await;
                return;
            }
        },
        _ => {
            let msg = WsExecMessage::Error {
                message: "expected JSON text message with ExecRequest".into(),
            };
            let _ = socket
                .send(Message::Text(serde_json::to_string(&msg).unwrap().into()))
                .await;
            return;
        }
    };

    // Validate command
    if req.command.is_empty() {
        let msg = WsExecMessage::Error {
            message: "command cannot be empty".into(),
        };
        let _ = socket
            .send(Message::Text(serde_json::to_string(&msg).unwrap().into()))
            .await;
        return;
    }

    // Get sandbox and ensure running
    let entry = match state.get_sandbox(&id) {
        Ok(e) => e,
        Err(e) => {
            let msg = WsExecMessage::Error {
                message: format!("{:?}", e),
            };
            let _ = socket
                .send(Message::Text(serde_json::to_string(&msg).unwrap().into()))
                .await;
            return;
        }
    };

    if let Err(e) = ensure_running_and_persist(&state, &id, &entry)
        .await
        .map_err(classify_ensure_running_error)
    {
        let msg = WsExecMessage::Error {
            message: format!("{:?}", e),
        };
        let _ = socket
            .send(Message::Text(serde_json::to_string(&msg).unwrap().into()))
            .await;
        return;
    }

    // Use tokio mpsc channel — the sender has blocking_send() for use from
    // sync code, and the receiver is async-native.
    let (tx, mut rx) = tokio::sync::mpsc::channel::<AgentResponse>(64);

    let command = req.command.clone();
    let mut env = EnvVar::to_tuples(&req.env);
    let workdir = req.workdir.clone();
    let timeout = req.timeout_secs.map(Duration::from_secs);
    let _user = req.user.clone(); // TODO: pass to vm_exec_streaming for interactive user switching
    let entry_clone = entry.clone();

    // Sanitize env vars and inject proxy defaults
    {
        let entry_lock = entry.lock();
        apply_secret_proxy_env(&mut env, &entry_lock, &state);
    }

    // Run exec in blocking task — clone Arc<AgentManager> to avoid holding entry lock
    let manager = {
        let entry = entry_clone.lock();
        std::sync::Arc::clone(&entry.manager)
    };
    tokio::task::spawn_blocking(move || {
        match manager.connect() {
            Ok(mut client) => {
                // Use std channel internally since vm_exec_streaming expects it,
                // then bridge to tokio channel
                let (std_tx, std_rx) = std::sync::mpsc::channel::<AgentResponse>();
                let tx_bridge = tx.clone();

                // Spawn a thread to bridge std → tokio channel
                let bridge = std::thread::spawn(move || {
                    while let Ok(msg) = std_rx.recv() {
                        let is_exit = matches!(msg, AgentResponse::Exited { .. });
                        if tx_bridge.blocking_send(msg).is_err() {
                            break; // Receiver dropped
                        }
                        if is_exit {
                            break;
                        }
                    }
                });

                let _ = client.vm_exec_streaming(command, env, workdir, timeout, std_tx);
                let _ = bridge.join();
            }
            Err(e) => {
                tracing::error!(error = %e, "failed to connect for streaming exec");
                let _ = tx.blocking_send(AgentResponse::Error {
                    message: format!("connection failed: {}", e),
                    code: None,
                });
            }
        }
    });

    // Forward tokio channel messages to WebSocket
    while let Some(resp) = rx.recv().await {
        let ws_msg = match resp {
            AgentResponse::Stdout { data } => {
                let text = String::from_utf8_lossy(&data).to_string();
                WsExecMessage::Stdout { data: text }
            }
            AgentResponse::Stderr { data } => {
                let text = String::from_utf8_lossy(&data).to_string();
                WsExecMessage::Stderr { data: text }
            }
            AgentResponse::Exited { exit_code } => {
                let msg = WsExecMessage::Exit { code: exit_code };
                let _ = socket
                    .send(Message::Text(serde_json::to_string(&msg).unwrap().into()))
                    .await;
                break;
            }
            AgentResponse::Error { message, .. } => WsExecMessage::Error { message },
            _ => continue,
        };

        if socket
            .send(Message::Text(serde_json::to_string(&ws_msg).unwrap().into()))
            .await
            .is_err()
        {
            break; // Client disconnected
        }
    }
}
