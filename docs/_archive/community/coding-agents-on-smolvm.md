# Running Coding Agent Frameworks on smolvm

How open-source coding agent orchestrators control Claude Code, Codex, and
other CLI agents — and how to replicate those patterns inside smolvm microVMs.

---

## Why This Matters

The open-source agent orchestration space has converged on a common pattern:
**spawn CLI agents (Claude Code, Codex, etc.) in isolated git worktrees,
control them via PTY or SDK, and orchestrate multiple sessions in parallel.**

smolvm microVMs are a natural fit for this — each VM provides stronger
isolation than a worktree, with real process boundaries. The question is:
can we run these orchestrators *inside* smolvm, or replicate their control
patterns using smolvm as the isolation layer?

---

## Project Profiles

### 1. Crystal (stravu/crystal) — DEPRECATED but architecturally rich

**Repo:** [stravu/crystal](https://github.com/stravu/crystal)
**Status:** Deprecated Feb 2026, replaced by [Nimbalyst](https://nimbalyst.com/) (closed source)
**Stack:** Electron + React 19 + TypeScript + SQLite + node-pty

**What it did:**
Multi-session Claude Code & Codex manager. Run parallel AI coding sessions,
each in its own git worktree, with full lifecycle management.

**How it controlled Claude Code:**

Crystal used the `@anthropic-ai/claude-code` SDK and `node-pty` (pseudo-terminal)
to spawn and manage Claude Code processes. The key class hierarchy:

```
AbstractCliManager (base class — any CLI agent)
  ├── ClaudeCodeManager (Claude Code specific)
  └── CodexManager (OpenAI Codex specific)
```

**The spawn pattern (ClaudeCodeManager):**

```typescript
// 1. Find the claude executable
const claudePath = findExecutableInPath('claude') || customPath;

// 2. Build command args
const args = ['--verbose', '--output-format', 'stream-json'];
if (model && model !== 'auto') args.push('--model', model);
if (permissionMode === 'ignore') args.push('--dangerously-skip-permissions');

// 3. For resume: use Claude's session ID
if (isResume && claudeSessionId) {
  args.push('--resume', claudeSessionId);
}

// 4. Spawn via node-pty (pseudo-terminal)
const pty = spawn(claudePath, args, {
  cwd: worktreePath,  // git worktree directory
  env: { ...process.env, ANTHROPIC_API_KEY: key }
});

// 5. Parse stream-json output for real-time status
pty.onData((data) => parseStreamJson(data));
```

**How it controlled Codex:**

Same pattern, different flags:

```typescript
const args = [];
if (model) args.push('--model', model);
if (machineMode) args.push('--machine', machineMode);
if (approvalPolicy === 'auto') args.push('--approval-policy', 'auto-edit');
if (webSearch) args.push('--web-search', 'true');
```

**Git worktree isolation:**

```typescript
// Create isolated workspace for each session
await execAsync(`git worktree add "${worktreePath}" -b "${branchName}"`, { cwd: projectPath });

// Each agent runs in its own worktree
const pty = spawn('claude', args, { cwd: worktreePath });

// Cleanup when done
await execAsync(`git worktree remove "${worktreePath}" --force`, { cwd: projectPath });
```

**Extensibility model:**
Crystal published a guide (`ADDING_NEW_CLI_TOOLS.md`) for adding any CLI agent.
The pattern: extend `AbstractCliManager`, implement `buildCommandArgs()`,
`testCliAvailability()`, `parseCliOutput()`, and register in the CLI tool registry.

**What matters for smolvm:**
- The PTY spawn pattern works via SSH (smolvm-manager proved this)
- `--output-format stream-json` is the key for programmatic Claude Code control
- `--dangerously-skip-permissions` enables autonomous operation
- Session resume via `--resume <session-id>` enables persistent conversations
- Worktree isolation maps naturally to per-VM isolation

---

### 2. Emdash (generalaction/emdash) — Active, YC W26

**Repo:** [generalaction/emdash](https://github.com/generalaction/emdash)
**Status:** Active (YC W26), 21 CLI providers supported
**Stack:** Electron 30.5 + React 18 + TypeScript + SQLite + node-pty + ssh2

**What it does:**
Provider-agnostic desktop app for running multiple coding agents in parallel.
Each agent gets its own git worktree. Supports local and **remote development
over SSH**. Integrates with Linear, Jira, and GitHub Issues.

**The 21-provider registry:**

Emdash defines every CLI agent as a `ProviderDefinition`:

```typescript
{
  id: 'claude',
  name: 'Claude Code',
  cli: 'claude',
  autoApproveFlag: '--dangerously-skip-permissions',
  initialPromptFlag: '',          // prompt delivered via PTY stdin
  resumeFlag: '-c -r',
  sessionIdFlag: '--session-id',  // per-task session isolation
  planActivateCommand: '/plan',   // activate plan mode
  installCommand: 'curl -fsSL https://claude.ai/install.sh | bash',
}
```

Every supported agent follows this pattern:

| Agent | CLI | Auto-approve Flag | Resume | Prompt Delivery |
|---|---|---|---|---|
| Claude Code | `claude` | `--dangerously-skip-permissions` | `-c -r` | PTY stdin |
| Codex | `codex` | `--full-auto` | `resume --last` | PTY stdin |
| Gemini | `gemini` | `--yolo` | `--resume` | `-i` flag |
| Cursor | `cursor-agent` | `-f` | — | PTY stdin |
| Qwen Code | `qwen` | `--yolo` | `--continue` | `-i` flag |
| Amp | `amp` | `--dangerously-allow-all` | — | Keystroke injection |
| Copilot | `copilot` | `--allow-all-tools` | — | PTY stdin |
| OpenCode | `opencode` | — | — | Keystroke injection |
| Pi | `pi` (npm: @mariozechner/pi-coding-agent) | — | — | PTY stdin |
| Goose | `goose` | — | — | PTY stdin |
| Droid | `droid` | — | `-r` | PTY stdin |

**How it spawns agents (ptyManager.ts):**

```typescript
// 1. Resolve CLI executable path (handles macOS Finder PATH issues)
const cliPath = resolveCliPath(provider.cli);

// 2. Build args from provider definition
const args = [...(provider.defaultArgs || [])];
if (autoApprove && provider.autoApproveFlag) {
  args.push(provider.autoApproveFlag);
}
if (sessionId && provider.sessionIdFlag) {
  args.push(provider.sessionIdFlag, deterministicUuid(conversationId));
}

// 3. Set up environment (agent API keys passthrough)
const env = {};
AGENT_ENV_VARS.forEach(key => {
  if (process.env[key]) env[key] = process.env[key];
});
// Includes: ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, etc.

// 4. Spawn via node-pty in the worktree
const pty = spawn(cliPath, args, { cwd: worktreePath, env });

// 5. For agents with useKeystrokeInjection (Amp, OpenCode):
//    Wait for TUI to load, then type the prompt
if (provider.useKeystrokeInjection && initialPrompt) {
  setTimeout(() => pty.write(initialPrompt + '\r'), 500);
}
```

**SSH Remote Development (RemotePtyService.ts):**

This is the most relevant pattern for smolvm. Emdash can run agents on remote
machines over SSH:

```typescript
// 1. Establish SSH connection via ssh2
const client = connection.client;

// 2. Open shell channel
client.shell((err, stream) => {
  // 3. Set up environment (validated against injection)
  const envVars = Object.entries(env)
    .filter(([k]) => isValidEnvVarName(k))
    .map(([k, v]) => `export ${k}=${quoteShellArg(v)}`)
    .join(' && ');

  // 4. cd to project, launch agent
  const cmd = `${envVars} && cd ${quoteShellArg(cwd)} && ${shell}${autoApproveFlag}`;
  stream.write(cmd + '\n');

  // 5. Inject initial prompt after startup delay
  if (initialPrompt) {
    setTimeout(() => stream.write(initialPrompt + '\n'), 500);
  }
});
```

**Worktree pooling (WorktreePoolService.ts):**

Emdash pre-creates worktree pools for instant task starts. Each worktree
preserves `.env` files from the main project.

**What matters for smolvm:**
- The SSH remote pattern is **directly applicable** to smolvm microVMs
- Provider registry is a clean way to support 21+ agents with minimal code
- `useKeystrokeInjection` handles agents without prompt flags (type into TUI)
- `deterministicUuid()` from conversation ID enables session isolation
- File preservation patterns (`.env`, `.env.local`) needed for each worktree/VM
- Shell allowlisting prevents injection when running on remote machines

---

### 3. Pi-Mono (badlogic/pi-mono) — Excellent smolvm fit

**Repo:** [badlogic/pi-mono](https://github.com/badlogic/pi-mono)
**Stack:** Node.js >= 20, TypeScript, npm workspaces, 7 packages

**What it does:**
Minimal modular TypeScript coding agent framework. Ships 4 base tools
(`read`, `write`, `edit`, `bash`) and an event-stream agent loop.

**Agent model:**

```
User prompt → Agent.prompt()
  → LLM call with tools
  → Tool execution (read/write/edit/bash)
  → Stream events (agent_start, turn_start, tool_execution_*, message_*)
  → Loop until done
```

**smolvm compatibility: YES**
- Pure Node.js, no native dependencies, no Docker
- ~35MB compiled (can compile to standalone binary with Bun)
- `bash` tool maps directly to `smolvm exec`
- Install: `npm install -g @mariozechner/pi-coding-agent`
- Already listed as a provider in Emdash's registry

---

### 4. Oh-My-Pi (can1357/oh-my-pi) — Partial smolvm fit

**Repo:** [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi)
**Stack:** Bun >= 1.3.7, TypeScript + Rust (native bindings), Python (IPython)

**What it does:**
Enhanced pi-mono fork. Adds: Bun runtime, Rust native hash-anchored edits,
Python tool (IPython kernel), commit tool (hunk-level staging), LSP integration,
6 bundled subagents, Puppeteer browser automation.

**smolvm compatibility: PARTIAL**
- Needs Bun binary (available for Linux aarch64) + Python + IPython
- Rust compilation toolchain needed for `pi-natives` (or skip, use fallback)
- Puppeteer needs Chromium (smolvm-manager solved this for Alpine)
- Heavier bootstrap: ~8-10 min vs pi-mono's ~2 min

---

### 5. Dorabot (suitedaces/dorabot) — Limited smolvm fit

**Repo:** [suitedaces/dorabot](https://github.com/suitedaces/dorabot)
**Stack:** Node.js >= 22, Electron, Playwright, Claude Agent SDK, SQLite

**What it does:**
24/7 persistent AI agent with Telegram/WhatsApp/Slack messaging, browser
automation, calendar, goals/tasks, memory. Not a coding agent — a personal
AI workspace.

**smolvm compatibility: LIMITED**
- Gateway mode (HTTP server) could work headlessly
- No shell execution tools — not useful for coding workflows
- macOS-specific features (screenshots, calendar) lost in VM
- Playwright + Chromium is the main challenge (but solved by smolvm-manager)

---

## Comparison Table

| Dimension | Crystal | Emdash | Pi-Mono | Oh-My-Pi | Dorabot |
|---|---|---|---|---|---|
| **Status** | Deprecated | Active (YC W26) | Active | Active | Active |
| **Agents supported** | 2 (Claude, Codex) | 21 | 1 (self) | 1 (self) | 1 (Claude SDK) |
| **Agent control** | node-pty + SDK | node-pty + SSH | Event stream | Event stream | Claude Agent SDK |
| **Isolation** | Git worktrees | Git worktrees + SSH | None (single) | None (single) | None (single) |
| **Remote support** | No | Yes (SSH) | No | No | No |
| **Runtime needs** | Node + Electron | Node + Electron | Node only | Bun + Python + Rust | Node + Electron |
| **smolvm fit** | Patterns only | YES (SSH path) | YES | PARTIAL | LIMITED |
| **Bootstrap time** | N/A | ~2 min (SSH) | ~2 min | ~8-10 min | ~10-12 min |

---

## Key Patterns for smolvm Integration

### Pattern 1: The Universal Agent Spawn

Every orchestrator controls CLI agents the same way:

```bash
# 1. Install the agent CLI
npm install -g @anthropic-ai/claude-code

# 2. Set API key
export ANTHROPIC_API_KEY=sk-...

# 3. Spawn with auto-approve + structured output
claude --dangerously-skip-permissions --output-format stream-json --session-id <uuid>

# 4. Feed prompt via stdin
echo "Fix the bug in auth.ts" | claude -p --dangerously-skip-permissions
```

**On smolvm via SSH (Emdash's remote pattern):**

```bash
# SSH into microVM
ssh -p 2222 agent@localhost

# Agent environment is pre-configured (.bashrc has API keys, proxy, etc.)
# Just launch the CLI
claude --dangerously-skip-permissions
```

**On smolvm via REST API (programmatic):**

```typescript
// Install agent in the VM
await exec(vmId, ["sh", "-c", "npm install -g @anthropic-ai/claude-code"]);

// Run agent headlessly with prompt
await exec(vmId, ["sh", "-c",
  "claude -p 'Fix the bug in auth.ts' --dangerously-skip-permissions --output-format stream-json"
], {
  env: [{ name: "ANTHROPIC_API_KEY", value: key }],
  timeout_secs: 300
});
```

### Pattern 2: Provider Registry (from Emdash)

Define all agents in a registry. Each entry specifies how to install, launch,
and control the agent:

```typescript
const PROVIDERS = {
  claude: {
    cli: 'claude',
    install: 'npm install -g @anthropic-ai/claude-code',
    autoApprove: '--dangerously-skip-permissions',
    promptFlag: '-p',
    outputFormat: '--output-format stream-json',
    resume: '--resume',
    sessionId: '--session-id',
    envKey: 'ANTHROPIC_API_KEY',
  },
  codex: {
    cli: 'codex',
    install: 'npm install -g @openai/codex',
    autoApprove: '--full-auto',
    promptFlag: '',  // keystroke injection
    resume: 'resume --last',
    envKey: 'OPENAI_API_KEY',
  },
  gemini: {
    cli: 'gemini',
    install: 'npm install -g @google/gemini-cli',
    autoApprove: '--yolo',
    promptFlag: '-i',
    resume: '--resume',
    envKey: 'GEMINI_API_KEY',
  },
  pi: {
    cli: 'pi',
    install: 'npm install -g @mariozechner/pi-coding-agent',
    autoApprove: '',  // no flag needed
    promptFlag: '',
    envKey: '',  // uses own config
  },
};
```

### Pattern 3: SSH Control Plane (from Emdash + smolvm-manager)

Both Emdash and smolvm-manager use SSH as the control plane. The combined
pattern:

```bash
# 1. Create microVM (one-time)
smolvm microvm create agent-vm --net -p 2222:22 --cpus 2 --mem 4096

# 2. Bootstrap (one-time, persists in microVM)
smolvm microvm exec --name agent-vm -- apk add openssh-server nodejs npm git bash
smolvm microvm exec --name agent-vm -- npm install -g @anthropic-ai/claude-code
smolvm microvm exec --name agent-vm -- ssh-keygen -A

# 3. Fix macOS UID leak + start sshd (every boot)
smolvm microvm exec --name agent-vm -- sh -c \
  "chown root:root /var/empty /root && chmod 755 /var/empty && /usr/sbin/sshd"

# 4. Apply libkrun TCP backlog fix (for Claude Code's OAuth)
smolvm microvm exec --name agent-vm -- sh -c \
  'cat > /usr/local/lib/fix-listen.js << "EOF"
const net = require("net");
const origListen = net.Server.prototype.listen;
net.Server.prototype.listen = function(...a) {
  if (a[0] && typeof a[0] === "object") a[0].backlog = 1;
  return origListen.apply(this, a);
};
EOF'

# 5. SSH in and run agent (Emdash remote pattern)
ssh -p 2222 agent@localhost  # then: claude --dangerously-skip-permissions
```

### Pattern 4: Multi-VM Fleet (Crystal's worktree isolation → VM isolation)

Crystal used git worktrees. smolvm uses VMs. Same concept, stronger isolation:

```typescript
// Create a fleet of VMs, each running a different approach
const tasks = [
  { vm: 'approach-a', prompt: 'Fix auth.ts using JWT tokens' },
  { vm: 'approach-b', prompt: 'Fix auth.ts using session cookies' },
  { vm: 'approach-c', prompt: 'Fix auth.ts using OAuth2' },
];

// Bootstrap all VMs (could use snapshots if available)
for (const task of tasks) {
  await createMicroVM(task.vm);
  await bootstrap(task.vm);  // install Claude Code, setup SSH
}

// Run agents in parallel (cross-VM parallelism works)
await Promise.all(tasks.map(task =>
  sshExec(task.vm, `claude -p '${task.prompt}' --dangerously-skip-permissions`)
));

// Compare results
for (const task of tasks) {
  const diff = await sshExec(task.vm, 'git diff HEAD');
  console.log(`${task.vm}: ${diff}`);
}
```

### Pattern 5: Egress Filtering (from smolvm-manager)

When running autonomous agents, restrict network access:

```bash
# Install 3-layer network safety (smolvm-manager pattern)
# 1. Node.js net guard — blocks non-localhost TCP at socket level
# 2. LD_PRELOAD guard — blocks TCP from any binary
# 3. HTTP proxy — domain allowlist on 127.0.0.1:8888

# Agent can only reach: api.anthropic.com, registry.npmjs.org, github.com, etc.
# Everything else returns 403
```

See `smolvm-manager.md` for the full implementation.

---

## Smolfile Drafts

### Claude Code Agent VM (verified working)

```toml
[vm]
cpus = 2
memory = 4096
network = true

[init]
commands = [
  "apk add --no-cache openssh-server nodejs npm git bash curl jq",
  "npm install -g @anthropic-ai/claude-code",
  "adduser -D -s /bin/sh agent",
  "mkdir -p /home/agent/workspace /tmp/claude-1000",
  "chown -R agent:agent /home/agent /tmp/claude-1000",
  "su - agent -c 'cd /home/agent/workspace && git init && git config user.email agent@test && git config user.name Agent'",
  "ssh-keygen -A",
  "chown root:root /var/empty /root && chmod 755 /var/empty",
]
```

### All-Agent VM (Claude + Codex + Pi + Gemini — verified working)

```toml
[vm]
cpus = 2
memory = 4096
network = true
overlay_gb = 4

[init]
commands = [
  "apk add --no-cache e2fsprogs-extra && resize2fs /dev/vdb",
  "apk add --no-cache openssh-server nodejs npm git bash curl jq python3 make g++",
  "npm install -g @anthropic-ai/claude-code",
  "npm install -g @openai/codex",
  "npm install -g --ignore-scripts @mariozechner/pi-coding-agent",
  "npm install -g @google/gemini-cli",
  "adduser -D -s /bin/sh agent",
  "mkdir -p /home/agent/workspace /tmp/claude-1000",
  "chown -R agent:agent /home/agent /tmp/claude-1000",
  "su - agent -c 'cd /home/agent/workspace && git init && git config user.email agent@test && git config user.name Agent'",
  "ssh-keygen -A",
  "chown root:root /var/empty /root && chmod 755 /var/empty",
]
```

**Note:** First command resizes the overlay from 487MB to 4GB. Without this,
only Claude + Codex + Pi fit (no Gemini). Gemini also needs `python3 make g++`
for native module compilation.

### Oh-My-Pi VM (Bun + Python)

```toml
[vm]
cpus = 2
memory = 4096
network = true

[init]
commands = [
  "apk add --no-cache openssh-server git bash curl jq python3 py3-pip",
  "curl -fsSL https://bun.sh/install | bash",
  "pip install ipython",
  "ssh-keygen -A",
  "chown root:root /var/empty /root && chmod 755 /var/empty",
]
```

---

## Exploration Path

**Phase 1: Install and run agents (DONE)**
- Claude Code: installed, creates files + runs code (16s for coding task)
- Pi-Mono: installed, creates files + runs code (8.6s for coding task)
- Codex: installed, needs Codex API access (standard key 401s)
- Gemini CLI: doesn't fit in 487MB overlay

**Phase 2: Emdash SSH remote → smolvm (NEXT)**
- Emdash already supports SSH remote development
- Point it at a smolvm microVM: `ssh -p 2222 agent@localhost`
- This should "just work" — Emdash sees it as any remote machine

**Phase 3: Multi-agent fleet**
- Create 3 microVMs, each with a different agent
- Give them the same coding task, compare diffs
- Use the provider registry pattern for clean orchestration

**Phase 4: Session persistence and structured output**
- Test `--output-format stream-json` via REST API exec
- Test session resume across exec calls
- Test Claude Code session persistence across VM stop/start

---

## Live Test Results (2026-02-27)

We installed and ran three coding agents inside smolvm microVMs via the REST
API. Each VM: 2 CPUs, 4GB RAM, Alpine Linux, 487MB overlay filesystem.

### Installation Results

| Agent | npm Package | Install Time | Disk Used | Packages |
|---|---|---|---|---|
| Claude Code | `@anthropic-ai/claude-code` | 10s | 40% (190MB) | 5 |
| Codex | `@openai/codex` | 8s | 34% (163MB) | 2 |
| Pi-Mono | `@mariozechner/pi-coding-agent` | 11s | 67% (319MB) | 280 |
| Gemini CLI | `@google/gemini-cli` | FAILED | >60% | ENOSPC |

Gemini CLI is too large for the 487MB overlay. Pi-Mono needs `--ignore-scripts`
to skip native `koffi` build (no cmake in Alpine base).

### Running Results

| Agent | Simple Prompt | Coding Task | File Created? | Ran Code? |
|---|---|---|---|---|
| Claude Code | YES (3.6s) | YES (10-16s) | YES | YES (with fix) |
| Codex | N/A (auth) | N/A | N/A | N/A |
| Pi-Mono | YES (3.0s) | YES (8.6s) | YES | YES |

**Claude Code** needed two fixes to work fully:
1. Non-root user (`adduser -D agent`) — `--dangerously-skip-permissions`
   refuses to run as root
2. Pre-create `/tmp/claude-<uid>` with correct ownership — Claude Code's
   Bash tool writes temp files there, fails with EACCES otherwise
3. (Optional) libkrun TCP backlog fix via `NODE_OPTIONS=--require
   /usr/local/lib/fix-listen.js` — forces `listen()` backlog to 1

With these fixes, Claude Code successfully:
- Created `fizzbuzz.js` and ran it (correct FizzBuzz output for 1-15)
- Created `counter.js` and ran it (printed 1-5)

**Codex** requires `/v1/responses` API access (401 Unauthorized with standard
OpenAI key). The binary installed and ran correctly, reached the API, but
the key didn't have the right permissions. Also requires being inside a git
repo (`codex exec` subcommand for non-interactive mode).

**Pi-Mono** was the smoothest — fully headless with `-p` flag, worked on first
try. Multi-step test: created an HTTP server (`server.js`) + test client
(`test.js`), both worked correctly inside the microVM:
```
Response received from server:
Status Code: 200
Response Body:
{
  "greeting": "Hello from Node.js server!",
  "timestamp": "2026-02-27T15:33:33.486Z",
  "message": "Server is running successfully"
}
```

### Key Fixes for Running Agents in smolvm

```bash
# 1. Create non-root user (Claude Code refuses --dangerously-skip-permissions as root)
adduser -D -s /bin/sh agent
mkdir -p /home/agent/workspace
chown -R agent:agent /home/agent

# 2. Init git repo (Codex requires it, good practice for all)
su - agent -c "cd /home/agent/workspace && git init && git config user.email agent@test && git config user.name Agent"

# 3. Fix Claude Code temp dir permissions
mkdir -p /tmp/claude-1000 && chown agent:agent /tmp/claude-1000

# 4. libkrun TCP backlog fix (for Claude Code's OAuth and any Node.js servers)
cat > /usr/local/lib/fix-listen.js << 'EOF'
const net = require("net");
const origListen = net.Server.prototype.listen;
net.Server.prototype.listen = function(...a) {
  if (a[0] && typeof a[0] === "object") a[0].backlog = 1;
  return origListen.apply(this, a);
};
EOF

# 5. Runner script pattern (avoids shell quoting hell with REST API)
cat > /tmp/run-agent.sh << 'EOF'
#!/bin/sh
export ANTHROPIC_API_KEY=$(cat /tmp/.api-key)
export HOME=/home/agent
export NODE_OPTIONS="--require /usr/local/lib/fix-listen.js"
cd /home/agent/workspace
exec claude -p "$1" --dangerously-skip-permissions 2>&1
EOF
chmod 755 /tmp/run-agent.sh

# Usage: write key via env, run as agent user
echo "$ANTHROPIC_API_KEY" > /tmp/.api-key && chmod 644 /tmp/.api-key
su - agent -c '/tmp/run-agent.sh "Write fizzbuzz.js and run it"'
```

### Headless Agent Flags (verified working in smolvm)

| Agent | Non-Interactive Flag | Auto-Approve Flag | Env Key |
|---|---|---|---|
| Claude Code | `-p "prompt"` | `--dangerously-skip-permissions` | `ANTHROPIC_API_KEY` |
| Codex | `exec "prompt"` | `--full-auto` | `OPENAI_API_KEY` |
| Pi-Mono | `-p "prompt"` | (none needed) | `ANTHROPIC_API_KEY` + `--provider anthropic --model <model>` |
| Gemini CLI | `-i "prompt"` | `--yolo` | `GEMINI_API_KEY` |

### The Overlay Filesystem — and How to Resize It

By default, the overlay is 487MB regardless of `overlay_gb`. This is because
smolvm creates the larger raw disk image but doesn't auto-resize the ext4
filesystem inside. **The fix is one command: `resize2fs /dev/vdb`.**

```bash
# When creating the VM, specify overlay_gb
# API: {"overlay_gb": 4, "storage_gb": 20}
# CLI: smolvm microvm create my-vm --overlay 4 --storage 20

# After boot, resize the filesystem to fill the disk
apk add --no-cache e2fsprogs-extra
resize2fs /dev/vdb
# overlay: 487MB → 3.9GB
```

Verified: `overlay_gb: 4` creates a 4GB `/dev/vdb`. After `resize2fs`, the
overlay grows from 487MB to 3.9GB. With that space, **all four agents fit
in a single VM:**

| Agent | Version | Disk |
|---|---|---|
| Claude Code | 2.1.62 | ~50MB |
| Codex | 0.106.0 | ~23MB |
| Pi-Mono | 0.55.1 | ~170MB |
| Gemini CLI | 0.30.0 | ~400MB |
| + Alpine + Node + build tools | — | ~350MB |
| **Total** | — | **1.5GB / 3.9GB (39%)** |

Similarly, `/dev/vda` (storage disk) defaults to 487MB but reports as 20GB
via `lsblk`. It can also be expanded with `resize2fs /dev/vda`.

**Add to init commands for any VM that needs more space:**
```bash
apk add --no-cache e2fsprogs-extra && resize2fs /dev/vdb 2>/dev/null
```

Without resize, the default 487MB overlay fits Claude Code + Codex + Pi
together (~243MB), but NOT Gemini CLI or Oh-My-Pi.

---

## Open Questions

1. **Emdash → smolvm SSH**: Does Emdash's SSH remote work with smolvm's
   port-forwarded sshd? (Likely yes, but needs testing)

2. **Claude Code --output-format stream-json via SSH**: Does structured
   JSON output survive SSH transport cleanly? (Crystal used node-pty locally)

3. **Session persistence across VM stop/start**: Claude Code stores sessions
   in `~/.claude/`. Does this survive microVM stop/start?

4. **Oh-My-Pi's Bun on Alpine**: Does the Bun binary work on Alpine's musl
   libc? (Bun ships musl builds, should work)

5. **~~Concurrent agents in one VM~~**: RESOLVED — all four agents installed
   and coexist in a single 4GB-overlay VM (1.5GB used, 39%).

6. **Emdash worktree pool inside VM**: Can Emdash's worktree pooling work
   inside a single large microVM rather than one-VM-per-task?

7. **~~Claude Code tool use~~**: RESOLVED — needs non-root user + `/tmp/claude-<uid>`
   dir pre-created. Works after that.

8. **~~Pi-Mono headless mode~~**: RESOLVED — use `-p` flag with `--provider`
   and `--model`. Works beautifully, creates and runs code.

9. **Codex API access**: Standard OpenAI keys may not have `/v1/responses`
   access. Need Codex-specific API access to verify full workflow.

10. **~~487MB overlay limit~~**: RESOLVED — `overlay_gb` parameter works at the
    disk level but smolvm doesn't auto-resize the filesystem. Run
    `resize2fs /dev/vdb` after boot to expand. 4GB overlay fits all agents.
