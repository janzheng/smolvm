#!/bin/sh
# Built-in exec MCP server for smolvm machines.
# Runs inside a VM — JSON-RPC 2.0 over newline-delimited stdio.
# Requires: sh, jq

WORKSPACE="${WORKSPACE:-/workspace}"
DEFAULT_TIMEOUT=30

TOOLS='[{"name":"run_command","description":"Execute a shell command and return its output","inputSchema":{"type":"object","properties":{"command":{"type":"string","description":"The command to run"},"args":{"type":"array","items":{"type":"string"},"description":"Arguments to pass"},"cwd":{"type":"string","description":"Working directory (default: /workspace)"},"timeout":{"type":"number","description":"Timeout in seconds (default: 30)"}},"required":["command"]}},{"name":"run_script","description":"Execute a multi-line script via sh","inputSchema":{"type":"object","properties":{"script":{"type":"string","description":"The script content to run"},"cwd":{"type":"string","description":"Working directory (default: /workspace)"},"timeout":{"type":"number","description":"Timeout in seconds (default: 30)"}},"required":["script"]}},{"name":"list_processes","description":"List running processes","inputSchema":{"type":"object","properties":{}}},{"name":"kill_process","description":"Send a signal to a process","inputSchema":{"type":"object","properties":{"pid":{"type":"number","description":"Process ID"},"signal":{"type":"string","description":"Signal name (default: TERM)"}},"required":["pid"]}},{"name":"which","description":"Find the full path of a command","inputSchema":{"type":"object","properties":{"command":{"type":"string","description":"Command to locate"}},"required":["command"]}}]'

# --- tool implementations ---

tool_run_command() {
  local cmd args_json cwd timeout_val
  cmd=$(echo "$1" | jq -r '.command')
  args_json=$(echo "$1" | jq -r '.args // [] | .[]' 2>/dev/null)
  cwd=$(echo "$1" | jq -r '.cwd // empty')
  timeout_val=$(echo "$1" | jq -r '.timeout // empty')
  [ -z "$cwd" ] && cwd="$WORKSPACE"
  [ -z "$timeout_val" ] && timeout_val="$DEFAULT_TIMEOUT"

  local tmpout tmperr
  tmpout=$(mktemp)
  tmperr=$(mktemp)

  # Build args array
  local full_cmd="$cmd"
  if [ -n "$args_json" ]; then
    full_cmd="$cmd $args_json"
  fi

  cd "$cwd" 2>/dev/null || true
  timeout "$timeout_val" sh -c "$full_cmd" >"$tmpout" 2>"$tmperr"
  local exit_code=$?

  local stdout stderr
  stdout=$(cat "$tmpout")
  stderr=$(cat "$tmperr")
  rm -f "$tmpout" "$tmperr"

  printf '{"stdout":%s,"stderr":%s,"exit_code":%d}' \
    "$(printf '%s' "$stdout" | jq -Rs '.')" \
    "$(printf '%s' "$stderr" | jq -Rs '.')" \
    "$exit_code"
}

tool_run_script() {
  local script cwd timeout_val
  script=$(echo "$1" | jq -r '.script')
  cwd=$(echo "$1" | jq -r '.cwd // empty')
  timeout_val=$(echo "$1" | jq -r '.timeout // empty')
  [ -z "$cwd" ] && cwd="$WORKSPACE"
  [ -z "$timeout_val" ] && timeout_val="$DEFAULT_TIMEOUT"

  local tmpscript tmpout tmperr
  tmpscript=$(mktemp)
  tmpout=$(mktemp)
  tmperr=$(mktemp)

  printf '%s' "$script" > "$tmpscript"
  chmod +x "$tmpscript"

  cd "$cwd" 2>/dev/null || true
  timeout "$timeout_val" sh "$tmpscript" >"$tmpout" 2>"$tmperr"
  local exit_code=$?

  local stdout stderr
  stdout=$(cat "$tmpout")
  stderr=$(cat "$tmperr")
  rm -f "$tmpscript" "$tmpout" "$tmperr"

  printf '{"stdout":%s,"stderr":%s,"exit_code":%d}' \
    "$(printf '%s' "$stdout" | jq -Rs '.')" \
    "$(printf '%s' "$stderr" | jq -Rs '.')" \
    "$exit_code"
}

tool_list_processes() {
  ps aux 2>/dev/null | awk 'NR==1{header=$0; next} {printf "{\"user\":\"%s\",\"pid\":%s,\"cpu\":\"%s\",\"mem\":\"%s\",\"command\":\"%s\"}\n", $1,$2,$3,$4,$11}' | jq -s '{processes: ., count: length}'
}

tool_kill_process() {
  local pid signal
  pid=$(echo "$1" | jq -r '.pid')
  signal=$(echo "$1" | jq -r '.signal // "TERM"')
  if kill -"$signal" "$pid" 2>/dev/null; then
    printf '{"success":true,"pid":%s,"signal":"%s"}' "$pid" "$signal"
  else
    printf '{"success":false,"pid":%s,"signal":"%s","error":"Failed to send signal"}' "$pid" "$signal"
  fi
}

tool_which() {
  local cmd path
  cmd=$(echo "$1" | jq -r '.command')
  path=$(which "$cmd" 2>/dev/null)
  if [ -n "$path" ]; then
    printf '{"command":"%s","path":"%s","found":true}' "$cmd" "$path"
  else
    printf '{"command":"%s","path":null,"found":false}' "$cmd"
  fi
}

# --- JSON-RPC dispatch ---
handle_message() {
  local msg="$1"
  local id method
  id=$(echo "$msg" | jq -r '.id // empty')
  method=$(echo "$msg" | jq -r '.method // empty')

  [ -z "$id" ] && return

  case "$method" in
    initialize)
      printf '{"jsonrpc":"2.0","id":%s,"result":{"protocolVersion":"2024-11-05","capabilities":{"tools":{}},"serverInfo":{"name":"smolvm-exec","version":"1.0.0"}}}\n' "$id"
      ;;
    tools/list)
      printf '{"jsonrpc":"2.0","id":%s,"result":{"tools":%s}}\n' "$id" "$TOOLS"
      ;;
    tools/call)
      local tool_name tool_args result is_error
      tool_name=$(echo "$msg" | jq -r '.params.name // empty')
      tool_args=$(echo "$msg" | jq -c '.params.arguments // {}')

      is_error=false
      case "$tool_name" in
        run_command)     result=$(tool_run_command "$tool_args") ;;
        run_script)      result=$(tool_run_script "$tool_args") ;;
        list_processes)  result=$(tool_list_processes) ;;
        kill_process)    result=$(tool_kill_process "$tool_args") ;;
        which)           result=$(tool_which "$tool_args") ;;
        *)               result="Unknown tool: $tool_name"; is_error=true ;;
      esac

      local escaped
      escaped=$(printf '%s' "$result" | jq -Rs '.')
      printf '{"jsonrpc":"2.0","id":%s,"result":{"content":[{"type":"text","text":%s}],"isError":%s}}\n' "$id" "$escaped" "$is_error"
      ;;
    *)
      printf '{"jsonrpc":"2.0","id":%s,"error":{"code":-32601,"message":"Method not found: %s"}}\n' "$id" "$method"
      ;;
  esac
}

while IFS= read -r line; do
  [ -z "$line" ] && continue
  handle_message "$line"
done
