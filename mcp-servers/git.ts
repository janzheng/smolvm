#!/usr/bin/env -S deno run --allow-run --allow-read --allow-env

// Git MCP Server — exposes git tools via MCP protocol (JSON-RPC over stdio)
// Runs inside machinees as a built-in MCP server for smolvm.

const WORKSPACE = Deno.env.get("WORKSPACE") || "/workspace";

// --- Git command helpers ---

async function runGit(args: string[], cwd?: string): Promise<{ stdout: string; stderr: string; code: number }> {
  const cmd = new Deno.Command("git", {
    args,
    cwd: cwd || WORKSPACE,
    stdout: "piped",
    stderr: "piped",
  });
  const output = await cmd.output();
  return {
    stdout: new TextDecoder().decode(output.stdout),
    stderr: new TextDecoder().decode(output.stderr),
    code: output.code,
  };
}

function assertOk(result: { stdout: string; stderr: string; code: number }): string {
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || `git exited with code ${result.code}`);
  }
  return result.stdout;
}

// --- Tool implementations ---

async function gitStatus(params: { path?: string }) {
  const cwd = params.path || WORKSPACE;
  const [statusResult, branchResult] = await Promise.all([
    runGit(["status", "--porcelain"], cwd),
    runGit(["branch", "--show-current"], cwd),
  ]);
  assertOk(statusResult);
  assertOk(branchResult);

  const changes = statusResult.stdout
    .split("\n")
    .filter((l) => l.trim())
    .map((line) => ({
      status: line.slice(0, 2).trim(),
      file: line.slice(3),
    }));

  return {
    branch: branchResult.stdout.trim(),
    changes,
    clean: changes.length === 0,
  };
}

async function gitDiff(params: { path?: string; staged?: boolean; file?: string }) {
  const cwd = params.path || WORKSPACE;
  const args = ["diff"];
  if (params.staged) args.push("--cached");
  if (params.file) args.push("--", params.file);
  const result = await runGit(args, cwd);
  return { diff: assertOk(result) };
}

async function gitLog(params: { path?: string; limit?: number; file?: string }) {
  const cwd = params.path || WORKSPACE;
  const limit = params.limit ?? 20;
  const args = [
    "log",
    `--max-count=${limit}`,
    "--format=%H%x00%an%x00%ae%x00%aI%x00%s",
  ];
  if (params.file) args.push("--", params.file);
  const result = await runGit(args, cwd);
  const out = assertOk(result);

  const entries = out
    .split("\n")
    .filter((l) => l.trim())
    .map((line) => {
      const [hash, author, email, date, subject] = line.split("\0");
      return { hash, author, email, date, subject };
    });

  return { entries, count: entries.length };
}

async function gitCommit(params: { message: string; files?: string[]; all?: boolean; path?: string }) {
  const cwd = params.path || WORKSPACE;

  if (params.files && params.files.length > 0) {
    assertOk(await runGit(["add", ...params.files], cwd));
  } else if (params.all) {
    assertOk(await runGit(["add", "-A"], cwd));
  }

  const result = await runGit(["commit", "-m", params.message], cwd);
  return { output: assertOk(result) };
}

async function gitBranch(params: { action: "list" | "create" | "switch"; name?: string; path?: string }) {
  const cwd = params.path || WORKSPACE;

  switch (params.action) {
    case "list": {
      const result = await runGit(["branch", "-a", "--format=%(refname:short) %(objectname:short) %(upstream:short)"], cwd);
      const branches = assertOk(result)
        .split("\n")
        .filter((l) => l.trim())
        .map((line) => {
          const parts = line.trim().split(/\s+/);
          return { name: parts[0], commit: parts[1], upstream: parts[2] || null };
        });
      const currentResult = await runGit(["branch", "--show-current"], cwd);
      return { branches, current: assertOk(currentResult).trim() };
    }
    case "create": {
      if (!params.name) throw new Error("branch name required for create");
      const result = await runGit(["branch", params.name], cwd);
      return { output: assertOk(result), created: params.name };
    }
    case "switch": {
      if (!params.name) throw new Error("branch name required for switch");
      const result = await runGit(["switch", params.name], cwd);
      return { output: assertOk(result).trim() || result.stderr.trim(), switched: params.name };
    }
    default:
      throw new Error(`unknown branch action: ${params.action}`);
  }
}

async function gitStash(params: { action: "push" | "pop" | "list"; message?: string; path?: string }) {
  const cwd = params.path || WORKSPACE;

  switch (params.action) {
    case "push": {
      const args = ["stash", "push"];
      if (params.message) args.push("-m", params.message);
      const result = await runGit(args, cwd);
      return { output: assertOk(result).trim() };
    }
    case "pop": {
      const result = await runGit(["stash", "pop"], cwd);
      return { output: assertOk(result).trim() };
    }
    case "list": {
      const result = await runGit(["stash", "list"], cwd);
      const stashes = assertOk(result)
        .split("\n")
        .filter((l) => l.trim())
        .map((line) => line.trim());
      return { stashes, count: stashes.length };
    }
    default:
      throw new Error(`unknown stash action: ${params.action}`);
  }
}

async function gitBlame(params: { file: string; path?: string }) {
  const cwd = params.path || WORKSPACE;
  const result = await runGit(["blame", "--porcelain", params.file], cwd);
  const raw = assertOk(result);

  // Parse porcelain blame into structured entries
  const lines: { hash: string; author: string; date: string; lineNo: number; content: string }[] = [];
  const chunks = raw.split("\n");
  let i = 0;
  while (i < chunks.length) {
    const header = chunks[i];
    if (!header || !header.match(/^[0-9a-f]{40}/)) { i++; continue; }
    const [hash, , lineNo] = header.split(" ");
    let author = "";
    let date = "";
    i++;
    while (i < chunks.length && !chunks[i].startsWith("\t")) {
      if (chunks[i].startsWith("author ")) author = chunks[i].slice(7);
      if (chunks[i].startsWith("author-time ")) {
        const ts = parseInt(chunks[i].slice(12));
        date = new Date(ts * 1000).toISOString();
      }
      i++;
    }
    const content = i < chunks.length ? chunks[i].slice(1) : "";
    lines.push({ hash: hash.slice(0, 8), author, date, lineNo: parseInt(lineNo), content });
    i++;
  }

  return { lines, count: lines.length };
}

// --- Tool definitions ---

const TOOLS = [
  {
    name: "git_status",
    description: "Get repository status: current branch, changed files, and whether working tree is clean.",
    inputSchema: {
      type: "object" as const,
      properties: {
        path: { type: "string", description: "Repository path (default: /workspace)" },
      },
    },
  },
  {
    name: "git_diff",
    description: "Show diff of working tree or staged changes.",
    inputSchema: {
      type: "object" as const,
      properties: {
        path: { type: "string", description: "Repository path (default: /workspace)" },
        staged: { type: "boolean", description: "Show staged changes (--cached)" },
        file: { type: "string", description: "Diff a specific file" },
      },
    },
  },
  {
    name: "git_log",
    description: "Show commit history with hash, author, date, and subject.",
    inputSchema: {
      type: "object" as const,
      properties: {
        path: { type: "string", description: "Repository path (default: /workspace)" },
        limit: { type: "number", description: "Max entries (default: 20)" },
        file: { type: "string", description: "Log for a specific file" },
      },
    },
  },
  {
    name: "git_commit",
    description: "Stage files and create a commit.",
    inputSchema: {
      type: "object" as const,
      properties: {
        message: { type: "string", description: "Commit message" },
        files: { type: "array", items: { type: "string" }, description: "Files to stage" },
        all: { type: "boolean", description: "Stage all changes (git add -A)" },
        path: { type: "string", description: "Repository path (default: /workspace)" },
      },
      required: ["message"],
    },
  },
  {
    name: "git_branch",
    description: "List, create, or switch branches.",
    inputSchema: {
      type: "object" as const,
      properties: {
        action: { type: "string", enum: ["list", "create", "switch"], description: "Branch action" },
        name: { type: "string", description: "Branch name (for create/switch)" },
        path: { type: "string", description: "Repository path (default: /workspace)" },
      },
      required: ["action"],
    },
  },
  {
    name: "git_stash",
    description: "Stash, pop, or list stashed changes.",
    inputSchema: {
      type: "object" as const,
      properties: {
        action: { type: "string", enum: ["push", "pop", "list"], description: "Stash action" },
        message: { type: "string", description: "Stash message (for push)" },
        path: { type: "string", description: "Repository path (default: /workspace)" },
      },
      required: ["action"],
    },
  },
  {
    name: "git_blame",
    description: "Show per-line blame annotation for a file.",
    inputSchema: {
      type: "object" as const,
      properties: {
        file: { type: "string", description: "File to blame" },
        path: { type: "string", description: "Repository path (default: /workspace)" },
      },
      required: ["file"],
    },
  },
];

// deno-lint-ignore no-explicit-any
const TOOL_HANDLERS: Record<string, (params: any) => Promise<any>> = {
  git_status: gitStatus,
  git_diff: gitDiff,
  git_log: gitLog,
  git_commit: gitCommit,
  git_branch: gitBranch,
  git_stash: gitStash,
  git_blame: gitBlame,
};

// --- MCP message handler ---

// deno-lint-ignore no-explicit-any
async function handleMessage(msg: any): Promise<any> {
  // Notifications (no id) get no response
  if (msg.id === undefined) return null;

  switch (msg.method) {
    case "initialize":
      return {
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "smolvm-git", version: "1.0.0" },
        },
      };

    case "tools/list":
      return {
        jsonrpc: "2.0",
        id: msg.id,
        result: { tools: TOOLS },
      };

    case "tools/call": {
      const toolName = msg.params?.name;
      const handler = TOOL_HANDLERS[toolName];
      if (!handler) {
        return {
          jsonrpc: "2.0",
          id: msg.id,
          result: {
            content: [{ type: "text", text: `Unknown tool: ${toolName}` }],
            isError: true,
          },
        };
      }
      try {
        const result = await handler(msg.params?.arguments || {});
        return {
          jsonrpc: "2.0",
          id: msg.id,
          result: {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          },
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          jsonrpc: "2.0",
          id: msg.id,
          result: {
            content: [{ type: "text", text: `Error: ${message}` }],
            isError: true,
          },
        };
      }
    }

    default:
      return {
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: -32601, message: `Method not found: ${msg.method}` },
      };
  }
}

// --- Stdio transport ---

async function main() {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const buf = new Uint8Array(65536);
  let buffer = "";

  while (true) {
    const n = await Deno.stdin.read(buf);
    if (n === null) break;
    buffer += decoder.decode(buf.subarray(0, n));

    let newlineIdx;
    while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newlineIdx).trim();
      buffer = buffer.slice(newlineIdx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        const response = await handleMessage(msg);
        if (response) {
          await Deno.stdout.write(encoder.encode(JSON.stringify(response) + "\n"));
        }
      } catch {
        // Skip malformed JSON lines
      }
    }
  }
}

main();
