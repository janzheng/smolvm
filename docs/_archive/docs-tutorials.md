# Running Coding Agents in smolvm MicroVMs

Step-by-step tutorials for installing and running Claude Code, Pi-Mono,
Codex, and Gemini CLI inside smolvm microVMs. Each tutorial is standalone
— pick one and follow along.

**Prerequisites:**
- smolvm installed: `curl -fsSL https://smolmachines.com/install.sh | bash`
- smolvm serve running: `smolvm serve` (leave this in a separate terminal)
- API keys in your `.env` file (whichever agents you want to test)

**Convention:** All tutorials use the REST API via curl. Every command is
copy-paste ready. We use `jq` for JSON output — install with `brew install jq`
if needed.

---

## Table of Contents

1. [Claude Code](#1-claude-code) — Anthropic's coding agent
2. [Pi-Mono](#2-pi-mono) — Minimal open-source coding agent
3. [Codex](#3-codex) — OpenAI's coding agent
4. [Gemini CLI](#4-gemini-cli) — Google's coding agent
5. [All Four in One VM](#5-all-four-agents-in-one-vm) — The mega-VM

---

## 1. Claude Code

**What:** Anthropic's official coding agent CLI
**Package:** `@anthropic-ai/claude-code`
**Key:** `ANTHROPIC_API_KEY`
**Disk:** ~50MB (smallest of all agents)

### Step 1: Create the MicroVM

```bash
curl -s -X POST http://127.0.0.1:8080/api/v1/microvms \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "claude-vm",
    "cpus": 2,
    "memoryMb": 4096,
    "network": true
  }' | jq .
```

### Step 2: Start it

```bash
curl -s -X POST http://127.0.0.1:8080/api/v1/microvms/claude-vm/start \
  -H 'Content-Type: application/json' | jq .
```

Wait 2 seconds for boot:
```bash
sleep 2
```

### Step 3: Install Node.js and Claude Code

```bash
curl -s -X POST http://127.0.0.1:8080/api/v1/microvms/claude-vm/exec \
  -H 'Content-Type: application/json' \
  -d '{
    "command": ["sh", "-c", "apk add --no-cache nodejs npm git bash curl jq"],
    "timeout_secs": 60
  }' | jq '{exit_code, stdout: (.stdout[-200:])}'
```

```bash
curl -s -X POST http://127.0.0.1:8080/api/v1/microvms/claude-vm/exec \
  -H 'Content-Type: application/json' \
  -d '{
    "command": ["sh", "-c", "npm install -g @anthropic-ai/claude-code 2>&1 | tail -3"],
    "timeout_secs": 60
  }' | jq '{exit_code, stdout}'
```

### Step 4: Verify

```bash
curl -s -X POST http://127.0.0.1:8080/api/v1/microvms/claude-vm/exec \
  -H 'Content-Type: application/json' \
  -d '{
    "command": ["sh", "-c", "claude --version"],
    "timeout_secs": 10
  }' | jq -r .stdout
```

Expected: `2.1.62 (Claude Code)` (or newer)

### Step 5: Setup for running (non-root user + temp dir)

Claude Code refuses `--dangerously-skip-permissions` as root, and needs a
temp directory pre-created. This step is required.

```bash
curl -s -X POST http://127.0.0.1:8080/api/v1/microvms/claude-vm/exec \
  -H 'Content-Type: application/json' \
  -d '{
    "command": ["sh", "-c", "adduser -D -s /bin/sh agent && mkdir -p /home/agent/workspace /tmp/claude-1000 && chown -R agent:agent /home/agent /tmp/claude-1000 && su - agent -c \"cd /home/agent/workspace && git init && git config user.email agent@test && git config user.name Agent\" && echo SETUP_DONE"],
    "timeout_secs": 15
  }' | jq -r .stdout
```

### Step 6: Write the runner script

This avoids shell quoting nightmares when passing prompts through the API.

```bash
curl -s -X POST http://127.0.0.1:8080/api/v1/microvms/claude-vm/exec \
  -H 'Content-Type: application/json' \
  -d '{
    "command": ["sh", "-c", "cat > /tmp/run.sh << \"ENDSCRIPT\"\n#!/bin/sh\nexport ANTHROPIC_API_KEY=$(cat /tmp/.api-key)\nexport HOME=/home/agent\ncd /home/agent/workspace\nexec claude -p \"$1\" --dangerously-skip-permissions 2>&1\nENDSCRIPT\nchmod 755 /tmp/run.sh && echo RUNNER_READY"],
    "timeout_secs": 5
  }' | jq -r .stdout
```

### Step 7: Load your API key

Replace `YOUR_KEY_HERE` with your actual Anthropic API key, or source it:

```bash
# Option A: paste key directly
ANTHROPIC_API_KEY="test-ant-..."

# Option B: load from .env
export $(grep ANTHROPIC_API_KEY .env | xargs)
```

Write the key into the VM:

```bash
curl -s -X POST http://127.0.0.1:8080/api/v1/microvms/claude-vm/exec \
  -H 'Content-Type: application/json' \
  -d "$(jq -n --arg key "$ANTHROPIC_API_KEY" '{
    command: ["sh", "-c", "echo \"$KEY\" > /tmp/.api-key && chmod 644 /tmp/.api-key && echo KEY_LOADED"],
    env: [{name: "KEY", value: $key}],
    timeout_secs: 5
  }')" | jq -r .stdout
```

### Step 8: Run it!

**Simple prompt:**
```bash
curl -s -X POST http://127.0.0.1:8080/api/v1/microvms/claude-vm/exec \
  -H 'Content-Type: application/json' \
  -d '{
    "command": ["sh", "-c", "su - agent -c \"/tmp/run.sh \\\"Say hello world\\\"\""],
    "timeout_secs": 60
  }' | jq -r .stdout
```

**Real coding task:**
```bash
curl -s -X POST http://127.0.0.1:8080/api/v1/microvms/claude-vm/exec \
  -H 'Content-Type: application/json' \
  -d '{
    "command": ["sh", "-c", "su - agent -c \"/tmp/run.sh \\\"Create a file called counter.js that counts from 1 to 5 and run it with node\\\"\""],
    "timeout_secs": 120
  }' | jq -r .stdout
```

**Verify it created the file:**
```bash
curl -s -X POST http://127.0.0.1:8080/api/v1/microvms/claude-vm/exec \
  -H 'Content-Type: application/json' \
  -d '{
    "command": ["sh", "-c", "ls /home/agent/workspace/*.js && echo --- && node /home/agent/workspace/counter.js"],
    "timeout_secs": 10
  }' | jq -r .stdout
```

### Cleanup

```bash
curl -s -X POST http://127.0.0.1:8080/api/v1/microvms/claude-vm/stop \
  -H 'Content-Type: application/json' | jq .
curl -s -X DELETE http://127.0.0.1:8080/api/v1/microvms/claude-vm | jq .
```

### What to expect

- Simple prompts: ~3-4s response time
- Coding tasks (create + run file): ~10-16s
- Claude Code creates files using its Write tool and runs them with Bash
- Files persist in `/home/agent/workspace/` as long as the VM is running

### Troubleshooting

| Problem | Fix |
|---|---|
| "Not logged in" | API key not loaded — rerun Step 7 |
| "--dangerously-skip-permissions cannot be used with root" | Run as `agent` user, not root — check Step 5 |
| "EACCES: permission denied, mkdir '/tmp/claude-1000'" | Step 5 missing — create the temp dir |
| Prompt gets mangled | Use the runner script (Step 6), don't inline prompts |

---

## 2. Pi-Mono

**What:** Minimal open-source coding agent by Mario Zechner (badlogic)
**Package:** `@mariozechner/pi-coding-agent`
**Key:** Any LLM key (Anthropic, OpenAI, Google, etc.)
**Disk:** ~170MB (with `--ignore-scripts`)

Pi-Mono was the smoothest agent to get running — fully headless on first try.

### Step 1: Create the MicroVM

```bash
curl -s -X POST http://127.0.0.1:8080/api/v1/microvms \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "pi-vm",
    "cpus": 2,
    "memoryMb": 4096,
    "network": true
  }' | jq .
```

### Step 2: Start it

```bash
curl -s -X POST http://127.0.0.1:8080/api/v1/microvms/pi-vm/start \
  -H 'Content-Type: application/json' | jq .
sleep 2
```

### Step 3: Install Node.js and Pi-Mono

```bash
curl -s -X POST http://127.0.0.1:8080/api/v1/microvms/pi-vm/exec \
  -H 'Content-Type: application/json' \
  -d '{
    "command": ["sh", "-c", "apk add --no-cache nodejs npm git bash curl"],
    "timeout_secs": 60
  }' | jq '{exit_code, stdout: (.stdout[-200:])}'
```

Pi needs `--ignore-scripts` to skip native module compilation on Alpine:

```bash
curl -s -X POST http://127.0.0.1:8080/api/v1/microvms/pi-vm/exec \
  -H 'Content-Type: application/json' \
  -d '{
    "command": ["sh", "-c", "npm install -g --ignore-scripts @mariozechner/pi-coding-agent 2>&1 | tail -5"],
    "timeout_secs": 60
  }' | jq '{exit_code, stdout}'
```

### Step 4: Verify

```bash
curl -s -X POST http://127.0.0.1:8080/api/v1/microvms/pi-vm/exec \
  -H 'Content-Type: application/json' \
  -d '{
    "command": ["sh", "-c", "pi --version"],
    "timeout_secs": 10
  }' | jq -r .stdout
```

Expected: `0.55.1` (or newer)

### Step 5: Setup non-root user and workspace

```bash
curl -s -X POST http://127.0.0.1:8080/api/v1/microvms/pi-vm/exec \
  -H 'Content-Type: application/json' \
  -d '{
    "command": ["sh", "-c", "adduser -D -s /bin/sh agent && mkdir -p /home/agent/workspace && chown -R agent:agent /home/agent && su - agent -c \"cd /home/agent/workspace && git init && git config user.email agent@test && git config user.name Agent\" && echo SETUP_DONE"],
    "timeout_secs": 15
  }' | jq -r .stdout
```

### Step 6: Write the runner script

Pi uses `--provider` and `--model` flags to select the LLM backend:

```bash
curl -s -X POST http://127.0.0.1:8080/api/v1/microvms/pi-vm/exec \
  -H 'Content-Type: application/json' \
  -d '{
    "command": ["sh", "-c", "cat > /tmp/run.sh << \"ENDSCRIPT\"\n#!/bin/sh\nexport ANTHROPIC_API_KEY=$(cat /tmp/.api-key)\nexport HOME=/home/agent\ncd /home/agent/workspace\nexec pi -p --provider anthropic --model claude-sonnet-4-20250514 \"$1\" 2>&1\nENDSCRIPT\nchmod 755 /tmp/run.sh && echo RUNNER_READY"],
    "timeout_secs": 5
  }' | jq -r .stdout
```

> **Tip:** Change `--provider` and `--model` for other LLMs:
> - OpenAI: `--provider openai --model gpt-4o` (set `OPENAI_API_KEY`)
> - Google: `--provider google --model gemini-2.0-flash` (set `GEMINI_API_KEY`)

### Step 7: Load your API key

```bash
export $(grep ANTHROPIC_API_KEY .env | xargs)

curl -s -X POST http://127.0.0.1:8080/api/v1/microvms/pi-vm/exec \
  -H 'Content-Type: application/json' \
  -d "$(jq -n --arg key "$ANTHROPIC_API_KEY" '{
    command: ["sh", "-c", "echo \"$KEY\" > /tmp/.api-key && chmod 644 /tmp/.api-key && echo KEY_LOADED"],
    env: [{name: "KEY", value: $key}],
    timeout_secs: 5
  }')" | jq -r .stdout
```

### Step 8: Run it!

**Simple prompt:**
```bash
curl -s -X POST http://127.0.0.1:8080/api/v1/microvms/pi-vm/exec \
  -H 'Content-Type: application/json' \
  -d '{
    "command": ["sh", "-c", "su - agent -c \"/tmp/run.sh \\\"Say hello world\\\"\""],
    "timeout_secs": 60
  }' | jq -r .stdout
```

**Real coding task:**
```bash
curl -s -X POST http://127.0.0.1:8080/api/v1/microvms/pi-vm/exec \
  -H 'Content-Type: application/json' \
  -d '{
    "command": ["sh", "-c", "su - agent -c \"/tmp/run.sh \\\"Create a Node.js HTTP server in server.js that responds with JSON containing a greeting and timestamp, then create test.js that requests it and prints the response\\\"\""],
    "timeout_secs": 120
  }' | jq -r .stdout
```

**Verify and run the server+test:**
```bash
curl -s -X POST http://127.0.0.1:8080/api/v1/microvms/pi-vm/exec \
  -H 'Content-Type: application/json' \
  -d '{
    "command": ["sh", "-c", "su - agent -c \"cd /home/agent/workspace && ls *.js && echo --- && timeout 5 sh -c \\\"node server.js & sleep 1 && node test.js && kill %1\\\"\""],
    "timeout_secs": 15
  }' | jq -r .stdout
```

### Cleanup

```bash
curl -s -X POST http://127.0.0.1:8080/api/v1/microvms/pi-vm/stop \
  -H 'Content-Type: application/json' | jq .
curl -s -X DELETE http://127.0.0.1:8080/api/v1/microvms/pi-vm | jq .
```

### What to expect

- Simple prompts: ~3s
- Coding tasks: ~8-10s
- Pi has 4 built-in tools: `read`, `write`, `edit`, `bash`
- It creates files AND runs them — the HTTP server test produces real JSON output
- Cleanest headless experience of all agents tested

### Troubleshooting

| Problem | Fix |
|---|---|
| "No models available" | API key not loaded or `--provider`/`--model` missing |
| "--api-key requires a model" | Must specify both `--provider` and `--model` |
| "koffi" build error | Use `--ignore-scripts` in npm install |
| ENOSPC on install | Default overlay too small — see [resize tutorial](#resize-the-overlay) |

---

## 3. Codex

**What:** OpenAI's coding agent CLI
**Package:** `@openai/codex`
**Key:** `OPENAI_API_KEY` (needs `/v1/responses` API access)
**Disk:** ~23MB (smallest install)

> **Note:** Codex requires access to OpenAI's `/v1/responses` API endpoint.
> Standard API keys may return 401. You need a key with Codex access.

### Step 1: Create the MicroVM

```bash
curl -s -X POST http://127.0.0.1:8080/api/v1/microvms \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "codex-vm",
    "cpus": 2,
    "memoryMb": 4096,
    "network": true
  }' | jq .
```

### Step 2: Start it

```bash
curl -s -X POST http://127.0.0.1:8080/api/v1/microvms/codex-vm/start \
  -H 'Content-Type: application/json' | jq .
sleep 2
```

### Step 3: Install Node.js and Codex

```bash
curl -s -X POST http://127.0.0.1:8080/api/v1/microvms/codex-vm/exec \
  -H 'Content-Type: application/json' \
  -d '{
    "command": ["sh", "-c", "apk add --no-cache nodejs npm git bash curl"],
    "timeout_secs": 60
  }' | jq '{exit_code, stdout: (.stdout[-200:])}'
```

```bash
curl -s -X POST http://127.0.0.1:8080/api/v1/microvms/codex-vm/exec \
  -H 'Content-Type: application/json' \
  -d '{
    "command": ["sh", "-c", "npm install -g @openai/codex 2>&1 | tail -3"],
    "timeout_secs": 60
  }' | jq '{exit_code, stdout}'
```

### Step 4: Verify

```bash
curl -s -X POST http://127.0.0.1:8080/api/v1/microvms/codex-vm/exec \
  -H 'Content-Type: application/json' \
  -d '{
    "command": ["sh", "-c", "codex --version"],
    "timeout_secs": 10
  }' | jq -r .stdout
```

Expected: `codex-cli 0.106.0` (or newer)

### Step 5: Setup non-root user, workspace, and git repo

Codex requires a git repository — it refuses to run outside one.

```bash
curl -s -X POST http://127.0.0.1:8080/api/v1/microvms/codex-vm/exec \
  -H 'Content-Type: application/json' \
  -d '{
    "command": ["sh", "-c", "adduser -D -s /bin/sh agent && mkdir -p /home/agent/workspace && chown -R agent:agent /home/agent && su - agent -c \"cd /home/agent/workspace && git init && git config user.email agent@test && git config user.name Agent\" && echo SETUP_DONE"],
    "timeout_secs": 15
  }' | jq -r .stdout
```

### Step 6: Write the runner script

Codex uses `exec` subcommand for non-interactive mode and `--full-auto` for
autonomous operation:

```bash
curl -s -X POST http://127.0.0.1:8080/api/v1/microvms/codex-vm/exec \
  -H 'Content-Type: application/json' \
  -d '{
    "command": ["sh", "-c", "cat > /tmp/run.sh << \"ENDSCRIPT\"\n#!/bin/sh\nexport OPENAI_API_KEY=$(cat /tmp/.api-key)\nexport HOME=/home/agent\ncd /home/agent/workspace\nexec codex exec --full-auto \"$1\" 2>&1\nENDSCRIPT\nchmod 755 /tmp/run.sh && echo RUNNER_READY"],
    "timeout_secs": 5
  }' | jq -r .stdout
```

### Step 7: Load your API key

```bash
export $(grep OPENAI_API_KEY .env | xargs)

curl -s -X POST http://127.0.0.1:8080/api/v1/microvms/codex-vm/exec \
  -H 'Content-Type: application/json' \
  -d "$(jq -n --arg key "$OPENAI_API_KEY" '{
    command: ["sh", "-c", "echo \"$KEY\" > /tmp/.api-key && chmod 644 /tmp/.api-key && echo KEY_LOADED"],
    env: [{name: "KEY", value: $key}],
    timeout_secs: 5
  }')" | jq -r .stdout
```

### Step 8: Run it!

```bash
curl -s -X POST http://127.0.0.1:8080/api/v1/microvms/codex-vm/exec \
  -H 'Content-Type: application/json' \
  -d '{
    "command": ["sh", "-c", "su - agent -c \"/tmp/run.sh \\\"Create hello.js that prints Hello from Codex and run it\\\"\""],
    "timeout_secs": 120
  }' | jq -r .stdout
```

### Cleanup

```bash
curl -s -X POST http://127.0.0.1:8080/api/v1/microvms/codex-vm/stop \
  -H 'Content-Type: application/json' | jq .
curl -s -X DELETE http://127.0.0.1:8080/api/v1/microvms/codex-vm | jq .
```

### Troubleshooting

| Problem | Fix |
|---|---|
| "Not inside a trusted directory" | Must `git init` in the workspace — check Step 5 |
| "stdout is not a terminal" | Use `codex exec` subcommand, not `codex` directly |
| 401 Unauthorized on `/v1/responses` | Your API key doesn't have Codex access |
| "unrecognized subcommand" | Prompt went to wrong arg — use the runner script |

---

## 4. Gemini CLI

**What:** Google's coding agent CLI
**Package:** `@google/gemini-cli`
**Key:** `GEMINI_API_KEY` (from [Google AI Studio](https://aistudio.google.com/))
**Disk:** ~400MB (largest — needs expanded overlay)

> **Important:** Gemini CLI is too large for the default 487MB overlay.
> This tutorial includes the overlay resize step.

### Step 1: Create the MicroVM with larger overlay

```bash
curl -s -X POST http://127.0.0.1:8080/api/v1/microvms \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "gemini-vm",
    "cpus": 2,
    "memoryMb": 4096,
    "network": true,
    "overlay_gb": 4
  }' | jq .
```

### Step 2: Start it

```bash
curl -s -X POST http://127.0.0.1:8080/api/v1/microvms/gemini-vm/start \
  -H 'Content-Type: application/json' | jq .
sleep 2
```

### Step 3: Resize the overlay filesystem

This is the key step. The disk is 4GB but the filesystem is only 487MB.
`resize2fs` expands it to fill the disk:

```bash
curl -s -X POST http://127.0.0.1:8080/api/v1/microvms/gemini-vm/exec \
  -H 'Content-Type: application/json' \
  -d '{
    "command": ["sh", "-c", "apk add --no-cache e2fsprogs-extra && resize2fs /dev/vdb 2>&1 && echo --- && df -h /"],
    "timeout_secs": 15
  }' | jq -r .stdout
```

You should see the overlay jump from `487.2M` to `3.9G`.

### Step 4: Install Node.js, build tools, and Gemini CLI

Gemini has native modules that need compilation:

```bash
curl -s -X POST http://127.0.0.1:8080/api/v1/microvms/gemini-vm/exec \
  -H 'Content-Type: application/json' \
  -d '{
    "command": ["sh", "-c", "apk add --no-cache nodejs npm git bash curl python3 make g++ 2>&1 | tail -3"],
    "timeout_secs": 60
  }' | jq '{exit_code, stdout}'
```

```bash
curl -s -X POST http://127.0.0.1:8080/api/v1/microvms/gemini-vm/exec \
  -H 'Content-Type: application/json' \
  -d '{
    "command": ["sh", "-c", "npm install -g @google/gemini-cli 2>&1 | tail -5"],
    "timeout_secs": 120
  }' | jq '{exit_code, stdout}'
```

### Step 5: Verify

```bash
curl -s -X POST http://127.0.0.1:8080/api/v1/microvms/gemini-vm/exec \
  -H 'Content-Type: application/json' \
  -d '{
    "command": ["sh", "-c", "gemini --version && echo --- && df -h /"],
    "timeout_secs": 10
  }' | jq -r .stdout
```

Expected: `0.30.0` (or newer), overlay ~25% used.

### Step 6: Setup non-root user and workspace

```bash
curl -s -X POST http://127.0.0.1:8080/api/v1/microvms/gemini-vm/exec \
  -H 'Content-Type: application/json' \
  -d '{
    "command": ["sh", "-c", "adduser -D -s /bin/sh agent && mkdir -p /home/agent/workspace && chown -R agent:agent /home/agent && su - agent -c \"cd /home/agent/workspace && git init && git config user.email agent@test && git config user.name Agent\" && echo SETUP_DONE"],
    "timeout_secs": 15
  }' | jq -r .stdout
```

### Step 7: Write the runner script

Gemini uses `--yolo` for autonomous mode (their version of
`--dangerously-skip-permissions`):

```bash
curl -s -X POST http://127.0.0.1:8080/api/v1/microvms/gemini-vm/exec \
  -H 'Content-Type: application/json' \
  -d '{
    "command": ["sh", "-c", "cat > /tmp/run.sh << \"ENDSCRIPT\"\n#!/bin/sh\nexport GEMINI_API_KEY=$(cat /tmp/.api-key)\nexport HOME=/home/agent\ncd /home/agent/workspace\nexec gemini -i \"$1\" --yolo 2>&1\nENDSCRIPT\nchmod 755 /tmp/run.sh && echo RUNNER_READY"],
    "timeout_secs": 5
  }' | jq -r .stdout
```

### Step 8: Load your API key

```bash
export $(grep GEMINI_API_KEY .env | xargs)

curl -s -X POST http://127.0.0.1:8080/api/v1/microvms/gemini-vm/exec \
  -H 'Content-Type: application/json' \
  -d "$(jq -n --arg key "$GEMINI_API_KEY" '{
    command: ["sh", "-c", "echo \"$KEY\" > /tmp/.api-key && chmod 644 /tmp/.api-key && echo KEY_LOADED"],
    env: [{name: "KEY", value: $key}],
    timeout_secs: 5
  }')" | jq -r .stdout
```

### Step 9: Run it!

```bash
curl -s -X POST http://127.0.0.1:8080/api/v1/microvms/gemini-vm/exec \
  -H 'Content-Type: application/json' \
  -d '{
    "command": ["sh", "-c", "su - agent -c \"/tmp/run.sh \\\"Create hello.js that prints Hello from Gemini and run it\\\"\""],
    "timeout_secs": 120
  }' | jq -r .stdout
```

### Cleanup

```bash
curl -s -X POST http://127.0.0.1:8080/api/v1/microvms/gemini-vm/stop \
  -H 'Content-Type: application/json' | jq .
curl -s -X DELETE http://127.0.0.1:8080/api/v1/microvms/gemini-vm | jq .
```

### Troubleshooting

| Problem | Fix |
|---|---|
| ENOSPC during npm install | Overlay not resized — run Step 3 |
| gyp ERR / node-gyp errors | Missing build tools — `apk add python3 make g++` |
| API key not found | Check `GEMINI_API_KEY` env var name (not `GOOGLE_API_KEY`) |

---

## 5. All Four Agents in One VM

Install Claude Code, Codex, Pi-Mono, and Gemini CLI in a single microVM.
Needs a 4GB overlay for Gemini to fit.

### Step 1: Create with 4GB overlay

```bash
curl -s -X POST http://127.0.0.1:8080/api/v1/microvms \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "mega-vm",
    "cpus": 2,
    "memoryMb": 4096,
    "network": true,
    "overlay_gb": 4
  }' | jq .
```

### Step 2: Start and resize

```bash
curl -s -X POST http://127.0.0.1:8080/api/v1/microvms/mega-vm/start \
  -H 'Content-Type: application/json' | jq .
sleep 2
```

```bash
curl -s -X POST http://127.0.0.1:8080/api/v1/microvms/mega-vm/exec \
  -H 'Content-Type: application/json' \
  -d '{
    "command": ["sh", "-c", "apk add --no-cache e2fsprogs-extra && resize2fs /dev/vdb 2>&1 | tail -3 && df -h /"],
    "timeout_secs": 15
  }' | jq -r .stdout
```

Confirm: overlay is now ~3.9G.

### Step 3: Install everything

```bash
# Base packages + build tools
curl -s -X POST http://127.0.0.1:8080/api/v1/microvms/mega-vm/exec \
  -H 'Content-Type: application/json' \
  -d '{
    "command": ["sh", "-c", "apk add --no-cache nodejs npm git bash curl python3 make g++ 2>&1 | tail -3"],
    "timeout_secs": 60
  }' | jq '{exit_code, stdout}'
```

```bash
# Claude Code
curl -s -X POST http://127.0.0.1:8080/api/v1/microvms/mega-vm/exec \
  -H 'Content-Type: application/json' \
  -d '{
    "command": ["sh", "-c", "npm install -g @anthropic-ai/claude-code 2>&1 | tail -3"],
    "timeout_secs": 60
  }' | jq -r .stdout
```

```bash
# Codex
curl -s -X POST http://127.0.0.1:8080/api/v1/microvms/mega-vm/exec \
  -H 'Content-Type: application/json' \
  -d '{
    "command": ["sh", "-c", "npm install -g @openai/codex 2>&1 | tail -3"],
    "timeout_secs": 60
  }' | jq -r .stdout
```

```bash
# Pi-Mono (with --ignore-scripts)
curl -s -X POST http://127.0.0.1:8080/api/v1/microvms/mega-vm/exec \
  -H 'Content-Type: application/json' \
  -d '{
    "command": ["sh", "-c", "npm install -g --ignore-scripts @mariozechner/pi-coding-agent 2>&1 | tail -3"],
    "timeout_secs": 60
  }' | jq -r .stdout
```

```bash
# Gemini CLI
curl -s -X POST http://127.0.0.1:8080/api/v1/microvms/mega-vm/exec \
  -H 'Content-Type: application/json' \
  -d '{
    "command": ["sh", "-c", "npm install -g @google/gemini-cli 2>&1 | tail -5"],
    "timeout_secs": 120
  }' | jq -r .stdout
```

### Step 4: Verify all four

```bash
curl -s -X POST http://127.0.0.1:8080/api/v1/microvms/mega-vm/exec \
  -H 'Content-Type: application/json' \
  -d '{
    "command": ["sh", "-c", "echo \"Claude Code: $(claude --version 2>&1)\" && echo \"Codex: $(codex --version 2>&1)\" && echo \"Pi-Mono: $(pi --version 2>&1)\" && echo \"Gemini CLI: $(gemini --version 2>&1)\" && echo --- && df -h /"],
    "timeout_secs": 15
  }' | jq -r .stdout
```

Expected output:
```
Claude Code: 2.1.62 (Claude Code)
Codex: codex-cli 0.106.0
Pi-Mono: 0.55.1
Gemini CLI: 0.30.0
---
Filesystem                Size      Used Available Use% Mounted on
overlay                   3.9G      1.5G      2.4G  39% /
```

### Step 5: Setup agent user

```bash
curl -s -X POST http://127.0.0.1:8080/api/v1/microvms/mega-vm/exec \
  -H 'Content-Type: application/json' \
  -d '{
    "command": ["sh", "-c", "adduser -D -s /bin/sh agent && mkdir -p /home/agent/workspace /tmp/claude-1000 && chown -R agent:agent /home/agent /tmp/claude-1000 && su - agent -c \"cd /home/agent/workspace && git init && git config user.email agent@test && git config user.name Agent\" && echo SETUP_DONE"],
    "timeout_secs": 15
  }' | jq -r .stdout
```

### Step 6: Write runner scripts for each agent

```bash
curl -s -X POST http://127.0.0.1:8080/api/v1/microvms/mega-vm/exec \
  -H 'Content-Type: application/json' \
  -d '{
    "command": ["sh", "-c", "cat > /tmp/run-claude.sh << \"ENDSCRIPT\"\n#!/bin/sh\nexport ANTHROPIC_API_KEY=$(cat /tmp/.anthropic-key)\nexport HOME=/home/agent\ncd /home/agent/workspace\nexec claude -p \"$1\" --dangerously-skip-permissions 2>&1\nENDSCRIPT\nchmod 755 /tmp/run-claude.sh && cat > /tmp/run-codex.sh << \"ENDSCRIPT\"\n#!/bin/sh\nexport OPENAI_API_KEY=$(cat /tmp/.openai-key)\nexport HOME=/home/agent\ncd /home/agent/workspace\nexec codex exec --full-auto \"$1\" 2>&1\nENDSCRIPT\nchmod 755 /tmp/run-codex.sh && cat > /tmp/run-pi.sh << \"ENDSCRIPT\"\n#!/bin/sh\nexport ANTHROPIC_API_KEY=$(cat /tmp/.anthropic-key)\nexport HOME=/home/agent\ncd /home/agent/workspace\nexec pi -p --provider anthropic --model claude-sonnet-4-20250514 \"$1\" 2>&1\nENDSCRIPT\nchmod 755 /tmp/run-pi.sh && cat > /tmp/run-gemini.sh << \"ENDSCRIPT\"\n#!/bin/sh\nexport GEMINI_API_KEY=$(cat /tmp/.gemini-key)\nexport HOME=/home/agent\ncd /home/agent/workspace\nexec gemini -i \"$1\" --yolo 2>&1\nENDSCRIPT\nchmod 755 /tmp/run-gemini.sh && echo ALL_RUNNERS_READY"],
    "timeout_secs": 10
  }' | jq -r .stdout
```

### Step 7: Load API keys

```bash
export $(grep ANTHROPIC_API_KEY .env | xargs)
export $(grep OPENAI_API_KEY .env | xargs)
# export $(grep GEMINI_API_KEY .env | xargs)  # if you have one

curl -s -X POST http://127.0.0.1:8080/api/v1/microvms/mega-vm/exec \
  -H 'Content-Type: application/json' \
  -d "$(jq -n --arg akey "${ANTHROPIC_API_KEY:-}" --arg okey "${OPENAI_API_KEY:-}" --arg gkey "${GEMINI_API_KEY:-}" '{
    command: ["sh", "-c", "echo \"$AKEY\" > /tmp/.anthropic-key && echo \"$OKEY\" > /tmp/.openai-key && echo \"$GKEY\" > /tmp/.gemini-key && chmod 644 /tmp/.anthropic-key /tmp/.openai-key /tmp/.gemini-key && echo KEYS_LOADED"],
    env: [{name:"AKEY",value:$akey},{name:"OKEY",value:$okey},{name:"GKEY",value:$gkey}],
    timeout_secs: 5
  }')" | jq -r .stdout
```

### Step 8: Run any agent!

**Claude Code:**
```bash
curl -s -X POST http://127.0.0.1:8080/api/v1/microvms/mega-vm/exec \
  -H 'Content-Type: application/json' \
  -d '{
    "command": ["sh", "-c", "su - agent -c \"/tmp/run-claude.sh \\\"Say hello from Claude Code\\\"\""],
    "timeout_secs": 60
  }' | jq -r .stdout
```

**Pi-Mono:**
```bash
curl -s -X POST http://127.0.0.1:8080/api/v1/microvms/mega-vm/exec \
  -H 'Content-Type: application/json' \
  -d '{
    "command": ["sh", "-c", "su - agent -c \"/tmp/run-pi.sh \\\"Say hello from Pi-Mono\\\"\""],
    "timeout_secs": 60
  }' | jq -r .stdout
```

**Codex:**
```bash
curl -s -X POST http://127.0.0.1:8080/api/v1/microvms/mega-vm/exec \
  -H 'Content-Type: application/json' \
  -d '{
    "command": ["sh", "-c", "su - agent -c \"/tmp/run-codex.sh \\\"Say hello from Codex\\\"\""],
    "timeout_secs": 60
  }' | jq -r .stdout
```

**Gemini CLI:**
```bash
curl -s -X POST http://127.0.0.1:8080/api/v1/microvms/mega-vm/exec \
  -H 'Content-Type: application/json' \
  -d '{
    "command": ["sh", "-c", "su - agent -c \"/tmp/run-gemini.sh \\\"Say hello from Gemini\\\"\""],
    "timeout_secs": 60
  }' | jq -r .stdout
```

### Cleanup

```bash
curl -s -X POST http://127.0.0.1:8080/api/v1/microvms/mega-vm/stop \
  -H 'Content-Type: application/json' | jq .
curl -s -X DELETE http://127.0.0.1:8080/api/v1/microvms/mega-vm | jq .
```

---

## Appendix: Resize the Overlay

If you hit ENOSPC (disk full) during any install, you need a bigger overlay.

**Option A: Create a new VM with `overlay_gb`**

```bash
curl -s -X POST http://127.0.0.1:8080/api/v1/microvms \
  -H 'Content-Type: application/json' \
  -d '{"name": "big-vm", "cpus": 2, "memoryMb": 4096, "network": true, "overlay_gb": 4}'
```

**Option B: After boot, resize the filesystem**

The disk is already the right size — just the filesystem needs expanding:

```bash
# Install resize tool and expand
curl -s -X POST http://127.0.0.1:8080/api/v1/microvms/YOUR_VM/exec \
  -H 'Content-Type: application/json' \
  -d '{
    "command": ["sh", "-c", "apk add --no-cache e2fsprogs-extra && resize2fs /dev/vdb && df -h /"],
    "timeout_secs": 15
  }' | jq -r .stdout
```

**Why this is needed:** smolvm creates the correct disk size (e.g., 4GB for
`overlay_gb: 4`) but formats the ext4 filesystem at only 487MB. This is
likely a bug that will be fixed in a future version. Until then, `resize2fs`
expands the filesystem to fill the disk.

**Device reference:**
- `/dev/vdb` = overlay (rootfs changes, where `apk add` and `npm install` go)
- `/dev/vda` = storage (OCI layers, mounted at `/storage`)

Both can be resized with `resize2fs`.

---

## Quick Reference

| Agent | Package | Install | Headless Flag | Auto-Approve | Key Env Var |
|---|---|---|---|---|---|
| Claude Code | `@anthropic-ai/claude-code` | 10s | `-p "prompt"` | `--dangerously-skip-permissions` | `ANTHROPIC_API_KEY` |
| Pi-Mono | `@mariozechner/pi-coding-agent` | 11s | `-p "prompt"` | (not needed) | `ANTHROPIC_API_KEY` + `--provider anthropic --model <model>` |
| Codex | `@openai/codex` | 8s | `exec "prompt"` | `--full-auto` | `OPENAI_API_KEY` |
| Gemini CLI | `@google/gemini-cli` | 13s | `-i "prompt"` | `--yolo` | `GEMINI_API_KEY` |
