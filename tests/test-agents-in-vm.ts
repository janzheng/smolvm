/**
 * Live test: Run coding agents inside smolvm microVMs
 *
 * Prerequisites:
 * - smolvm serve running on :9090
 * - microVMs created: claude-vm, codex-vm, agents
 * - Agents installed: claude, codex, pi
 * - .env with ANTHROPIC_API_KEY and OPENAI_API_KEY
 */

const API = "http://127.0.0.1:9090/api/v1";

async function api(path: string, opts?: RequestInit) {
  const resp = await fetch(`${API}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  return resp.json();
}

async function exec(
  vmName: string,
  cmd: string,
  opts?: { env?: { name: string; value: string }[]; timeout_secs?: number },
) {
  return api(`/microvms/${vmName}/exec`, {
    method: "POST",
    body: JSON.stringify({
      command: ["sh", "-c", cmd],
      ...(opts?.env ? { env: opts.env } : {}),
      timeoutSecs: opts?.timeout_secs ?? 30,
    }),
  });
}

const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const OPENAI_KEY = Deno.env.get("OPENAI_API_KEY") ?? "";

// Helper: ensure non-root user exists and write key to a file accessible by that user
async function setupUser(vm: string, keyName: string, keyValue: string) {
  await exec(vm, "id agent 2>/dev/null || adduser -D -s /bin/sh agent");
  // Use env var from exec to write key file — exec runs as root
  await exec(
    vm,
    `echo "$${keyName}" > /tmp/.api-key && chmod 644 /tmp/.api-key`,
    { env: [{ name: keyName, value: keyValue }] },
  );
  // Verify
  const check = await exec(vm, "wc -c < /tmp/.api-key");
  return parseInt(check.stdout?.trim() ?? "0") > 10;
}

// ============================================================
// TEST 1: Claude Code — real coding task
// ============================================================
async function testClaudeCode() {
  console.log("\n=== TEST 1: Claude Code (v2.1.62) in claude-vm ===\n");
  const t0 = Date.now();

  if (!ANTHROPIC_KEY) {
    console.log("  SKIP: No ANTHROPIC_API_KEY");
    return { agent: "Claude Code", success: false, reason: "no key" };
  }

  const keyOk = await setupUser("claude-vm", "ANTHROPIC_API_KEY", ANTHROPIC_KEY);
  console.log(`  Key written: ${keyOk}`);

  // Write runner script (avoids quoting hell)
  const scriptContent = [
    "#!/bin/sh",
    'export ANTHROPIC_API_KEY=$(cat /tmp/.api-key)',
    'export HOME=/home/agent',
    'cd /tmp',
    'exec claude -p "$@" --dangerously-skip-permissions 2>&1',
  ].join("\n");

  await exec("claude-vm", `printf '${scriptContent.replace(/'/g, "'\\''")}' > /tmp/run.sh && chmod 755 /tmp/run.sh`);

  // Simple test first
  console.log("\n  --- Simple prompt ---");
  const t1 = Date.now();
  const simple = await exec(
    "claude-vm",
    'su - agent -c "/tmp/run.sh Say hello world"',
    { timeoutSecs: 60 },
  );
  console.log(`  Exit: ${simple.exit_code} (${((Date.now() - t1) / 1000).toFixed(1)}s)`);
  console.log(`  Output: ${simple.stdout?.trim().slice(0, 500)}`);
  if (simple.stderr) console.log(`  Stderr: ${simple.stderr?.slice(0, 200)}`);

  if (simple.exit_code !== 0) {
    await exec("claude-vm", "rm -f /tmp/.api-key");
    return { agent: "Claude Code", success: false, reason: simple.stdout?.trim().slice(0, 100), time: ((Date.now() - t0) / 1000).toFixed(1) };
  }

  // Real coding task
  console.log("\n  --- Coding task ---");
  const t2 = Date.now();
  const coding = await exec(
    "claude-vm",
    'su - agent -c "/tmp/run.sh Create a file called /tmp/fizzbuzz.js with a Node.js FizzBuzz for 1-15 then run it"',
    { timeoutSecs: 120 },
  );
  console.log(`  Exit: ${coding.exit_code} (${((Date.now() - t2) / 1000).toFixed(1)}s)`);
  console.log(`  Output:\n${coding.stdout?.slice(0, 2000)}`);

  // Verify file was created and works
  const verify = await exec("claude-vm", "test -f /tmp/fizzbuzz.js && node /tmp/fizzbuzz.js 2>&1 || echo 'FILE NOT FOUND'");
  console.log(`\n  Verification: ${verify.stdout?.trim().slice(0, 500)}`);

  await exec("claude-vm", "rm -f /tmp/.api-key");

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  return {
    agent: "Claude Code",
    success: coding.exit_code === 0,
    time: elapsed,
    created_file: verify.stdout?.includes("Fizz") || verify.stdout?.includes("Buzz"),
  };
}

// ============================================================
// TEST 2: Codex — explore what's possible without PTY
// ============================================================
async function testCodex() {
  console.log("\n=== TEST 2: OpenAI Codex (v0.106.0) in codex-vm ===\n");
  const t0 = Date.now();

  if (!OPENAI_KEY) {
    console.log("  SKIP: No OPENAI_API_KEY");
    return { agent: "Codex", success: false, reason: "no key" };
  }

  await setupUser("codex-vm", "OPENAI_API_KEY", OPENAI_KEY);

  // Check codex help for non-interactive options
  const help = await exec("codex-vm", "codex --help 2>&1 | head -40");
  console.log(`  Codex help:\n${help.stdout?.slice(0, 1500)}`);

  // Try with --quiet flag (reduces output), and pipe input
  console.log("\n  --- Attempting headless run ---");

  // Write runner script
  await exec("codex-vm", `cat > /tmp/run.sh << 'HEREDOC'
#!/bin/sh
export OPENAI_API_KEY=$(cat /tmp/.api-key)
export HOME=/home/agent
cd /tmp
codex --full-auto "$@" 2>&1
HEREDOC
chmod 755 /tmp/run.sh`);

  const t1 = Date.now();
  const result = await exec(
    "codex-vm",
    'su - agent -c "/tmp/run.sh Create hello.js that prints hello world"',
    { timeoutSecs: 60 },
  );
  console.log(`  Exit: ${result.exit_code} (${((Date.now() - t1) / 1000).toFixed(1)}s)`);
  console.log(`  Output: ${result.stdout?.slice(0, 1000)}`);
  if (result.stderr) console.log(`  Stderr: ${result.stderr?.slice(0, 500)}`);

  // Codex requires a PTY (terminal). Let's check if script(1) can provide one.
  if (result.stdout?.includes("not a terminal")) {
    console.log("\n  --- Codex requires TTY. Trying script(1) wrapper ---");

    await exec("codex-vm", "apk add --no-cache util-linux-misc 2>/dev/null || true", { timeoutSecs: 30 });

    await exec("codex-vm", `cat > /tmp/run-pty.sh << 'HEREDOC'
#!/bin/sh
export OPENAI_API_KEY=$(cat /tmp/.api-key)
export HOME=/home/agent
cd /tmp
script -qc "codex --full-auto \\"$1\\"" /dev/null 2>&1 | head -50
HEREDOC
chmod 755 /tmp/run-pty.sh`);

    const t2 = Date.now();
    const ptyResult = await exec(
      "codex-vm",
      'su - agent -c "/tmp/run-pty.sh \\"Create hello.js that prints hello world\\""',
      { timeoutSecs: 90 },
    );
    console.log(`  PTY Exit: ${ptyResult.exit_code} (${((Date.now() - t2) / 1000).toFixed(1)}s)`);
    console.log(`  PTY Output: ${ptyResult.stdout?.slice(0, 1500)}`);

    await exec("codex-vm", "rm -f /tmp/.api-key");
    return {
      agent: "Codex",
      success: ptyResult.exit_code === 0 && !ptyResult.stdout?.includes("not a terminal"),
      time: ((Date.now() - t0) / 1000).toFixed(1),
      needs_pty: true,
    };
  }

  await exec("codex-vm", "rm -f /tmp/.api-key");
  return {
    agent: "Codex",
    success: result.exit_code === 0,
    time: ((Date.now() - t0) / 1000).toFixed(1),
  };
}

// ============================================================
// TEST 3: Pi-Mono — headless coding task
// ============================================================
async function testPiMono() {
  console.log("\n=== TEST 3: Pi-Mono (v0.55.1) in agents ===\n");
  const t0 = Date.now();

  if (!ANTHROPIC_KEY) {
    console.log("  SKIP: No ANTHROPIC_API_KEY");
    return { agent: "Pi-Mono", success: false, reason: "no key" };
  }

  await setupUser("agents", "ANTHROPIC_API_KEY", ANTHROPIC_KEY);

  // Pi has --print/-p flag for non-interactive mode
  // And --provider flag to select the model provider
  // And --api-key flag for inline key
  await exec("agents", `cat > /tmp/run.sh << 'HEREDOC'
#!/bin/sh
export ANTHROPIC_API_KEY=$(cat /tmp/.api-key)
export HOME=/home/agent
cd /tmp
pi -p --provider anthropic --api-key "$ANTHROPIC_API_KEY" "$@" 2>&1 | head -80
HEREDOC
chmod 755 /tmp/run.sh`);

  console.log("  --- Simple prompt ---");
  const t1 = Date.now();
  const simple = await exec(
    "agents",
    'su - agent -c "/tmp/run.sh Say hello"',
    { timeoutSecs: 60 },
  );
  console.log(`  Exit: ${simple.exit_code} (${((Date.now() - t1) / 1000).toFixed(1)}s)`);
  console.log(`  Output: ${simple.stdout?.slice(0, 1000)}`);
  if (simple.stderr) console.log(`  Stderr: ${simple.stderr?.slice(0, 300)}`);

  // If simple works, try coding task
  if (simple.exit_code === 0 && !simple.stdout?.includes("error")) {
    console.log("\n  --- Coding task ---");
    const t2 = Date.now();
    const coding = await exec(
      "agents",
      'su - agent -c "/tmp/run.sh Create a file /tmp/hello-pi.js that prints Hello from Pi-Mono then run it with node"',
      { timeoutSecs: 90 },
    );
    console.log(`  Exit: ${coding.exit_code} (${((Date.now() - t2) / 1000).toFixed(1)}s)`);
    console.log(`  Output:\n${coding.stdout?.slice(0, 2000)}`);

    const verify = await exec("agents", "test -f /tmp/hello-pi.js && node /tmp/hello-pi.js 2>&1 || echo 'FILE NOT FOUND'");
    console.log(`\n  Verification: ${verify.stdout?.trim()}`);
  }

  await exec("agents", "rm -f /tmp/.api-key");
  return {
    agent: "Pi-Mono",
    success: simple.exit_code === 0,
    time: ((Date.now() - t0) / 1000).toFixed(1),
  };
}

// ============================================================
// MAIN
// ============================================================
async function main() {
  console.log("==============================================");
  console.log("  CODING AGENTS IN smolvm — LIVE TEST");
  console.log("==============================================");
  console.log(`  API keys: ANTHROPIC=${ANTHROPIC_KEY ? "set" : "MISSING"}, OPENAI=${OPENAI_KEY ? "set" : "MISSING"}\n`);

  // Disk usage
  console.log("--- Disk Usage ---");
  for (const vm of ["claude-vm", "codex-vm", "agents"]) {
    const df = await exec(vm, "df -h / | tail -1");
    console.log(`  ${vm}: ${df.stdout?.trim()}`);
  }

  const results = [];
  results.push(await testClaudeCode());
  results.push(await testCodex());
  results.push(await testPiMono());

  console.log("\n\n========================================");
  console.log("  RESULTS SUMMARY");
  console.log("========================================\n");
  console.log("| Agent | VM | Ran? | Time | Key Finding |");
  console.log("|---|---|---|---|---|");
  for (const r of results) {
    const vm = r.agent === "Claude Code" ? "claude-vm" : r.agent === "Codex" ? "codex-vm" : "agents";
    const finding = r.reason || (r.needs_pty ? "needs PTY" : r.created_file ? "created+ran file" : "");
    console.log(`| ${r.agent} | ${vm} | ${r.success ? "YES" : "NO"} | ${r.time ?? "-"} | ${finding} |`);
  }
}

main().catch(console.error);
