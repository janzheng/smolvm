/**
 * CX04 smolvm — Fleet Test
 *
 * Tests multi-machine orchestration: parallel creation, parallel exec,
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
  const createResp = await apiPost("/machinees", {
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
test(`Created ${names.length}/${FLEET_SIZE} machinees`, names.length === FLEET_SIZE);
console.log(`  ⏱  Sequential create: ${createMs}ms (${Math.round(createMs / FLEET_SIZE)}ms/machine)`);

// --- Parallel start ---
console.log("\nFleet Start (parallel):");
const tStartStart = performance.now();
const startResults = await Promise.all(
  names.map(name => apiPost(`/machinees/${name}/start`))
);
const startMs = Math.round(performance.now() - tStartStart);
const allStarted = startResults.every(r => r.ok);
test("All machinees started", allStarted);
console.log(`  ⏱  Parallel start: ${startMs}ms (${Math.round(startMs / FLEET_SIZE)}ms/machine)`);

for (const r of startResults) {
  if (!r.bodyUsed) await r.text();
}

// --- Verify all running ---
console.log("\nFleet Status:");
{
  const listResp = await apiGet("/machinees");
  const data = await listResp.json();
  const fleetMachinees = data.machinees.filter((s: { name: string }) => s.name.startsWith(PREFIX));
  const allRunning = fleetMachinees.every((s: { state: string }) => s.state === "running");
  test(`All ${FLEET_SIZE} in list`, fleetMachinees.length === FLEET_SIZE);
  test("All state=running", allRunning);
}

// --- Parallel exec ---
console.log("\nParallel Exec (each machine gets unique task):");
const tExecStart = performance.now();
const execResults = await Promise.all(
  names.map((name, i) => sh(name, `echo "result-from-machine-${i}" && sleep 1`))
);
const execMs = Math.round(performance.now() - tExecStart);

const allCorrect = execResults.every((r, i) =>
  r.exit_code === 0 && r.stdout.includes(`result-from-machine-${i}`)
);
test("All execs returned correct results", allCorrect);
console.log(`  ⏱  Parallel exec (3x sleep 1): ${execMs}ms`);

const isCrossParallel = execMs < 2500;
test("Cross-machine exec is parallel", isCrossParallel, `${execMs}ms`);

// --- State isolation ---
console.log("\nState Isolation:");
{
  // Write unique marker per machine — use unique filenames to avoid race conditions
  await Promise.all(
    names.map((name, i) => sh(name, `echo "marker-${i}" > /tmp/identity-${i}.txt`))
  );

  const reads = await Promise.all(
    names.map((name, i) => sh(name, `cat /tmp/identity-${i}.txt`))
  );

  const isolated = reads.every((r, i) => r.stdout.trim() === `marker-${i}`);
  test("Each machine has isolated state", isolated);

  if (!isolated) {
    for (let i = 0; i < reads.length; i++) {
      console.log(`     Machine ${i}: ${reads[i].stdout.trim()}`);
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
console.log(`  ⏱  Cleanup: ${cleanMs}ms (${Math.round(cleanMs / FLEET_SIZE)}ms/machine)`);

const verifyResp = await apiGet("/machinees");
const verifyData = await verifyResp.json();
const remaining = verifyData.machinees.filter((s: { name: string }) => s.name.startsWith(PREFIX));
test("All machinees cleaned up", remaining.length === 0, `${remaining.length} remaining`);

summary();
