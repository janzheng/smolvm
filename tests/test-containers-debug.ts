/**
 * CX04 smolvm — Container Lifecycle + Debug Diagnostics Test
 *
 * Tests: container create/ls/start/stop/exec/rm via REST API,
 * and debug mounts/network diagnostic endpoints.
 *
 * Requires a running smolvm server: deno task serve
 */

import {
  API,
  apiPost, apiGet, apiDelete,
  createAndStart, cleanup,
  createReporter,
} from "./_helpers.ts";

const MACHINE_NAME = `cx04-container-debug-${Date.now()}`;
const { test, skip, summary } = createReporter();

// ============================================================================
// Setup: create + start a machine
// ============================================================================

console.log("\n==========================================");
console.log("  CX04 smolvm — Containers + Debug Test");
console.log("==========================================\n");

await cleanup(MACHINE_NAME);

console.log("Setup:");
try {
  await createAndStart(MACHINE_NAME);
  test("Create + start machine", true);
} catch (e) {
  test("Create + start machine", false, `${e}`);
  summary();
  Deno.exit(1);
}

// ============================================================================
// Container Lifecycle (via REST API)
// ============================================================================

console.log("\nContainer Lifecycle:");

let containerId = "";

// --- Record baseline containers (may include stale from previous runs) ---
let baselineContainerIds: string[] = [];
{
  const resp = await apiGet(`/machines/${MACHINE_NAME}/containers`);
  if (resp.ok) {
    const data = await resp.json();
    baselineContainerIds = (data.containers ?? []).map((c: { id: string }) => c.id);
    test("List containers (baseline)", Array.isArray(data.containers));
    if (baselineContainerIds.length > 0) {
      console.log(`     ⚠️  ${baselineContainerIds.length} stale container(s) from previous runs`);
    }
  } else {
    const body = await resp.text();
    test("List containers (baseline)", false, `status=${resp.status}: ${body}`);
  }
}

// --- Create container ---
{
  const resp = await apiPost(`/machines/${MACHINE_NAME}/containers`, {
    image: "alpine:latest",
    command: ["sleep", "300"],
  });
  if (resp.ok) {
    const data = await resp.json();
    containerId = data.id ?? "";
    test("Create container", !!containerId, `id=${containerId}`);
    test("Container state is created/running", data.state === "created" || data.state === "running");
    test("Container image correct", data.image === "alpine:latest");
  } else {
    const text = await resp.text();
    test("Create container", false, `status=${resp.status}: ${text}`);
  }
}

// --- List containers (has one) ---
if (containerId) {
  const resp = await apiGet(`/machines/${MACHINE_NAME}/containers`);
  if (resp.ok) {
    const data = await resp.json();
    const newContainers = (data.containers ?? []).filter((c: { id: string }) => !baselineContainerIds.includes(c.id));
    test("List containers (has one new)", newContainers.length === 1, `got ${newContainers.length} new (${data.containers.length} total)`);
    const found = newContainers.find((c: { id: string }) => c.id === containerId);
    test("Our container in list", !!found);
  } else {
    const body = await resp.text();
    test("List containers (has one)", false, `status=${resp.status}: ${body}`);
  }
}

// --- Start container ---
if (containerId) {
  const resp = await apiPost(`/machines/${MACHINE_NAME}/containers/${containerId}/start`);
  if (resp.ok) {
    test("Start container", true);
  } else {
    // May already be running from create — that's OK
    const text = await resp.text();
    const alreadyRunning = text.includes("already running") || text.includes("Running");
    test("Start container", alreadyRunning, `status=${resp.status}: ${text}`);
  }
}

// --- Exec in container ---
if (containerId) {
  const resp = await apiPost(`/machines/${MACHINE_NAME}/containers/${containerId}/exec`, {
    command: ["echo", "hello-from-container"],
    timeoutSecs: 15,
  });
  if (resp.ok) {
    const data = await resp.json();
    const exitCode = data.exit_code ?? data.exitCode ?? -1;
    test("Exec in container", exitCode === 0);
    test("Exec output correct", (data.stdout ?? "").trim() === "hello-from-container",
      `got: "${(data.stdout ?? "").trim()}"`);
  } else {
    const text = await resp.text();
    test("Exec in container", false, `status=${resp.status}: ${text}`);
  }
}

// --- Exec with env vars ---
if (containerId) {
  const resp = await apiPost(`/machines/${MACHINE_NAME}/containers/${containerId}/exec`, {
    command: ["sh", "-c", "echo $TEST_VAR"],
    env: [{ name: "TEST_VAR", value: "container-env-test" }],
    timeoutSecs: 15,
  });
  if (resp.ok) {
    const data = await resp.json();
    test("Exec with env var", (data.stdout ?? "").trim() === "container-env-test",
      `got: "${(data.stdout ?? "").trim()}"`);
  } else {
    const text = await resp.text();
    test("Exec with env var", false, `status=${resp.status}: ${text}`);
  }
}

// --- Stop container ---
if (containerId) {
  const resp = await apiPost(`/machines/${MACHINE_NAME}/containers/${containerId}/stop`, {
    timeoutSecs: 10,
  });
  if (resp.ok) {
    test("Stop container", true);
  } else {
    const text = await resp.text();
    test("Stop container", false, `status=${resp.status}: ${text}`);
  }
}

// --- Delete container ---
if (containerId) {
  const resp = await fetch(`${API}/machines/${MACHINE_NAME}/containers/${containerId}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ force: true }),
    signal: AbortSignal.timeout(30_000),
  });
  if (resp.ok) {
    test("Delete container", true);
  } else {
    const text = await resp.text();
    test("Delete container", false, `status=${resp.status}: ${text}`);
  }
}

// --- Verify container is gone ---
{
  const resp = await apiGet(`/machines/${MACHINE_NAME}/containers`);
  if (resp.ok) {
    const data = await resp.json();
    const found = data.containers.find((c: { id: string }) => c.id === containerId);
    test("Container removed from list", !found);
  } else {
    test("Container removed from list", false, `status=${resp.status}`);
  }
}

// ============================================================================
// Debug Diagnostics
// ============================================================================

console.log("\nDebug Diagnostics:");

// --- Debug mounts ---
{
  const resp = await apiGet(`/machines/${MACHINE_NAME}/debug/mounts`);
  if (resp.ok) {
    const data = await resp.json();
    test("Debug mounts endpoint", true);
    test("Has virtiofs_supported field", typeof data.virtiofs_supported === "boolean");
    test("Has configured array", Array.isArray(data.configured));
    test("Has guest_mounts string", typeof data.guest_mounts === "string");
    test("Has mnt_listing string", typeof data.mnt_listing === "string");
    console.log(`     📋 virtiofs: ${data.virtiofs_supported}, configured mounts: ${data.configured.length}`);
  } else {
    const text = await resp.text();
    test("Debug mounts endpoint", false, `status=${resp.status}: ${text}`);
  }
}

// --- Debug network ---
{
  const resp = await apiGet(`/machines/${MACHINE_NAME}/debug/network`);
  if (resp.ok) {
    const data = await resp.json();
    test("Debug network endpoint", true);
    test("Has network_enabled field", typeof data.network_enabled === "boolean");
    test("Has configured_ports array", Array.isArray(data.configured_ports));
    test("Has listening_ports string", typeof data.listening_ports === "string");
    test("Has interfaces string", typeof data.interfaces === "string");
    test("Network enabled is true", data.network_enabled === true);
    console.log(`     📋 network: ${data.network_enabled}, configured ports: ${data.configured_ports.length}`);
  } else {
    const text = await resp.text();
    test("Debug network endpoint", false, `status=${resp.status}: ${text}`);
  }
}

// ============================================================================
// Cleanup
// ============================================================================

console.log("\nCleanup:");
{
  await cleanup(MACHINE_NAME);
  const getResp = await apiGet(`/machines/${MACHINE_NAME}`);
  test("Machine cleaned up (404)", getResp.status === 404);
}

summary();
