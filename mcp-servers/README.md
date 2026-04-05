# Built-in MCP Servers

Lightweight MCP servers that run inside smolvm sandboxes, exposing tools via JSON-RPC 2.0 over stdio.

## filesystem.ts

Filesystem operations restricted to the workspace directory (`WORKSPACE` env var, default `/workspace`).

**Tools:**

| Tool | Description |
|------|-------------|
| `read_file` | Read file contents |
| `write_file` | Write content to a file (creates parent dirs) |
| `list_directory` | List directory entries with type and size |
| `search_files` | Search for files by glob pattern |
| `move_file` | Move or rename a file |
| `get_file_info` | Get file metadata (size, timestamps, permissions) |

**Usage:**

```bash
deno run --allow-read --allow-write --allow-env mcp-servers/filesystem.ts
```

Then send newline-delimited JSON-RPC messages on stdin:

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}
{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"read_file","arguments":{"path":"hello.txt"}}}
```
