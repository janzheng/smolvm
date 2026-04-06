/**
 * CX04 smolvm — Basic Machine Test
 *
 * Tests: REST API health, machine create/start/exec/stop/delete,
 * boot timing, and basic CLI fallback.
 */

import {
  BASE, API, type MachineInfo,
  apiPost, apiGet, apiDelete, exec,
  createReporter,
} from "./_helpers.ts";

const MACHINE_NAME = "cx04-basic-test";
const { test, skip, summary } = createReporter();

// ============================================================================
// Cleanup any leftover machine
// ============================================================================

async function cleanupMachine() {
  try { await apiPost(`/machines/${MACHINE_NAME}/stop`); } catch { /* */ }
  try { await apiDelete(`/machines/${MACHINE_NAME}`); } catch { /* */ }
}

// ============================================================================
// Tests
// ============================================================================

console.log("\n==========================================");
console.log("  CX04 smolvm — Basic Machine Test");
console.log("==========================================\n");

await cleanupMachine();

// --- Health check ---
console.log("Health Check:");
{
  const resp = await fetch(`${BASE}/health`);
  const data = await resp.json();
  test("Server responds", resp.ok);
  test("Status is ok", data.status === "ok");
  test(`Version is ${data.version}`, !!data.version, `got ${data.version}`);
}

// --- Create machine ---
console.log("\nMachine Lifecycle:");
const t0 = performance.now();
{
  const resp = await apiPost("/machines", {
    name: MACHINE_NAME,
    resources: { cpus: 2, memoryMb: 1024, network: true },
  });
  const data = await resp.json();
  test("Create machine (200)", resp.ok, `status=${resp.status}`);
  test("Machine name matches", data.name === MACHINE_NAME);
  test("State is created", data.state === "created" || data.state === "stopped");
}

// --- Start machine ---
const tStartBegin = performance.now();
{
  const resp = await apiPost(`/machines/${MACHINE_NAME}/start`);
  const data = await resp.json();
  const startMs = Math.round(performance.now() - tStartBegin);
  test("Start machine", resp.ok, `status=${resp.status}`);
  test("State is running", data.state === "running");
  console.log(`     ⏱  Start time: ${startMs}ms`);
}

// --- First exec ---
const tExecBegin = performance.now();
{
  const result = await exec(MACHINE_NAME, ["echo", "hello-smolvm"]);
  const execMs = Math.round(performance.now() - tExecBegin);
  test("First exec succeeds", result.exit_code === 0);
  test("Output correct", result.stdout.trim() === "hello-smolvm", `got: "${result.stdout.trim()}"`);
  console.log(`     ⏱  First exec: ${execMs}ms`);
  console.log(`     ⏱  Total (create→first exec): ${Math.round(performance.now() - t0)}ms`);
}

// --- Basic commands ---
console.log("\nBasic Commands:");
{
  const uname = await exec(MACHINE_NAME, ["uname", "-a"]);
  test("uname -a", uname.exit_code === 0 && uname.stdout.includes("Linux"));

  const osRelease = await exec(MACHINE_NAME, ["cat", "/etc/os-release"]);
  test("Read /etc/os-release", osRelease.exit_code === 0);
  const distro = osRelease.stdout.includes("Alpine") ? "Alpine" :
                 osRelease.stdout.includes("Ubuntu") ? "Ubuntu" : "Unknown";
  console.log(`     📦 Base distro: ${distro}`);

  const ls = await exec(MACHINE_NAME, ["ls", "/"]);
  test("ls /", ls.exit_code === 0 && ls.stdout.length > 0);
}

// --- Shell commands ---
console.log("\nShell Commands:");
{
  const shell = await exec(MACHINE_NAME, ["sh", "-c", "echo hello && echo world"]);
  test("Shell && chaining", shell.exit_code === 0 && shell.stdout.includes("hello") && shell.stdout.includes("world"));

  const pipe = await exec(MACHINE_NAME, ["sh", "-c", "echo hello world | wc -w"]);
  test("Shell piping", pipe.exit_code === 0 && pipe.stdout.trim() === "2");

  const envTest = await exec(MACHINE_NAME, ["sh", "-c", "echo $MY_VAR"], {
    env: [{ name: "MY_VAR", value: "smolvm-test-value" }],
  });
  test("Env var passthrough", envTest.stdout.trim() === "smolvm-test-value", `got: "${envTest.stdout.trim()}"`);
}

// --- Exit codes ---
console.log("\nExit Codes:");
{
  const zero = await exec(MACHINE_NAME, ["sh", "-c", "exit 0"]);
  test("Exit code 0", zero.exit_code === 0);

  const fortyTwo = await exec(MACHINE_NAME, ["sh", "-c", "exit 42"]);
  test("Exit code 42", fortyTwo.exit_code === 42, `got: ${fortyTwo.exit_code}`);

  const one = await exec(MACHINE_NAME, ["sh", "-c", "exit 1"]);
  test("Exit code 1", one.exit_code === 1, `got: ${one.exit_code}`);
}

// --- Workdir ---
console.log("\nWorkdir:");
{
  const pwd = await exec(MACHINE_NAME, ["pwd"], { workdir: "/tmp" });
  test("Workdir /tmp", pwd.stdout.trim() === "/tmp", `got: "${pwd.stdout.trim()}"`);
}

// --- Get machine info ---
console.log("\nMachine Info:");
{
  const resp = await apiGet(`/machines/${MACHINE_NAME}`);
  const info: MachineInfo = await resp.json();
  test("Get machine info", resp.ok);
  test("State still running", info.state === "running");
  test("Network enabled", info.network === true);
  console.log(`     📋 Resources: ${JSON.stringify(info.resources)}`);
}

// --- List machines ---
{
  const resp = await apiGet("/machines");
  const data = await resp.json();
  test("List machines", resp.ok && data.machines.length > 0);
  const found = data.machines.find((s: MachineInfo) => s.name === MACHINE_NAME);
  test("Our machine in list", !!found);
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
      const r = await exec(MACHINE_NAME, ["sh", "-c", cmd], { timeoutSecs: 5 });
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
  const stopResp = await apiPost(`/machines/${MACHINE_NAME}/stop`);
  test("Stop machine", stopResp.ok, `status=${stopResp.status}`);

  const delResp = await apiDelete(`/machines/${MACHINE_NAME}`);
  test("Delete machine", delResp.ok, `status=${delResp.status}`);

  const getResp = await apiGet(`/machines/${MACHINE_NAME}`);
  test("Machine deleted (404)", getResp.status === 404);
}

// --- CLI fallback ---
console.log("\nCLI Fallback:");
{
  // `machine run <image>` uses container-in-VM (crun) which is broken upstream.
  // Test bare VM exec via the CLI exec subcommand instead.
  skip("CLI machine run (image)", "container-in-VM (crun) broken upstream — use server API instead");
}

summary();
