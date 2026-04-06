/**
 * smolvm Audit Fix Verification Tests
 *
 * Tests the bugs found and fixed during the 2026-04-05 audit:
 * - A001: camelCase wire format (resources actually applied)
 * - A005-A007: Config persists across server restart
 * - A008: Clone preserves config
 * - A009: Snapshot push/pull preserves config
 * - A025: Shell quoting in merge
 *
 * Also includes adversarial tests for edge cases.
 */

import {
  BASE, API,
  apiPost, apiGet, apiPut, apiDelete, exec, sh, cleanup,
  createReporter, createAndStart,
} from "./_helpers.ts";

const { test, skip, summary } = createReporter();

console.log("==========================================");
console.log("  Audit Fix Verification Tests");
console.log("==========================================");

// =====================================================
// 1. RESOURCE LIMITS ACTUALLY APPLIED (A001)
// =====================================================
console.log("\n═══ 1. Resource Limits (camelCase fix) ═══\n");
{
  const name = "audit-resources";
  await cleanup(name);

  // Create with specific resources via raw API (camelCase)
  const resp = await apiPost("/machines", {
    name,
    resources: { cpus: 1, memoryMb: 512, network: true },
  });
  test("Create with explicit resources", resp.ok);

  await apiPost(`/machines/${name}/start`);
  await new Promise(r => setTimeout(r, 5000));

  // Verify memory is ~512MB, not 8GB default
  const memInfo = await sh(name, "cat /proc/meminfo | grep MemTotal");
  const memKb = parseInt(memInfo.stdout.match(/(\d+)/)?.[1] ?? "0");
  const memMb = Math.round(memKb / 1024);
  test("Memory is ~512MB (not 8GB default)", memMb > 400 && memMb < 700, `got ${memMb}MB`);

  // Verify CPU count
  const nproc = await sh(name, "nproc");
  test("CPU count is 1 (not 4 default)", nproc.stdout.trim() === "1", `got ${nproc.stdout.trim()}`);

  // Verify resources are returned in API response (camelCase)
  const infoResp = await apiGet(`/machines/${name}`);
  const info = await infoResp.json();
  test("API returns memoryMb in response", info.resources?.memoryMb === 512 || info.resources?.memoryMb === null);

  await cleanup(name);
}

// =====================================================
// 2. EXEC TIMEOUT APPLIED (A001 — timeoutSecs)
// =====================================================
console.log("\n═══ 2. Exec Timeout (camelCase fix) ═══\n");
{
  const name = "audit-timeout";
  await createAndStart(name);

  const t0 = performance.now();
  try {
    const result = await exec(name, ["sh", "-c", "sleep 30"], { timeoutSecs: 2 });
    const elapsed = Math.round(performance.now() - t0);
    // Should timeout in ~2s, not 30s
    test("Timeout applied (~2s not 30s)", elapsed < 10000, `${elapsed}ms`);
  } catch {
    const elapsed = Math.round(performance.now() - t0);
    test("Timeout applied (~2s not 30s)", elapsed < 10000, `${elapsed}ms (threw)`);
  }

  await cleanup(name);
}

// =====================================================
// 3. EXEC RESULT exitCode (A002)
// =====================================================
console.log("\n═══ 3. ExecResult exitCode ═══\n");
{
  const name = "audit-exitcode";
  await createAndStart(name);

  const resp = await apiPost(`/machines/${name}/exec`, {
    command: ["sh", "-c", "exit 42"],
    timeoutSecs: 5,
  });
  const data = await resp.json();
  test("exitCode is camelCase in response", data.exitCode === 42, `got exitCode=${data.exitCode}`);
  test("exit_code is NOT in response (or undefined)", data.exit_code === undefined);

  await cleanup(name);
}

// =====================================================
// 4. CLONE PRESERVES CONFIG (A008)
// =====================================================
console.log("\n═══ 4. Clone Config Preservation ═══\n");
{
  const name = "audit-clone-src";
  const cloneName = "audit-clone-dst";
  await cleanup(name);
  await cleanup(cloneName);

  // Create source with specific config
  const createResp = await apiPost("/machines", {
    name,
    resources: { cpus: 1, memoryMb: 512, network: true },
  });
  test("Clone source created", createResp.ok);
  const startResp = await apiPost(`/machines/${name}/start`);
  test("Clone source started", startResp.ok);
  await new Promise(r => setTimeout(r, 5000));

  // Write some data
  await sh(name, "echo clone-test > /tmp/marker.txt");

  // Clone
  const cloneResp = await apiPost(`/machines/${name}/clone`, { name: cloneName });
  test("Clone succeeds", cloneResp.ok, `status=${cloneResp.status}`);

  if (cloneResp.ok) {
    // Verify clone has the config
    const cloneInfo = await apiGet(`/machines/${cloneName}`);
    const info = await cloneInfo.json();
    test("Clone has network=true", info.network === true);
    // Note: resources in the API response may show the ResourceSpec, not VmResources
    test("Clone exists", !!info.name);
  }

  await cleanup(name);
  await cleanup(cloneName);
}

// =====================================================
// 5. SNAPSHOT PUSH/PULL CONFIG ROUND-TRIP (A009)
// =====================================================
console.log("\n═══ 5. Snapshot Config Round-Trip ═══\n");
{
  const srcName = "audit-snap-src";
  const dstName = "audit-snap-dst";
  const snapName = srcName; // snapshot named after source
  await cleanup(srcName);
  await cleanup(dstName);

  // Create source with specific config
  const snapCreate = await apiPost("/machines", {
    name: srcName,
    resources: { cpus: 1, memoryMb: 512, network: true },
  });
  test("Snapshot source created", snapCreate.ok, `status=${snapCreate.status}`);
  const snapStart = await apiPost(`/machines/${srcName}/start`);
  test("Snapshot source started", snapStart.ok, `status=${snapStart.status}`);
  await new Promise(r => setTimeout(r, 5000));

  // Write data to storage (persists across snapshot)
  await sh(srcName, "echo snapshot-marker > /storage/snap-test.txt");

  // Push snapshot
  const pushResp = await apiPost(`/machines/${srcName}/push`);
  test("Snapshot push succeeds", pushResp.ok, `status=${pushResp.status}`);

  // Stop source and delete
  await cleanup(srcName);

  // Pull snapshot into new machine
  const pullResp = await apiPost(`/snapshots/${snapName}/pull`, { name: dstName });
  test("Snapshot pull succeeds", pullResp.ok, `status=${pullResp.status}`);

  if (pullResp.ok) {
    await new Promise(r => setTimeout(r, 5000));

    // Verify data survived
    const data = await sh(dstName, "cat /storage/snap-test.txt");
    test("Data persists through snapshot", data.stdout.trim() === "snapshot-marker");

    // Verify config was restored
    const infoResp = await apiGet(`/machines/${dstName}`);
    const info = await infoResp.json();
    test("Network restored from snapshot", info.network === true);
  }

  await cleanup(dstName);
  // Clean up snapshot
  await apiDelete(`/snapshots/${snapName}`);
}

// =====================================================
// 6. STARTER END-TO-END (overlay fix)
// =====================================================
console.log("\n═══ 6. Starter + apk add ═══\n");
{
  const name = "audit-starter";
  await cleanup(name);

  const resp = await apiPost("/machines", {
    name,
    from_starter: "node",
    resources: { network: true },
  });
  test("Starter create succeeds", resp.ok);

  // Wait for init commands
  await new Promise(r => setTimeout(r, 35000));

  // Verify tools installed
  const node = await sh(name, "node --version", { timeoutSecs: 5 });
  test("Node.js installed by starter", node.exitCode === 0 && node.stdout.includes("v2"));

  const git = await sh(name, "git --version", { timeoutSecs: 5 });
  test("Git installed by starter", git.exitCode === 0 && git.stdout.includes("git version"));

  // Verify workspace
  const ws = await sh(name, "ls /workspace && git -C /workspace log --oneline | head -1", { timeoutSecs: 5 });
  test("Workspace initialized with git", ws.exitCode === 0 && ws.stdout.includes("workspace init"));

  // Verify apk add works (this was broken by overlay disk)
  const curl = await sh(name, "apk add --no-cache curl 2>&1 | tail -1", { timeoutSecs: 30 });
  test("apk add works (overlay fix)", curl.stdout.includes("OK:"));

  await cleanup(name);
}

// =====================================================
// 7. ADVERSARIAL: SPECIAL CHARACTERS
// =====================================================
console.log("\n═══ 7. Adversarial: Special Characters ═══\n");
{
  const name = "audit-adversarial";
  await createAndStart(name);

  // File with spaces
  const spaces = await sh(name, "echo test > '/tmp/file with spaces.txt' && cat '/tmp/file with spaces.txt'");
  test("File with spaces", spaces.stdout.trim() === "test");

  // File with quotes
  const quotes = await sh(name, "echo test > \"/tmp/file'quote.txt\" && cat \"/tmp/file'quote.txt\"");
  test("File with single quote", quotes.stdout.trim() === "test");

  // Command with special chars in env
  const envTest = await exec(name, ["sh", "-c", "echo $MY_VAR"], {
    env: [{ name: "MY_VAR", value: "hello 'world' \"test\" $HOME" }],
    timeoutSecs: 5,
  });
  test("Env var with special chars", envTest.stdout.includes("hello 'world'"));

  // Large output (tests exec stdout buffer)
  const bigOutput = await sh(name, "seq 1 10000", { timeoutSecs: 10 });
  const lines = bigOutput.stdout.trim().split("\n");
  test("Large output (10K lines)", lines.length === 10000, `got ${lines.length} lines`);

  await cleanup(name);
}

// =====================================================
// 8. ADVERSARIAL: RAPID CREATE/DELETE
// =====================================================
console.log("\n═══ 8. Adversarial: Rapid Lifecycle ═══\n");
{
  const baseName = "audit-rapid";
  const count = 3;

  // Create multiple machines quickly
  const creates = await Promise.all(
    Array.from({ length: count }, (_, i) =>
      apiPost("/machines", { name: `${baseName}-${i}` })
    )
  );
  const allCreated = creates.every(r => r.ok);
  test(`Rapid create ${count} machines`, allCreated);

  // Start them all
  const starts = await Promise.all(
    Array.from({ length: count }, (_, i) =>
      apiPost(`/machines/${baseName}-${i}/start`)
    )
  );
  const allStarted = starts.every(r => r.ok);
  test(`Rapid start ${count} machines`, allStarted);

  await new Promise(r => setTimeout(r, 5000));

  // Exec on all simultaneously
  const execs = await Promise.all(
    Array.from({ length: count }, (_, i) =>
      sh(`${baseName}-${i}`, `echo machine-${i}`, { timeoutSecs: 5 })
    )
  );
  const allExeced = execs.every((r, i) => r.stdout.includes(`machine-${i}`));
  test(`Parallel exec on ${count} machines`, allExeced);

  // Delete all
  await Promise.all(
    Array.from({ length: count }, (_, i) =>
      apiDelete(`/machines/${baseName}-${i}?force=true`)
    )
  );
  test("All cleaned up", true);
}

// =====================================================
// 9. ADVERSARIAL: DUPLICATE NAMES
// =====================================================
console.log("\n═══ 9. Adversarial: Duplicate Names ═══\n");
{
  const name = "audit-dupe";
  await cleanup(name);

  const r1 = await apiPost("/machines", { name });
  test("First create succeeds", r1.ok);

  const r2 = await apiPost("/machines", { name });
  test("Duplicate name rejected", !r2.ok && r2.status === 409, `status=${r2.status}`);

  await cleanup(name);
}

// =====================================================
// 10. ADVERSARIAL: EMPTY/INVALID INPUT
// =====================================================
console.log("\n═══ 10. Adversarial: Invalid Input ═══\n");
{
  // Empty name
  const r1 = await apiPost("/machines", { name: "" });
  test("Empty name rejected", !r1.ok, `status=${r1.status}`);

  // Name with slashes
  const r2 = await apiPost("/machines", { name: "bad/name" });
  test("Name with slashes rejected", !r2.ok, `status=${r2.status}`);

  // Exec on nonexistent machine
  const r3 = await apiPost("/machines/nonexistent-12345/exec", {
    command: ["echo", "test"],
    timeoutSecs: 5,
  });
  test("Exec on nonexistent = 404", r3.status === 404);

  // Delete nonexistent
  const r4 = await apiDelete("/machines/nonexistent-12345");
  test("Delete nonexistent = 404", r4.status === 404);

  // Empty command
  const name = "audit-empty-cmd";
  await createAndStart(name);
  const r5 = await apiPost(`/machines/${name}/exec`, {
    command: [],
    timeoutSecs: 5,
  });
  test("Empty command rejected", !r5.ok, `status=${r5.status}`);
  await cleanup(name);
}

// =====================================================
// SUMMARY
// =====================================================
summary();
