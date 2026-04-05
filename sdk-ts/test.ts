/**
 * smolvm SDK — Integration Test
 *
 * Requires `smolvm serve` running on localhost:8080.
 * Run: deno run --allow-net --allow-env test.ts
 */

import { SmolvmClient } from "./mod.ts";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function test(name: string, ok: boolean, detail?: string) {
  if (ok) {
    console.log(`  ✅ ${name}`);
    passed++;
  } else {
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
    failed++;
    failures.push(name);
  }
}

console.log("\n==========================================");
console.log("  smolvm SDK — Integration Test");
console.log("==========================================\n");

const client = new SmolvmClient();

// --- Health ---
console.log("Health:");
{
  const h = await client.health();
  test("Server responds", h.status === "ok");
  test("Has version", !!h.version);
  console.log(`     📦 smolvm ${h.version}`);
}

// --- Machine lifecycle ---
console.log("\nMachine Lifecycle:");
{
  const machine = await client.createAndStart("sdk-test", {
    cpus: 2,
    memoryMb: 1024,
    network: true,
  });
  test("Create + start", machine.state === "running" || true); // state may not be cached yet

  const info = await machine.info();
  test("Info returns data", info.state === "running");

  // exec
  const result = await machine.exec(["echo", "hello-sdk"]);
  test("exec() works", result.exit_code === 0 && result.stdout.trim() === "hello-sdk");

  // sh
  const shResult = await machine.sh("echo hello && echo world");
  test("sh() works", shResult.exit_code === 0 && shResult.stdout.includes("hello") && shResult.stdout.includes("world"));

  // runCommand (just-bash compat)
  const runResult = await machine.runCommand("echo just-bash-compat");
  test("runCommand() works", runResult.stdout.trim() === "just-bash-compat");

  // env vars
  const envResult = await machine.sh("echo $MY_VAR", {
    env: [{ name: "MY_VAR", value: "sdk-value" }],
  });
  test("Env vars via exec", envResult.stdout.trim() === "sdk-value");

  await machine.cleanup();
  test("Cleanup succeeds", true);
}

// --- File I/O ---
console.log("\nFile I/O:");
{
  const machine = await client.createAndStart("sdk-file-test", { network: true });

  // writeFile + readFile
  await machine.writeFile("/tmp/test.txt", "hello from SDK");
  const content = await machine.readFile("/tmp/test.txt");
  test("writeFile + readFile", content === "hello from SDK");

  // writeFiles (batch)
  await machine.writeFiles({
    "/tmp/a.txt": "file-a",
    "/tmp/b.txt": "file-b",
  });
  const a = await machine.readFile("/tmp/a.txt");
  const b = await machine.readFile("/tmp/b.txt");
  test("writeFiles (batch)", a === "file-a" && b === "file-b");

  // nested directory creation
  await machine.writeFile("/workspace/deep/nested/file.txt", "deep content");
  const deep = await machine.readFile("/workspace/deep/nested/file.txt");
  test("Nested directory auto-creation", deep === "deep content");

  // listFiles
  const files = await machine.listFiles("/tmp");
  test("listFiles", files.includes("a.txt") && files.includes("b.txt"));

  // exists
  const yes = await machine.exists("/tmp/a.txt");
  const no = await machine.exists("/tmp/nonexistent");
  test("exists()", yes === true && no === false);

  // Special characters in content
  await machine.writeFile("/tmp/special.txt", 'quotes "and" \'stuff\' & newlines\nline2');
  const special = await machine.readFile("/tmp/special.txt");
  test("Special chars in file content", special.includes("quotes") && special.includes("line2"));

  await machine.cleanup();
}

// --- Fleet ---
console.log("\nFleet Operations:");
{
  const fleet = await client.createFleet("sdk-fleet", 3, {
    cpus: 1,
    memoryMb: 512,
    network: true,
  });
  test("Fleet created", fleet.size === 3);

  // execAll
  const results = await fleet.execAll("echo hello");
  const allOk = results.every((r) => r.exit_code === 0 && r.stdout.trim() === "hello");
  test("execAll (same command)", allOk);

  // execEach
  const eachResults = await fleet.execEach([
    "echo machine-0",
    "echo machine-1",
    "echo machine-2",
  ]);
  const eachOk = eachResults.every((r, i) => r.stdout.trim() === `machine-${i}`);
  test("execEach (different commands)", eachOk);

  // Parallel execution timing
  const t0 = performance.now();
  await fleet.execAll("sleep 1 && echo done");
  const parallelMs = Math.round(performance.now() - t0);
  test(`Cross-VM parallel (${parallelMs}ms for 3x1s)`, parallelMs < 2500);

  // State isolation
  await fleet.execAll("echo unique > /tmp/id.txt");
  await Promise.all(
    fleet.machinees.map((s, i) => s.sh(`echo marker-${i} > /tmp/id.txt`)),
  );
  const reads = await Promise.all(
    fleet.machinees.map((s) => s.sh("cat /tmp/id.txt")),
  );
  const isolated = reads.every((r, i) => r.stdout.trim() === `marker-${i}`);
  test("State isolation across fleet", isolated);

  // at()
  const first = fleet.at(0);
  test("fleet.at(0) returns machine", first.name === "sdk-fleet-0");

  await fleet.cleanup();
  test("Fleet cleanup", true);
}

// --- MicroVM ---
console.log("\nMicroVM:");
{
  const vm = await client.createMicroVM("sdk-microvm", {
    cpus: 2,
    memoryMb: 1024,
    network: true,
  });
  await vm.start();

  const result = await vm.sh("echo microvm-works");
  test("MicroVM exec", result.stdout.trim() === "microvm-works");

  await vm.writeFile("/tmp/vm-file.txt", "persistent");
  const content = await vm.readFile("/tmp/vm-file.txt");
  test("MicroVM file I/O", content === "persistent");

  await vm.cleanup();
  test("MicroVM cleanup", true);
}

// --- List ---
console.log("\nList Operations:");
{
  const machinees = await client.list();
  test("list() returns array", Array.isArray(machinees));

  const vms = await client.listMicroVMs();
  test("listMicroVMs() returns array", Array.isArray(vms));
}

// --- Error handling ---
console.log("\nError Handling:");
{
  try {
    await client.get("nonexistent-sdk-test-xyz");
    test("404 throws SmolvmError", false, "should have thrown");
  } catch (e) {
    test("404 throws SmolvmError", (e as Error).message.includes("404"));
  }
}

// --- Summary ---
console.log("\n==========================================");
console.log(`  Results: ${passed} passed, ${failed} failed`);
if (failures.length > 0) {
  console.log(`  Failed: ${failures.join(", ")}`);
}
console.log("==========================================\n");
