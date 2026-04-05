/**
 * CX04 smolvm — Fleet Test
 *
 * Tests multi-sandbox orchestration: parallel creation, parallel exec,
 * state isolation, and cleanup.
 */

import {
  apiPost, apiGet, apiDelete, sh, cleanup,
  createReporter,
} from "./_helpers.ts";

const FLEET_SIZE = 3;
const PREFIX = "cx04-fleet";
const { test, summary } = createReporter();

// ============================================================================
// Tests
// ============================================================================

console.log("\n==========================================");
console.log("  CX04 smolvm — Fleet Test");
console.log(`  Fleet size: ${FLEET_SIZE}`);
console.log("==========================================\n");

// Cleanup from previous runs
for (let i = 0; i < FLEET_SIZE; i++) {
  await cleanup(`${PREFIX}-${i}`);
}

// --- Sequential creation ---
console.log("Fleet Creation (sequential):");
const names: string[] = [];
const tCreateStart = performance.now();

for (let i = 0; i < FLEET_SIZE; i++) {
  const name = `${PREFIX}-${i}`;
  const createResp = await apiPost("/sandboxes", {
    name,
    resources: { cpus: 1, memory_mb: 512, network: true },
  });
  if (createResp.ok) {
    names.push(name);
  } else {
    console.log(`  ❌ Failed to create ${name}: ${createResp.status}`);
  }
}
const createMs = Math.round(performance.now() - tCreateStart);
test(`Created ${names.length}/${FLEET_SIZE} sandboxes`, names.length === FLEET_SIZE);
console.log(`  ⏱  Sequential create: ${createMs}ms (${Math.round(createMs / FLEET_SIZE)}ms/sandbox)`);

// --- Parallel start ---
console.log("\nFleet Start (parallel):");
const tStartStart = performance.now();
const startResults = await Promise.all(
  names.map(name => apiPost(`/sandboxes/${name}/start`))
);
const startMs = Math.round(performance.now() - tStartStart);
const allStarted = startResults.every(r => r.ok);
test("All sandboxes started", allStarted);
console.log(`  ⏱  Parallel start: ${startMs}ms (${Math.round(startMs / FLEET_SIZE)}ms/sandbox)`);

for (const r of startResults) {
  if (!r.bodyUsed) await r.text();
}

// --- Verify all running ---
console.log("\nFleet Status:");
{
  const listResp = await apiGet("/sandboxes");
  const data = await listResp.json();
  const fleetSandboxes = data.sandboxes.filter((s: { name: string }) => s.name.startsWith(PREFIX));
  const allRunning = fleetSandboxes.every((s: { state: string }) => s.state === "running");
  test(`All ${FLEET_SIZE} in list`, fleetSandboxes.length === FLEET_SIZE);
  test("All state=running", allRunning);
}

// --- Parallel exec ---
console.log("\nParallel Exec (each sandbox gets unique task):");
const tExecStart = performance.now();
const execResults = await Promise.all(
  names.map((name, i) => sh(name, `echo "result-from-sandbox-${i}" && sleep 1`))
);
const execMs = Math.round(performance.now() - tExecStart);

const allCorrect = execResults.every((r, i) =>
  r.exit_code === 0 && r.stdout.includes(`result-from-sandbox-${i}`)
);
test("All execs returned correct results", allCorrect);
console.log(`  ⏱  Parallel exec (3x sleep 1): ${execMs}ms`);

const isCrossParallel = execMs < 2500;
test("Cross-sandbox exec is parallel", isCrossParallel, `${execMs}ms`);

// --- State isolation ---
console.log("\nState Isolation:");
{
  await Promise.all(
    names.map((name, i) => sh(name, `echo "marker-${i}" > /tmp/identity.txt`))
  );

  const reads = await Promise.all(
    names.map(name => sh(name, "cat /tmp/identity.txt"))
  );

  const isolated = reads.every((r, i) => r.stdout.trim() === `marker-${i}`);
  test("Each sandbox has isolated state", isolated);

  if (!isolated) {
    for (let i = 0; i < reads.length; i++) {
      console.log(`     Sandbox ${i}: ${reads[i].stdout.trim()}`);
    }
  }
}

// --- Fleet cleanup ---
console.log("\nFleet Cleanup:");
const tCleanStart = performance.now();
for (const name of names) {
  await cleanup(name);
}
const cleanMs = Math.round(performance.now() - tCleanStart);
console.log(`  ⏱  Cleanup: ${cleanMs}ms (${Math.round(cleanMs / FLEET_SIZE)}ms/sandbox)`);

const verifyResp = await apiGet("/sandboxes");
const verifyData = await verifyResp.json();
const remaining = verifyData.sandboxes.filter((s: { name: string }) => s.name.startsWith(PREFIX));
test("All sandboxes cleaned up", remaining.length === 0, `${remaining.length} remaining`);

summary();
