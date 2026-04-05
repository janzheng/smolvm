//! MCP (Model Context Protocol) handlers.
//!
//! Provides stateless MCP server interaction inside machinees via the existing
//! exec infrastructure. Each request execs the MCP server command, sends JSON-RPC
//! messages through stdin, and parses the response from stdout.

use axum::{
    extract::{Path, State},
    Json,
};
use std::sync::Arc;
use std::time::Duration;

use crate::api::error::{classify_ensure_running_error, ApiError};
use crate::api::state::{ensure_running_and_persist, with_machine_client, ApiState};
use crate::api::types::{
    ApiErrorResponse, CallMcpToolRequest, CallMcpToolResponse, EnvVar, ListMcpToolsResponse,
    McpServerConfig, McpServerStatus, McpToolInfo,
};

/// Build a shell command that starts the MCP server, sends JSON-RPC messages
/// via stdin, and captures stdout. The MCP server is run ephemerally.
fn build_mcp_shell_command(server_cmd: &[String], jsonrpc_messages: &[serde_json::Value]) -> Vec<String> {
    // Build the stdin payload: one JSON-RPC message per line
    let stdin_lines: Vec<String> = jsonrpc_messages
        .iter()
        .map(|msg| serde_json::to_string(msg).unwrap_or_default())
        .collect();
    // Use literal \n (not actual newline 0x0A) so printf interprets it.
    // Actual newlines in the command string break the vsock exec protocol
    // which uses newlines as delimiters.
    let stdin_payload = format!("{}\\n", stdin_lines.join("\\n"));

    // Build a shell command that:
    // 1. Pipes the JSON-RPC messages into the MCP server
    // 2. Uses timeout to kill the server after it responds
    // We use printf + pipe to send messages, and head to capture only the
    // number of response lines we expect
    let server_cmd_str = server_cmd
        .iter()
        .map(|s| shell_escape(s))
        .collect::<Vec<_>>()
        .join(" ");

    let expected_responses = jsonrpc_messages.len();

    vec![
        "sh".to_string(),
        "-c".to_string(),
        format!(
            "printf '{}' | timeout 30 {} 2>/dev/null | head -n {}",
            stdin_payload.replace('\'', "'\\''"),
            server_cmd_str,
            expected_responses
        ),
    ]
}

/// Minimal shell escaping for command arguments.
fn shell_escape(s: &str) -> String {
    if s.chars().all(|c| c.is_alphanumeric() || c == '-' || c == '_' || c == '/' || c == '.' || c == ':' || c == '@') {
        s.to_string()
    } else {
        format!("'{}'", s.replace('\'', "'\\''"))
    }
}

/// Build JSON-RPC initialize message.
fn initialize_message(id: u64) -> serde_json::Value {
    serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "initialize",
        "params": {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {
                "name": "smolvm",
                "version": "1.0"
            }
        }
    })
}

/// Build JSON-RPC tools/list message.
fn tools_list_message(id: u64) -> serde_json::Value {
    serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "tools/list",
        "params": {}
    })
}

/// Build JSON-RPC tools/call message.
fn tools_call_message(id: u64, tool_name: &str, arguments: &serde_json::Value) -> serde_json::Value {
    serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "tools/call",
        "params": {
            "name": tool_name,
            "arguments": arguments
        }
    })
}

/// Parse JSON-RPC response lines from stdout.
/// Returns a Vec of parsed JSON values, one per line.
fn parse_jsonrpc_responses(stdout: &str) -> Vec<serde_json::Value> {
    stdout
        .lines()
        .filter(|line| !line.trim().is_empty())
        .filter_map(|line| serde_json::from_str(line).ok())
        .collect()
}

/// List MCP tools from all configured servers in a machine.
///
/// For each MCP server, this execs the server command inside the machine,
/// sends initialize + tools/list, and collects the discovered tools.
#[utoipa::path(
    get,
    path = "/api/v1/machines/{id}/mcp/tools",
    tag = "MCP",
    params(
        ("id" = String, Path, description = "Machine name")
    ),
    responses(
        (status = 200, description = "MCP tools discovered", body = ListMcpToolsResponse),
        (status = 404, description = "Machine not found", body = ApiErrorResponse),
        (status = 500, description = "Discovery failed", body = ApiErrorResponse)
    )
)]
pub async fn list_mcp_tools(
    State(state): State<Arc<ApiState>>,
    Path(id): Path<String>,
) -> Result<Json<ListMcpToolsResponse>, ApiError> {
    let entry = state.get_machine(&id)?;

    ensure_running_and_persist(&state, &id, &entry)
        .await
        .map_err(classify_ensure_running_error)?;

    // Get configured MCP servers from machine
    let mcp_servers: Vec<McpServerConfig> = {
        let entry_lock = entry.lock();
        entry_lock.mcp_servers.clone()
    };

    if mcp_servers.is_empty() {
        return Ok(Json(ListMcpToolsResponse {
            tools: vec![],
            servers: vec![],
        }));
    }

    let mut all_tools = Vec::new();
    let mut server_statuses = Vec::new();

    for server_config in &mcp_servers {
        let messages = vec![
            initialize_message(1),
            tools_list_message(2),
        ];
        let command = build_mcp_shell_command(&server_config.command, &messages);
        let env = EnvVar::to_tuples(&server_config.env);
        let workdir = server_config.workdir.clone();
        let timeout = Some(Duration::from_secs(30));

        let result = with_machine_client(&entry, move |c| {
            c.vm_exec_as(command, env, workdir, timeout, None)
        })
        .await;

        match result {
            Ok((_exit_code, stdout, _stderr)) => {
                let responses = parse_jsonrpc_responses(&stdout);
                // The second response should be tools/list result
                let tools_response = responses.get(1);
                let mut tools = Vec::new();

                if let Some(resp) = tools_response {
                    if let Some(result) = resp.get("result") {
                        if let Some(tool_list) = result.get("tools").and_then(|t| t.as_array()) {
                            for tool in tool_list {
                                let name = tool.get("name").and_then(|n| n.as_str()).unwrap_or("unknown");
                                let description = tool.get("description").and_then(|d| d.as_str()).map(|s| s.to_string());
                                let input_schema = tool.get("inputSchema").cloned().unwrap_or(serde_json::json!({}));
                                tools.push(McpToolInfo {
                                    server: server_config.name.clone(),
                                    name: name.to_string(),
                                    description,
                                    input_schema,
                                });
                            }
                        }
                    }
                }

                let tool_count = tools.len();
                all_tools.extend(tools);
                server_statuses.push(McpServerStatus {
                    name: server_config.name.clone(),
                    running: true,
                    tool_count,
                });
            }
            Err(e) => {
                tracing::warn!(
                    server = %server_config.name,
                    error = ?e,
                    "MCP server discovery failed"
                );
                server_statuses.push(McpServerStatus {
                    name: server_config.name.clone(),
                    running: false,
                    tool_count: 0,
                });
            }
        }
    }

    Ok(Json(ListMcpToolsResponse {
        tools: all_tools,
        servers: server_statuses,
    }))
}

/// Call an MCP tool on a specific server inside a machine.
///
/// Executes the MCP server command, sends initialize + tools/call, and returns
/// the result. The server runs ephemerally for each call.
#[utoipa::path(
    post,
    path = "/api/v1/machines/{id}/mcp/call",
    tag = "MCP",
    params(
        ("id" = String, Path, description = "Machine name")
    ),
    request_body = CallMcpToolRequest,
    responses(
        (status = 200, description = "Tool call result", body = CallMcpToolResponse),
        (status = 400, description = "Invalid request", body = ApiErrorResponse),
        (status = 404, description = "Machine not found", body = ApiErrorResponse),
        (status = 500, description = "Tool call failed", body = ApiErrorResponse)
    )
)]
pub async fn call_mcp_tool(
    State(state): State<Arc<ApiState>>,
    Path(id): Path<String>,
    Json(req): Json<CallMcpToolRequest>,
) -> Result<Json<CallMcpToolResponse>, ApiError> {
    let entry = state.get_machine(&id)?;

    ensure_running_and_persist(&state, &id, &entry)
        .await
        .map_err(classify_ensure_running_error)?;

    // Find the requested MCP server config
    let server_config: McpServerConfig = {
        let entry_lock = entry.lock();
        entry_lock
            .mcp_servers
            .iter()
            .find(|s| s.name == req.server)
            .cloned()
            .ok_or_else(|| {
                ApiError::NotFound(format!("MCP server '{}' not configured", req.server))
            })?
    };

    let messages = vec![
        initialize_message(1),
        tools_call_message(2, &req.tool, &req.arguments),
    ];
    let command = build_mcp_shell_command(&server_config.command, &messages);
    let env = EnvVar::to_tuples(&server_config.env);
    let workdir = server_config.workdir.clone();
    let timeout = Some(Duration::from_secs(60));

    let (exit_code, stdout, stderr) = with_machine_client(&entry, move |c| {
        c.vm_exec_as(command, env, workdir, timeout, None)
    })
    .await?;

    let responses = parse_jsonrpc_responses(&stdout);
    // The second response should be tools/call result
    let call_response = responses.get(1);

    match call_response {
        Some(resp) => {
            if let Some(error) = resp.get("error") {
                Ok(Json(CallMcpToolResponse {
                    content: vec![serde_json::json!({
                        "type": "text",
                        "text": error.get("message").and_then(|m| m.as_str()).unwrap_or("unknown error")
                    })],
                    is_error: true,
                }))
            } else if let Some(result) = resp.get("result") {
                let content = result
                    .get("content")
                    .and_then(|c| c.as_array())
                    .cloned()
                    .unwrap_or_default();
                let is_error = result
                    .get("isError")
                    .and_then(|e| e.as_bool())
                    .unwrap_or(false);
                Ok(Json(CallMcpToolResponse { content, is_error }))
            } else {
                Ok(Json(CallMcpToolResponse {
                    content: vec![serde_json::json!({
                        "type": "text",
                        "text": "unexpected response format"
                    })],
                    is_error: true,
                }))
            }
        }
        None => {
            // No valid response from the MCP server
            let error_msg = if !stderr.is_empty() {
                format!("MCP server error (exit {}): {}", exit_code, stderr.trim())
            } else if !stdout.is_empty() {
                format!("MCP server returned unparseable output (exit {}): {}", exit_code, stdout.trim())
            } else {
                format!("MCP server returned no output (exit {})", exit_code)
            };
            Ok(Json(CallMcpToolResponse {
                content: vec![serde_json::json!({
                    "type": "text",
                    "text": error_msg
                })],
                is_error: true,
            }))
        }
    }
}

/// List configured MCP servers for a machine.
///
/// Returns the configured servers without running them. For tool discovery,
/// use the `/mcp/tools` endpoint instead.
#[utoipa::path(
    get,
    path = "/api/v1/machines/{id}/mcp/servers",
    tag = "MCP",
    params(
        ("id" = String, Path, description = "Machine name")
    ),
    responses(
        (status = 200, description = "MCP server configurations", body = Vec<McpServerConfig>),
        (status = 404, description = "Machine not found", body = ApiErrorResponse)
    )
)]
pub async fn list_mcp_servers(
    State(state): State<Arc<ApiState>>,
    Path(id): Path<String>,
) -> Result<Json<Vec<McpServerConfig>>, ApiError> {
    let entry = state.get_machine(&id)?;
    let servers = {
        let entry_lock = entry.lock();
        entry_lock.mcp_servers.clone()
    };
    Ok(Json(servers))
}

/// Start/verify an MCP server inside the machine.
///
/// Executes the MCP server command and sends an initialize message to verify
/// it responds correctly. Returns the server status.
#[utoipa::path(
    post,
    path = "/api/v1/machines/{id}/mcp/start",
    tag = "MCP",
    params(
        ("id" = String, Path, description = "Machine name")
    ),
    request_body = McpServerConfig,
    responses(
        (status = 200, description = "MCP server verified", body = McpServerStatus),
        (status = 400, description = "Invalid request", body = ApiErrorResponse),
        (status = 404, description = "Machine not found", body = ApiErrorResponse),
        (status = 500, description = "Server start failed", body = ApiErrorResponse)
    )
)]
pub async fn start_mcp_server(
    State(state): State<Arc<ApiState>>,
    Path(id): Path<String>,
    Json(config): Json<McpServerConfig>,
) -> Result<Json<McpServerStatus>, ApiError> {
    let entry = state.get_machine(&id)?;

    ensure_running_and_persist(&state, &id, &entry)
        .await
        .map_err(classify_ensure_running_error)?;

    // Send initialize to verify the server works
    let messages = vec![initialize_message(1)];
    let command = build_mcp_shell_command(&config.command, &messages);
    let env = EnvVar::to_tuples(&config.env);
    let workdir = config.workdir.clone();
    let timeout = Some(Duration::from_secs(30));

    let result = with_machine_client(&entry, move |c| {
        c.vm_exec_as(command, env, workdir, timeout, None)
    })
    .await;

    match result {
        Ok((_exit_code, stdout, _stderr)) => {
            let responses = parse_jsonrpc_responses(&stdout);
            let initialized = responses
                .first()
                .and_then(|r| r.get("result"))
                .is_some();

            // If the server responds successfully and it's not already configured, add it
            if initialized {
                let mut entry_lock = entry.lock();
                if !entry_lock.mcp_servers.iter().any(|s| s.name == config.name) {
                    entry_lock.mcp_servers.push(config.clone());
                }
            }

            Ok(Json(McpServerStatus {
                name: config.name,
                running: initialized,
                tool_count: 0, // tools/list not sent, just verifying
            }))
        }
        Err(e) => {
            tracing::warn!(error = ?e, "MCP server start/verify failed");
            Ok(Json(McpServerStatus {
                name: config.name,
                running: false,
                tool_count: 0,
            }))
        }
    }
}
