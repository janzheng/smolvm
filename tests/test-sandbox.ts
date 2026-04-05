/**
 * CX04 smolvm — Basic Sandbox Test
 *
 * Tests: REST API health, sandbox create/start/exec/stop/delete,
 * boot timing, and basic CLI fallback.
 */

import {
  BASE, API, type SandboxInfo,
  apiPost, apiGet, apiDelete, exec,
  createReporter,
} from "./_helpers.ts";

const SANDBOX_NAME = "cx04-basic-test";
const { test, summary } = createReporter();

// ============================================================================
// Cleanup any leftover sandbox
// ============================================================================

async function cleanupSandbox() {
  try { await apiPost(`/sandboxes/${SANDBOX_NAME}/stop`); } catch { /* */ }
  try { await apiDelete(`/sandboxes/${SANDBOX_NAME}`); } catch { /* */ }
}

// ============================================================================
// Tests
// ============================================================================

console.log("\n==========================================");
console.log("  CX04 smolvm — Basic Sandbox Test");
console.log("==========================================\n");

await cleanupSandbox();

// --- Health check ---
console.log("Health Check:");
{
  const resp = await fetch(`${BASE}/health`);
  const data = await resp.json();
  test("Server responds", resp.ok);
  test("Status is ok", data.status === "ok");
  test(`Version is ${data.version}`, !!data.version, `got ${data.version}`);
}

// --- Create sandbox ---
console.log("\nSandbox Lifecycle:");
const t0 = performance.now();
{
  const resp = await apiPost("/sandboxes", {
    name: SANDBOX_NAME,
    resources: { cpus: 2, memory_mb: 1024, network: true },
  });
  const data = await resp.json();
  test("Create sandbox (200)", resp.ok, `status=${resp.status}`);
  test("Sandbox name matches", data.name === SANDBOX_NAME);
  test("State is created", data.state === "created" || data.state === "stopped");
}

// --- Start sandbox ---
const tStartBegin = performance.now();
{
  const resp = await apiPost(`/sandboxes/${SANDBOX_NAME}/start`);
  const data = await resp.json();
  const startMs = Math.round(performance.now() - tStartBegin);
  test("Start sandbox", resp.ok, `status=${resp.status}`);
  test("State is running", data.state === "running");
  console.log(`     ⏱  Start time: ${startMs}ms`);
}

// --- First exec ---
const tExecBegin = performance.now();
{
  const result = await exec(SANDBOX_NAME, ["echo", "hello-smolvm"]);
  const execMs = Math.round(performance.now() - tExecBegin);
  test("First exec succeeds", result.exit_code === 0);
  test("Output correct", result.stdout.trim() === "hello-smolvm", `got: "${result.stdout.trim()}"`);
  console.log(`     ⏱  First exec: ${execMs}ms`);
  console.log(`     ⏱  Total (create→first exec): ${Math.round(performance.now() - t0)}ms`);
}

// --- Basic commands ---
console.log("\nBasic Commands:");
{
  const uname = await exec(SANDBOX_NAME, ["uname", "-a"]);
  test("uname -a", uname.exit_code === 0 && uname.stdout.includes("Linux"));

  const osRelease = await exec(SANDBOX_NAME, ["cat", "/etc/os-release"]);
  test("Read /etc/os-release", osRelease.exit_code === 0);
  const distro = osRelease.stdout.includes("Alpine") ? "Alpine" :
                 osRelease.stdout.includes("Ubuntu") ? "Ubuntu" : "Unknown";
  console.log(`     📦 Base distro: ${distro}`);

  const ls = await exec(SANDBOX_NAME, ["ls", "/"]);
  test("ls /", ls.exit_code === 0 && ls.stdout.length > 0);
}

// --- Shell commands ---
console.log("\nShell Commands:");
{
  const shell = await exec(SANDBOX_NAME, ["sh", "-c", "echo hello && echo world"]);
  test("Shell && chaining", shell.exit_code === 0 && shell.stdout.includes("hello") && shell.stdout.includes("world"));

  const pipe = await exec(SANDBOX_NAME, ["sh", "-c", "echo hello world | wc -w"]);
  test("Shell piping", pipe.exit_code === 0 && pipe.stdout.trim() === "2");

  const envTest = await exec(SANDBOX_NAME, ["sh", "-c", "echo $MY_VAR"], {
    env: [{ name: "MY_VAR", value: "smolvm-test-value" }],
  });
  test("Env var passthrough", envTest.stdout.trim() === "smolvm-test-value", `got: "${envTest.stdout.trim()}"`);
}

// --- Exit codes ---
console.log("\nExit Codes:");
{
  const zero = await exec(SANDBOX_NAME, ["sh", "-c", "exit 0"]);
  test("Exit code 0", zero.exit_code === 0);

  const fortyTwo = await exec(SANDBOX_NAME, ["sh", "-c", "exit 42"]);
  test("Exit code 42", fortyTwo.exit_code === 42, `got: ${fortyTwo.exit_code}`);

  const one = await exec(SANDBOX_NAME, ["sh", "-c", "exit 1"]);
  test("Exit code 1", one.exit_code === 1, `got: ${one.exit_code}`);
}

// --- Workdir ---
console.log("\nWorkdir:");
{
  const pwd = await exec(SANDBOX_NAME, ["pwd"], { workdir: "/tmp" });
  test("Workdir /tmp", pwd.stdout.trim() === "/tmp", `got: "${pwd.stdout.trim()}"`);
}

// --- Get sandbox info ---
console.log("\nSandbox Info:");
{
  const resp = await apiGet(`/sandboxes/${SANDBOX_NAME}`);
  const info: SandboxInfo = await resp.json();
  test("Get sandbox info", resp.ok);
  test("State still running", info.state === "running");
  test("Network enabled", info.network === true);
  console.log(`     📋 Resources: ${JSON.stringify(info.resources)}`);
}

// --- List sandboxes ---
{
  const resp = await apiGet("/sandboxes");
  const data = await resp.json();
  test("List sandboxes", resp.ok && data.sandboxes.length > 0);
  const found = data.sandboxes.find((s: SandboxInfo) => s.name === SANDBOX_NAME);
  test("Our sandbox in list", !!found);
}

// --- Runtime detection ---
console.log("\nRuntime Detection:");
{
  const tools: Record<string, string | null> = {};
  for (const [name, cmd] of Object.entries({
    sh: "which sh && echo 'available'",
    node: "node --version",
    npm: "npm --version",
    python3: "python3 --version",
    git: "git --version",
    curl: "curl --version | head -1",
    deno: "deno --version | head -1",
  })) {
    try {
      const r = await exec(SANDBOX_NAME, ["sh", "-c", cmd], { timeout_secs: 5 });
      tools[name] = r.exit_code === 0 && r.stdout.trim() ? r.stdout.trim().split("\n")[0] : null;
    } catch {
      tools[name] = null;
    }
  }
  for (const [name, version] of Object.entries(tools)) {
    console.log(`     ${version ? "✅" : "⬜"} ${name}: ${version ?? "not installed"}`);
  }
}

// --- Stop + Delete ---
console.log("\nCleanup:");
{
  const stopResp = await apiPost(`/sandboxes/${SANDBOX_NAME}/stop`);
  test("Stop sandbox", stopResp.ok, `status=${stopResp.status}`);

  const delResp = await apiDelete(`/sandboxes/${SANDBOX_NAME}`);
  test("Delete sandbox", delResp.ok, `status=${delResp.status}`);

  const getResp = await apiGet(`/sandboxes/${SANDBOX_NAME}`);
  test("Sandbox deleted (404)", getResp.status === 404);
}

// --- CLI fallback ---
console.log("\nCLI Fallback:");
{
  try {
    const proc = new Deno.Command("smolvm", {
      args: ["sandbox", "run", "--net", "alpine:latest", "--", "echo", "cli-works"],
      stdout: "piped",
      stderr: "piped",
    });
    const tCliStart = performance.now();
    const output = await proc.output();
    const cliMs = Math.round(performance.now() - tCliStart);
    const stdout = new TextDecoder().decode(output.stdout);
    test("CLI sandbox run", output.code === 0 && stdout.includes("cli-works"), `exit=${output.code}`);
    console.log(`     ⏱  CLI one-shot: ${cliMs}ms`);
  } catch (e) {
    test("CLI sandbox run", false, `error: ${e}`);
  }
}

summary();
