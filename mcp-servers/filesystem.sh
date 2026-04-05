#!/bin/sh
# Built-in filesystem MCP server for smolvm sandboxes.
# Runs inside a VM — JSON-RPC 2.0 over newline-delimited stdio.
# Requires: sh, jq
# Operations restricted to WORKSPACE (default: /workspace).

WORKSPACE="${WORKSPACE:-/workspace}"

# --- tool metadata as JSON ---
TOOLS='[{"name":"read_file","description":"Read the contents of a file","inputSchema":{"type":"object","properties":{"path":{"type":"string","description":"File path (relative to workspace or absolute)"}},"required":["path"]}},{"name":"write_file","description":"Write content to a file, creating parent directories as needed","inputSchema":{"type":"object","properties":{"path":{"type":"string","description":"File path"},"content":{"type":"string","description":"Content to write"}},"required":["path","content"]}},{"name":"list_directory","description":"List directory contents with type and size info","inputSchema":{"type":"object","properties":{"path":{"type":"string","description":"Directory path"}},"required":["path"]}},{"name":"search_files","description":"Search for files matching a pattern","inputSchema":{"type":"object","properties":{"pattern":{"type":"string","description":"Filename pattern (e.g. *.ts)"},"path":{"type":"string","description":"Base directory (default: workspace root)"}},"required":["pattern"]}},{"name":"move_file","description":"Move or rename a file","inputSchema":{"type":"object","properties":{"source":{"type":"string","description":"Source path"},"destination":{"type":"string","description":"Destination path"}},"required":["source","destination"]}},{"name":"get_file_info","description":"Get file metadata (size, timestamps, permissions)","inputSchema":{"type":"object","properties":{"path":{"type":"string","description":"File path"}},"required":["path"]}}]'

# --- path helpers ---
resolve_path() {
  local p="$1"
  case "$p" in
    /*) ;; # absolute
    *)  p="$WORKSPACE/$p" ;;
  esac
  # Normalize: collapse double slashes, remove trailing slashes
  while echo "$p" | grep -q '//'; do p=$(echo "$p" | sed 's#//#/#g'); done
  p=${p%/}
  [ -z "$p" ] && p="/"
  case "$p" in
    "$WORKSPACE"|"$WORKSPACE"/*) echo "$p" ;;
    *) echo "ERROR:Access denied: $p is outside workspace $WORKSPACE" ;;
  esac
}

# --- tool implementations ---
tool_read_file() {
  local path
  path=$(resolve_path "$(echo "$1" | jq -r '.path')")
  case "$path" in ERROR:*) echo "$path"; return 1 ;; esac
  cat "$path" 2>&1 || return 1
}

tool_write_file() {
  local path content
  path=$(resolve_path "$(echo "$1" | jq -r '.path')")
  case "$path" in ERROR:*) echo "$path"; return 1 ;; esac
  content=$(echo "$1" | jq -r '.content')
  mkdir -p "$(dirname "$path")" 2>/dev/null
  printf '%s' "$content" > "$path" 2>&1
  echo "Wrote $(printf '%s' "$content" | wc -c | tr -d ' ') bytes to $path"
}

tool_list_directory() {
  local path
  path=$(resolve_path "$(echo "$1" | jq -r '.path')")
  case "$path" in ERROR:*) echo "$path"; return 1 ;; esac
  ls -la "$path" 2>&1 | awk 'NR>1 && $0!="" {
    type="file"; if(substr($1,1,1)=="d") type="directory"; if(substr($1,1,1)=="l") type="symlink";
    printf "{\"name\":\"%s\",\"type\":\"%s\",\"size\":%s}\n", $NF, type, $5
  }' | jq -s '.'
}

tool_search_files() {
  local pattern base
  pattern=$(echo "$1" | jq -r '.pattern')
  base=$(resolve_path "$(echo "$1" | jq -r '.path // empty')")
  [ -z "$base" ] && base="$WORKSPACE"
  case "$base" in ERROR:*) echo "$base"; return 1 ;; esac
  find "$base" -name "$pattern" -type f 2>/dev/null | head -100
}

tool_move_file() {
  local src dst
  src=$(resolve_path "$(echo "$1" | jq -r '.source')")
  dst=$(resolve_path "$(echo "$1" | jq -r '.destination')")
  case "$src" in ERROR:*) echo "$src"; return 1 ;; esac
  case "$dst" in ERROR:*) echo "$dst"; return 1 ;; esac
  mkdir -p "$(dirname "$dst")" 2>/dev/null
  mv "$src" "$dst" 2>&1 && echo "Moved $src -> $dst"
}

tool_get_file_info() {
  local path
  path=$(resolve_path "$(echo "$1" | jq -r '.path')")
  case "$path" in ERROR:*) echo "$path"; return 1 ;; esac
  stat -c '{"path":"%n","size":%s,"isFile":%F,"isDirectory":%F,"mode":"%a","modified":"%Y"}' "$path" 2>/dev/null | \
    sed 's/"isFile":"regular file"/"isFile":true/; s/"isFile":"[^"]*"/"isFile":false/; s/"isDirectory":"directory"/"isDirectory":true/; s/"isDirectory":"[^"]*"/"isDirectory":false/' || \
    ls -la "$path" 2>&1 | awk '{printf "{\"path\":\"%s\",\"size\":%s,\"mode\":\"%s\"}", "'"$path"'", $5, substr($1,1,10)}'
}

# --- JSON-RPC dispatch ---
handle_message() {
  local msg="$1"
  local id method
  id=$(echo "$msg" | jq -r '.id // empty')
  method=$(echo "$msg" | jq -r '.method // empty')

  # Skip notifications
  [ -z "$id" ] && return

  case "$method" in
    initialize)
      printf '{"jsonrpc":"2.0","id":%s,"result":{"protocolVersion":"2024-11-05","capabilities":{"tools":{}},"serverInfo":{"name":"smolvm-filesystem","version":"1.0.0"}}}\n' "$id"
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
        read_file)       result=$(tool_read_file "$tool_args") || is_error=true ;;
        write_file)      result=$(tool_write_file "$tool_args") || is_error=true ;;
        list_directory)  result=$(tool_list_directory "$tool_args") || is_error=true ;;
        search_files)    result=$(tool_search_files "$tool_args") || is_error=true ;;
        move_file)       result=$(tool_move_file "$tool_args") || is_error=true ;;
        get_file_info)   result=$(tool_get_file_info "$tool_args") || is_error=true ;;
        *)               result="Unknown tool: $tool_name"; is_error=true ;;
      esac

      # Escape result for JSON
      local escaped
      escaped=$(printf '%s' "$result" | jq -Rs '.')
      printf '{"jsonrpc":"2.0","id":%s,"result":{"content":[{"type":"text","text":%s}],"isError":%s}}\n' "$id" "$escaped" "$is_error"
      ;;
    *)
      printf '{"jsonrpc":"2.0","id":%s,"error":{"code":-32601,"message":"Method not found: %s"}}\n' "$id" "$method"
      ;;
  esac
}

# --- main loop: read newline-delimited JSON-RPC from stdin ---
while IFS= read -r line; do
  [ -z "$line" ] && continue
  handle_message "$line"
done
