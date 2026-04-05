/**
 * CX04 smolvm — Sync Push/Pull Test
 *
 * Tests: sync push (local → machine), sync pull (machine → local),
 * --exclude filtering, and round-trip integrity.
 *
 * Requires a running smolvm server: deno task serve
 */

import {
  apiPost, apiGet,
  exec,
  createAndStart, cleanup,
  createReporter,
} from "./_helpers.ts";

const MACHINE_NAME = "cx04-sync-test";
const { test, skip, summary } = createReporter();

// ============================================================================
// Setup
// ============================================================================

console.log("\n==========================================");
console.log("  CX04 smolvm — Sync Push/Pull Test");
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

// Create a temp directory with test files
const tmpDir = await Deno.makeTempDir({ prefix: "smolvm-sync-test-" });
const pullDir = await Deno.makeTempDir({ prefix: "smolvm-sync-pull-" });

// Write test files
await Deno.writeTextFile(`${tmpDir}/hello.txt`, "hello from sync test\n");
await Deno.writeTextFile(`${tmpDir}/data.json`, '{"key": "value"}\n');
await Deno.mkdir(`${tmpDir}/subdir`, { recursive: true });
await Deno.writeTextFile(`${tmpDir}/subdir/nested.txt`, "nested file content\n");
// File that should be excludable
await Deno.mkdir(`${tmpDir}/node_modules`, { recursive: true });
await Deno.writeTextFile(`${tmpDir}/node_modules/junk.js`, "should be excluded\n");
await Deno.writeTextFile(`${tmpDir}/.gitignore`, "node_modules/\n");

test("Created temp test files", true);

// ============================================================================
// Sync Push (local → machine)
// ============================================================================

console.log("\nSync Push:");

// --- Basic push ---
{
  const proc = new Deno.Command("deno", {
    args: ["task", "ctl", "sync", "push", MACHINE_NAME, tmpDir, "--to", "/workspace/sync-test"],
    stdout: "piped",
    stderr: "piped",
    cwd: Deno.cwd(),
  }).spawn();
  const output = await proc.output();
  const stdout = new TextDecoder().decode(output.stdout);
  const stderr = new TextDecoder().decode(output.stderr);
  test("Sync push succeeds", output.success, `stdout: ${stdout}, stderr: ${stderr}`);
}

// --- Verify files landed ---
{
  const result = await exec(MACHINE_NAME, ["cat", "/workspace/sync-test/hello.txt"]);
  test("Push: hello.txt content", result.exit_code === 0 && result.stdout.trim() === "hello from sync test",
    `got: "${result.stdout.trim()}"`);
}

{
  const result = await exec(MACHINE_NAME, ["cat", "/workspace/sync-test/data.json"]);
  test("Push: data.json content", result.exit_code === 0 && result.stdout.includes('"key"'),
    `got: "${result.stdout.trim()}"`);
}

{
  const result = await exec(MACHINE_NAME, ["cat", "/workspace/sync-test/subdir/nested.txt"]);
  test("Push: nested file content", result.exit_code === 0 && result.stdout.trim() === "nested file content",
    `got: "${result.stdout.trim()}"`);
}

// --- Push with --exclude ---
console.log("\nSync Push with Exclude:");
{
  const proc = new Deno.Command("deno", {
    args: ["task", "ctl", "sync", "push", MACHINE_NAME, tmpDir, "--to", "/workspace/sync-exclude", "--exclude", "node_modules"],
    stdout: "piped",
    stderr: "piped",
    cwd: Deno.cwd(),
  }).spawn();
  const output = await proc.output();
  test("Sync push with --exclude succeeds", output.success);
}

{
  // hello.txt should exist
  const result = await exec(MACHINE_NAME, ["cat", "/workspace/sync-exclude/hello.txt"]);
  test("Exclude: hello.txt present", result.exit_code === 0 && result.stdout.trim() === "hello from sync test");
}

{
  // node_modules should NOT exist
  const result = await exec(MACHINE_NAME, ["ls", "/workspace/sync-exclude/node_modules"]);
  test("Exclude: node_modules excluded", result.exit_code !== 0,
    `exit_code=${result.exit_code} (expected non-zero)`);
}

// ============================================================================
// Sync Pull (machine → local)
// ============================================================================

console.log("\nSync Pull:");

// --- Create files in machine to pull ---
{
  await exec(MACHINE_NAME, ["sh", "-c", "mkdir -p /workspace/pull-test && echo 'machine-data' > /workspace/pull-test/result.txt"]);
  await exec(MACHINE_NAME, ["sh", "-c", "mkdir -p /workspace/pull-test/logs && echo 'log-entry' > /workspace/pull-test/logs/app.log"]);
  test("Created machine files for pull", true);
}

// --- Basic pull ---
{
  const pullTarget = `${pullDir}/basic`;
  const proc = new Deno.Command("deno", {
    args: ["task", "ctl", "sync", "pull", MACHINE_NAME, pullTarget, "--from", "/workspace/pull-test"],
    stdout: "piped",
    stderr: "piped",
    cwd: Deno.cwd(),
  }).spawn();
  const output = await proc.output();
  const stdout = new TextDecoder().decode(output.stdout);
  test("Sync pull succeeds", output.success, `stdout: ${stdout}`);

  // Verify pulled content
  try {
    const content = await Deno.readTextFile(`${pullTarget}/result.txt`);
    test("Pull: result.txt content", content.trim() === "machine-data", `got: "${content.trim()}"`);
  } catch (e) {
    test("Pull: result.txt content", false, `${e}`);
  }

  try {
    const content = await Deno.readTextFile(`${pullTarget}/logs/app.log`);
    test("Pull: nested log content", content.trim() === "log-entry", `got: "${content.trim()}"`);
  } catch (e) {
    test("Pull: nested log content", false, `${e}`);
  }
}

// ============================================================================
// Round-trip integrity
// ============================================================================

console.log("\nRound-trip:");

{
  // Push tmpDir → machine, pull back to new dir, compare
  const roundTripDir = `${pullDir}/roundtrip`;

  // Push
  const pushProc = new Deno.Command("deno", {
    args: ["task", "ctl", "sync", "push", MACHINE_NAME, tmpDir, "--to", "/workspace/roundtrip", "--exclude", "node_modules"],
    stdout: "piped",
    stderr: "piped",
    cwd: Deno.cwd(),
  }).spawn();
  await pushProc.output();

  // Pull
  const pullProc = new Deno.Command("deno", {
    args: ["task", "ctl", "sync", "pull", MACHINE_NAME, roundTripDir, "--from", "/workspace/roundtrip"],
    stdout: "piped",
    stderr: "piped",
    cwd: Deno.cwd(),
  }).spawn();
  await pullProc.output();

  // Compare files
  try {
    const origHello = await Deno.readTextFile(`${tmpDir}/hello.txt`);
    const rtHello = await Deno.readTextFile(`${roundTripDir}/hello.txt`);
    test("Round-trip: hello.txt matches", origHello === rtHello);
  } catch (e) {
    test("Round-trip: hello.txt matches", false, `${e}`);
  }

  try {
    const origJson = await Deno.readTextFile(`${tmpDir}/data.json`);
    const rtJson = await Deno.readTextFile(`${roundTripDir}/data.json`);
    test("Round-trip: data.json matches", origJson === rtJson);
  } catch (e) {
    test("Round-trip: data.json matches", false, `${e}`);
  }

  try {
    const origNested = await Deno.readTextFile(`${tmpDir}/subdir/nested.txt`);
    const rtNested = await Deno.readTextFile(`${roundTripDir}/subdir/nested.txt`);
    test("Round-trip: nested.txt matches", origNested === rtNested);
  } catch (e) {
    test("Round-trip: nested.txt matches", false, `${e}`);
  }
}

// ============================================================================
// Dry-run
// ============================================================================

console.log("\nDry-run:");

{
  const proc = new Deno.Command("deno", {
    args: ["task", "ctl", "sync", "push", MACHINE_NAME, tmpDir, "--to", "/workspace/dry", "--dry-run"],
    stdout: "piped",
    stderr: "piped",
    cwd: Deno.cwd(),
  }).spawn();
  const output = await proc.output();
  const stdout = new TextDecoder().decode(output.stdout);
  test("Dry-run push prints listing", output.success && stdout.includes("[dry-run]"));
  // Verify nothing was actually uploaded
  const result = await exec(MACHINE_NAME, ["ls", "/workspace/dry"]);
  test("Dry-run: no files uploaded", result.exit_code !== 0);
}

{
  const proc = new Deno.Command("deno", {
    args: ["task", "ctl", "sync", "pull", MACHINE_NAME, `${pullDir}/dryrun`, "--from", "/workspace/sync-test", "--dry-run"],
    stdout: "piped",
    stderr: "piped",
    cwd: Deno.cwd(),
  }).spawn();
  const output = await proc.output();
  const stdout = new TextDecoder().decode(output.stdout);
  test("Dry-run pull prints listing", output.success && stdout.includes("[dry-run]"));
  // Verify nothing was downloaded
  try {
    await Deno.stat(`${pullDir}/dryrun`);
    test("Dry-run: no files downloaded", false, "directory was created");
  } catch {
    test("Dry-run: no files downloaded", true);
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

  // Clean temp dirs
  await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  await Deno.remove(pullDir, { recursive: true }).catch(() => {});
  test("Temp dirs cleaned", true);
}

summary();
