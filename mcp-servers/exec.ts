#!/usr/bin/env -S deno run --allow-run --allow-read --allow-write --allow-env

/**
 * smolvm exec MCP server
 *
 * Exposes command-execution tools inside a sandbox via MCP protocol
 * (JSON-RPC 2.0 over newline-delimited stdio).
 *
 * Tools: run_command, run_script, list_processes, kill_process, which
 */

const WORKSPACE = Deno.env.get("WORKSPACE") ?? "/workspace";
const DEFAULT_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// MCP protocol types
// ---------------------------------------------------------------------------

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: "run_command",
    description: "Execute a shell command and return its output",
    inputSchema: {
      type: "object" as const,
      properties: {
        command: { type: "string", description: "The command to run" },
        args: {
          type: "array",
          items: { type: "string" },
          description: "Arguments to pass to the command",
        },
        cwd: {
          type: "string",
          description: "Working directory (default: /workspace)",
        },
        timeout_ms: {
          type: "number",
          description: "Timeout in milliseconds (default: 30000)",
        },
      },
      required: ["command"],
    },
  },
  {
    name: "run_script",
    description: "Execute a multi-line script via an interpreter",
    inputSchema: {
      type: "object" as const,
      properties: {
        script: { type: "string", description: "The script content to run" },
        interpreter: {
          type: "string",
          description: 'Interpreter path (default: "/bin/sh")',
        },
        cwd: {
          type: "string",
          description: "Working directory (default: /workspace)",
        },
        timeout_ms: {
          type: "number",
          description: "Timeout in milliseconds (default: 30000)",
        },
      },
      required: ["script"],
    },
  },
  {
    name: "list_processes",
    description: "List running processes",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "kill_process",
    description: "Send a signal to a process",
    inputSchema: {
      type: "object" as const,
      properties: {
        pid: { type: "number", description: "Process ID to signal" },
        signal: {
          type: "string",
          description: 'Signal name (default: "TERM")',
        },
      },
      required: ["pid"],
    },
  },
  {
    name: "which",
    description: "Find the full path of a command",
    inputSchema: {
      type: "object" as const,
      properties: {
        command: { type: "string", description: "Command to locate" },
      },
      required: ["command"],
    },
  },
];

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

async function execCommand(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; exit_code: number }> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);

  try {
    const proc = new Deno.Command(cmd, {
      args,
      cwd,
      stdout: "piped",
      stderr: "piped",
      signal: ac.signal,
    });

    const output = await proc.output();
    const decoder = new TextDecoder();
    return {
      stdout: decoder.decode(output.stdout),
      stderr: decoder.decode(output.stderr),
      exit_code: output.code,
    };
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      return { stdout: "", stderr: `Timed out after ${timeoutMs}ms`, exit_code: 124 };
    }
    return { stdout: "", stderr: String(err), exit_code: 1 };
  } finally {
    clearTimeout(timer);
  }
}

async function toolRunCommand(params: Record<string, unknown>) {
  const command = params.command as string;
  const args = (params.args as string[] | undefined) ?? [];
  const cwd = (params.cwd as string | undefined) ?? WORKSPACE;
  const timeoutMs = (params.timeout_ms as number | undefined) ?? DEFAULT_TIMEOUT_MS;
  return await execCommand(command, args, cwd, timeoutMs);
}

async function toolRunScript(params: Record<string, unknown>) {
  const script = params.script as string;
  const interpreter = (params.interpreter as string | undefined) ?? "/bin/sh";
  const cwd = (params.cwd as string | undefined) ?? WORKSPACE;
  const timeoutMs = (params.timeout_ms as number | undefined) ?? DEFAULT_TIMEOUT_MS;

  const tmpFile = await Deno.makeTempFile({ suffix: ".sh" });
  try {
    await Deno.writeTextFile(tmpFile, script);
    await Deno.chmod(tmpFile, 0o755);
    return await execCommand(interpreter, [tmpFile], cwd, timeoutMs);
  } finally {
    try { await Deno.remove(tmpFile); } catch { /* ignore */ }
  }
}

async function toolListProcesses() {
  const result = await execCommand("ps", ["aux"], WORKSPACE, DEFAULT_TIMEOUT_MS);
  if (result.exit_code !== 0) return result;

  const lines = result.stdout.trim().split("\n");
  const header = lines[0];
  const processes = lines.slice(1).map((line) => {
    const parts = line.trim().split(/\s+/);
    return {
      user: parts[0],
      pid: Number(parts[1]),
      cpu: parts[2],
      mem: parts[3],
      command: parts.slice(10).join(" "),
    };
  });
  return { header, processes, exit_code: result.exit_code };
}

function toolKillProcess(params: Record<string, unknown>) {
  const pid = params.pid as number;
  const signal = (params.signal as string | undefined) ?? "TERM";

  try {
    const sig = signal as Deno.Signal;
    Deno.kill(pid, sig);
    return { success: true, pid, signal };
  } catch (err) {
    return { success: false, pid, signal, error: String(err) };
  }
}

async function toolWhich(params: Record<string, unknown>) {
  const command = params.command as string;
  const result = await execCommand("which", [command], WORKSPACE, 5000);
  const path = result.stdout.trim();
  return { command, path: path || null, found: result.exit_code === 0 };
}

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------

async function handleMessage(msg: JsonRpcRequest): Promise<JsonRpcResponse | null> {
  const id = msg.id ?? null;

  // Notifications (no id) that we don't need to respond to
  if (msg.method === "notifications/initialized") return null;

  switch (msg.method) {
    case "initialize":
      return {
        jsonrpc: "2.0",
        id: id!,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "smolvm-exec", version: "1.0.0" },
        },
      };

    case "tools/list":
      return {
        jsonrpc: "2.0",
        id: id!,
        result: { tools: TOOLS },
      };

    case "tools/call": {
      const params = msg.params ?? {};
      const toolName = params.name as string;
      const toolArgs = (params.arguments as Record<string, unknown>) ?? {};

      let result: unknown;
      let isError = false;

      try {
        switch (toolName) {
          case "run_command":
            result = await toolRunCommand(toolArgs);
            break;
          case "run_script":
            result = await toolRunScript(toolArgs);
            break;
          case "list_processes":
            result = await toolListProcesses();
            break;
          case "kill_process":
            result = toolKillProcess(toolArgs);
            break;
          case "which":
            result = await toolWhich(toolArgs);
            break;
          default:
            isError = true;
            result = { error: `Unknown tool: ${toolName}` };
        }
      } catch (err) {
        isError = true;
        result = { error: String(err) };
      }

      return {
        jsonrpc: "2.0",
        id: id!,
        result: {
          content: [{ type: "text", text: JSON.stringify(result) }],
          isError,
        },
      };
    }

    default:
      return {
        jsonrpc: "2.0",
        id: id!,
        error: { code: -32601, message: `Method not found: ${msg.method}` },
      };
  }
}

// ---------------------------------------------------------------------------
// Main loop — read newline-delimited JSON-RPC from stdin
// ---------------------------------------------------------------------------

async function main() {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const buf = new Uint8Array(65536);
  let pending = "";

  while (true) {
    const n = await Deno.stdin.read(buf);
    if (n === null) break;
    pending += decoder.decode(buf.subarray(0, n));

    let newlineIdx: number;
    while ((newlineIdx = pending.indexOf("\n")) !== -1) {
      const line = pending.slice(0, newlineIdx).trim();
      pending = pending.slice(newlineIdx + 1);
      if (!line) continue;

      try {
        const msg = JSON.parse(line) as JsonRpcRequest;
        const response = await handleMessage(msg);
        if (response) {
          await Deno.stdout.write(
            encoder.encode(JSON.stringify(response) + "\n"),
          );
        }
      } catch (err) {
        const errResponse: JsonRpcResponse = {
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: `Parse error: ${err}` },
        };
        await Deno.stdout.write(
          encoder.encode(JSON.stringify(errResponse) + "\n"),
        );
      }
    }
  }
}

main();
