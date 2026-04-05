/**
 * smolvm SDK — Checkpoint Integration Test
 *
 * Tests cold checkpoint: create machine → write data → stop → checkpoint
 * → restore into new machine → verify data persists.
 *
 * Requires `smolvm serve` running on localhost:8080 with checkpoint support.
 * Run: deno run --allow-net --allow-env test-checkpoint.ts
 */

import { SmolvmClient } from "./mod.ts";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function test(name: string, ok: boolean, detail?: string) {
  if (ok) {
    console.log(`  OK  ${name}`);
    passed++;
  } else {
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
    failed++;
    failures.push(name);
  }
}

console.log("\n==========================================");
console.log("  smolvm SDK — Checkpoint Test");
console.log("==========================================\n");

const client = new SmolvmClient();

// --- Create machine with test data ---
console.log("Setup:");
const machine = await client.createAndStart("ckpt-test", {
  cpus: 1,
  memoryMb: 512,
  network: false,
});
test("Machine created + started", true);

// Write test data
await machine.writeFile("/workspace/checkpoint-test.txt", "checkpoint-data-42");
const readBack = await machine.readFile("/workspace/checkpoint-test.txt");
test("Test data written", readBack === "checkpoint-data-42");

// --- Create checkpoint ---
console.log("\nCheckpoint Create:");
await machine.stop();
test("Machine stopped", true);

const ckpt = await machine.checkpoint();
test("Checkpoint created", !!ckpt.id);
test("Has source_machine", ckpt.source_machine === "ckpt-test");
test("Has created_at", !!ckpt.created_at);
test("Has overlay_size_bytes", ckpt.overlay_size_bytes > 0);
console.log(`     Checkpoint ID: ${ckpt.id}`);
console.log(`     Overlay: ${(ckpt.overlay_size_bytes / 1024 / 1024).toFixed(1)} MB`);

// --- List checkpoints ---
console.log("\nCheckpoint List:");
const checkpoints = await client.listCheckpoints();
test("listCheckpoints returns array", Array.isArray(checkpoints));
const found = checkpoints.find((c) => c.id === ckpt.id);
test("Our checkpoint is in the list", !!found);

// --- Restore checkpoint ---
console.log("\nCheckpoint Restore:");
const restored = await client.restoreCheckpoint(ckpt.id, "ckpt-restored");
test("Restore returns machine", !!restored);
test("Restored machine has correct name", restored.name === "ckpt-restored");

// Start the restored machine and verify data
await restored.start();
test("Restored machine started", true);

const restoredData = await restored.readFile("/workspace/checkpoint-test.txt");
test("Data persists across checkpoint", restoredData === "checkpoint-data-42", `got: "${restoredData}"`);

// Write new data to restored machine (verify it's a real running VM)
await restored.writeFile("/workspace/new-file.txt", "new-data");
const newData = await restored.readFile("/workspace/new-file.txt");
test("Restored machine is writable", newData === "new-data");

// --- Delete checkpoint ---
console.log("\nCheckpoint Delete:");
await client.deleteCheckpoint(ckpt.id);
test("Checkpoint deleted", true);

const afterDelete = await client.listCheckpoints();
const stillExists = afterDelete.find((c) => c.id === ckpt.id);
test("Checkpoint no longer in list", !stillExists);

// --- Cleanup ---
console.log("\nCleanup:");
await machine.cleanup();
await restored.cleanup();
test("Both machinees cleaned up", true);

// --- Summary ---
console.log("\n==========================================");
console.log(`  Results: ${passed} passed, ${failed} failed`);
if (failures.length > 0) {
  console.log(`  Failures: ${failures.join(", ")}`);
}
console.log("==========================================\n");

await client.close();
Deno.exit(failed > 0 ? 1 : 0);
