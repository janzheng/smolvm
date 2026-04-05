#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env

/**
 * Built-in filesystem MCP server for smolvm sandboxes.
 *
 * Runs inside a VM and exposes filesystem tools via MCP protocol
 * (JSON-RPC 2.0 over stdio, newline-delimited).
 *
 * Operations are restricted to WORKSPACE (default: /workspace).
 */

const WORKSPACE = Deno.env.get("WORKSPACE") ?? "/workspace";

// --- path helpers ---

function resolvePath(p: string): string {
  // Resolve relative paths against WORKSPACE; absolute paths must be under WORKSPACE
  const resolved = p.startsWith("/") ? p : `${WORKSPACE}/${p}`;
  // Normalise (collapse ..)
  const parts: string[] = [];
  for (const seg of resolved.split("/")) {
    if (seg === "..") parts.pop();
    else if (seg && seg !== ".") parts.push(seg);
  }
  const norm = "/" + parts.join("/");
  if (!norm.startsWith(WORKSPACE)) {
    throw new Error(`Access denied: path ${norm} is outside workspace ${WORKSPACE}`);
  }
  return norm;
}

// --- tool implementations ---

async function readFile(args: { path: string }): Promise<string> {
  const p = resolvePath(args.path);
  return await Deno.readTextFile(p);
}

async function writeFile(args: { path: string; content: string }): Promise<string> {
  const p = resolvePath(args.path);
  // ensure parent dirs exist
  const parent = p.slice(0, p.lastIndexOf("/"));
  if (parent) await Deno.mkdir(parent, { recursive: true });
  await Deno.writeTextFile(p, args.content);
  return `Wrote ${args.content.length} bytes to ${p}`;
}

interface DirEntry {
  name: string;
  type: "file" | "directory" | "symlink";
  size?: number;
}

async function listDirectory(args: { path: string }): Promise<string> {
  const p = resolvePath(args.path);
  const entries: DirEntry[] = [];
  for await (const entry of Deno.readDir(p)) {
    const e: DirEntry = {
      name: entry.name,
      type: entry.isDirectory ? "directory" : entry.isSymlink ? "symlink" : "file",
    };
    if (entry.isFile) {
      try {
        const stat = await Deno.stat(`${p}/${entry.name}`);
        e.size = stat.size;
      } catch { /* skip */ }
    }
    entries.push(e);
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  return JSON.stringify(entries, null, 2);
}

async function searchFiles(args: { pattern: string; path?: string }): Promise<string> {
  const base = resolvePath(args.path ?? WORKSPACE);
  const matches: string[] = [];
  const glob = new RegExp(
    "^" +
      args.pattern
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*\*/g, "\0")
        .replace(/\*/g, "[^/]*")
        .replace(/\?/g, "[^/]")
        .replace(/\0/g, ".*") +
      "$",
  );

  async function walk(dir: string) {
    for await (const entry of Deno.readDir(dir)) {
      const full = `${dir}/${entry.name}`;
      const rel = full.slice(base.length + 1);
      if (glob.test(rel) || glob.test(entry.name)) {
        matches.push(full);
      }
      if (entry.isDirectory) {
        await walk(full);
      }
    }
  }

  await walk(base);
  return matches.join("\n") || "(no matches)";
}

async function moveFile(args: { source: string; destination: string }): Promise<string> {
  const src = resolvePath(args.source);
  const dst = resolvePath(args.destination);
  const parent = dst.slice(0, dst.lastIndexOf("/"));
  if (parent) await Deno.mkdir(parent, { recursive: true });
  await Deno.rename(src, dst);
  return `Moved ${src} -> ${dst}`;
}

async function getFileInfo(args: { path: string }): Promise<string> {
  const p = resolvePath(args.path);
  const stat = await Deno.stat(p);
  return JSON.stringify(
    {
      path: p,
      size: stat.size,
      isFile: stat.isFile,
      isDirectory: stat.isDirectory,
      isSymlink: stat.isSymlink,
      modified: stat.mtime?.toISOString() ?? null,
      accessed: stat.atime?.toISOString() ?? null,
      created: stat.birthtime?.toISOString() ?? null,
      mode: stat.mode != null ? `0o${stat.mode.toString(8)}` : null,
    },
    null,
    2,
  );
}

// --- tools metadata ---

const TOOLS = [
  {
    name: "read_file",
    description: "Read the contents of a file",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "File path (relative to workspace or absolute)" } },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "Write content to a file, creating parent directories as needed",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path" },
        content: { type: "string", description: "Content to write" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "list_directory",
    description: "List directory contents with type and size info",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "Directory path" } },
      required: ["path"],
    },
  },
  {
    name: "search_files",
    description: "Search for files matching a glob pattern",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Glob pattern (e.g. **/*.ts)" },
        path: { type: "string", description: "Base directory (default: workspace root)" },
      },
      required: ["pattern"],
    },
  },
  {
    name: "move_file",
    description: "Move or rename a file",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", description: "Source path" },
        destination: { type: "string", description: "Destination path" },
      },
      required: ["source", "destination"],
    },
  },
  {
    name: "get_file_info",
    description: "Get file metadata (size, timestamps, permissions)",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "File path" } },
      required: ["path"],
    },
  },
];

// --- JSON-RPC dispatch ---

type JsonRpcMessage = {
  jsonrpc: string;
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
};

type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

// deno-lint-ignore no-explicit-any
const TOOL_HANDLERS: Record<string, (args: any) => Promise<string>> = {
  read_file: readFile,
  write_file: writeFile,
  list_directory: listDirectory,
  search_files: searchFiles,
  move_file: moveFile,
  get_file_info: getFileInfo,
};

async function handleMessage(msg: JsonRpcMessage): Promise<JsonRpcResponse | null> {
  const id = msg.id ?? null;

  // Notifications (no id) — silently accept
  if (msg.method === "notifications/initialized" || msg.method === "notifications/cancelled") {
    return null;
  }

  switch (msg.method) {
    case "initialize":
      return {
        jsonrpc: "2.0",
        id: id!,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "smolvm-filesystem", version: "1.0.0" },
        },
      };

    case "tools/list":
      return { jsonrpc: "2.0", id: id!, result: { tools: TOOLS } };

    case "tools/call": {
      const toolName = (msg.params?.name as string) ?? "";
      const toolArgs = (msg.params?.arguments as Record<string, unknown>) ?? {};
      const handler = TOOL_HANDLERS[toolName];
      if (!handler) {
        return {
          jsonrpc: "2.0",
          id: id!,
          result: {
            content: [{ type: "text", text: `Unknown tool: ${toolName}` }],
            isError: true,
          },
        };
      }
      try {
        const text = await handler(toolArgs);
        return {
          jsonrpc: "2.0",
          id: id!,
          result: { content: [{ type: "text", text }], isError: false },
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          jsonrpc: "2.0",
          id: id!,
          result: { content: [{ type: "text", text: message }], isError: true },
        };
      }
    }

    default:
      return {
        jsonrpc: "2.0",
        id: id!,
        error: { code: -32601, message: `Method not found: ${msg.method}` },
      };
  }
}

// --- stdio loop ---

async function main() {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const buf = new Uint8Array(65536);
  let buffer = "";

  while (true) {
    const n = await Deno.stdin.read(buf);
    if (n === null) break;
    buffer += decoder.decode(buf.subarray(0, n));

    let newlineIdx: number;
    while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newlineIdx).trim();
      buffer = buffer.slice(newlineIdx + 1);
      if (!line) continue;

      try {
        const msg: JsonRpcMessage = JSON.parse(line);
        const response = await handleMessage(msg);
        if (response) {
          await Deno.stdout.write(encoder.encode(JSON.stringify(response) + "\n"));
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        const errResp: JsonRpcResponse = {
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: `Parse error: ${message}` },
        };
        await Deno.stdout.write(encoder.encode(JSON.stringify(errResp) + "\n"));
      }
    }
  }
}

main();
