/**
 * CX04 smolvm — Remote Access / Auth Test
 *
 * Tests that smolctl and the API work correctly with:
 * - Bearer token authentication
 * - Auth rejection on wrong/missing token
 *
 * PREREQUISITE: Server must be started with --api-token:
 *   smolvm serve start --listen 127.0.0.1:8080 --api-token test-token-123
 *
 * Then run with:
 *   SMOLVM_API_TOKEN=test-token-123 deno task test-remote
 */

import {
  BASE, API,
  apiPost, apiGet, apiDelete,
  exec,
  cleanup,
  createReporter,
} from "./_helpers.ts";

const SANDBOX = "cx04-remote-test";
const { test, skip, summary } = createReporter();
const TOKEN = Deno.env.get("SMOLVM_API_TOKEN");

console.log("\n==========================================");
console.log("  CX04 smolvm — Remote Access / Auth Test");
console.log("==========================================\n");

// ============================================================================
// Check if auth is configured
// ============================================================================

console.log("Pre-flight:");

if (!TOKEN) {
  console.log("  ⚠️  SMOLVM_API_TOKEN not set.");
  console.log("  ⚠️  Start server: smolvm serve start --api-token test-token-123");
  console.log("  ⚠️  Run test: SMOLVM_API_TOKEN=test-token-123 deno task test-remote\n");
  skip("All auth tests", "SMOLVM_API_TOKEN not set");
  summary();
  Deno.exit(0);
}

console.log(`  Token configured: ${TOKEN.substring(0, 8)}...`);
console.log(`  Server: ${BASE}\n`);

// ============================================================================
// Auth rejection — wrong token
// ============================================================================

console.log("Auth Rejection:");

{
  // Request with wrong token should be rejected
  const resp = await fetch(`${API}/sandboxes`, {
    headers: { "Authorization": "Bearer wrong-token-xxx" },
    signal: AbortSignal.timeout(10_000),
  });
  test("Wrong token → 401", resp.status === 401, `got status=${resp.status}`);
  await resp.text(); // consume body
}

{
  // Request with no token should be rejected
  const resp = await fetch(`${API}/sandboxes`, {
    signal: AbortSignal.timeout(10_000),
  });
  test("No token → 401", resp.status === 401, `got status=${resp.status}`);
  await resp.text();
}

{
  // Health endpoint should be public (no auth required)
  const resp = await fetch(`${BASE}/health`, {
    signal: AbortSignal.timeout(10_000),
  });
  test("Health endpoint public (no auth)", resp.ok, `got status=${resp.status}`);
  await resp.text();
}

{
  // Metrics endpoint should be public
  const resp = await fetch(`${API.replace("/api/v1", "")}/metrics`, {
    signal: AbortSignal.timeout(10_000),
  });
  test("Metrics endpoint public", resp.ok || resp.status === 404, `got status=${resp.status}`);
  await resp.text();
}

// ============================================================================
// Auth success — correct token
// ============================================================================

console.log("\nAuth Success:");

{
  // Request with correct token should work
  const resp = await apiGet("/sandboxes");
  test("Correct token → 200", resp.ok, `got status=${resp.status}`);
  if (resp.ok) {
    const data = await resp.json();
    test("Response has sandboxes array", Array.isArray(data.sandboxes));
  }
}

// ============================================================================
// Full lifecycle with auth
// ============================================================================

console.log("\nLifecycle with Auth:");

await cleanup(SANDBOX);

{
  const resp = await apiPost("/sandboxes", {
    name: SANDBOX,
    resources: { cpus: 2, memory_mb: 1024, network: true },
  });
  test("Create sandbox (authed)", resp.ok, `status=${resp.status}`);
}

{
  const resp = await apiPost(`/sandboxes/${SANDBOX}/start`);
  test("Start sandbox (authed)", resp.ok, `status=${resp.status}`);
}

{
  const result = await exec(SANDBOX, ["echo", "auth-works"]);
  test("Exec through auth", result.exit_code === 0 && result.stdout.trim() === "auth-works",
    `got: "${result.stdout.trim()}"`);
}

{
  const resp = await apiGet(`/sandboxes/${SANDBOX}`);
  test("Get sandbox info (authed)", resp.ok);
}

// ============================================================================
// Cleanup
// ============================================================================

console.log("\nCleanup:");
{
  await cleanup(SANDBOX);
  const resp = await apiGet(`/sandboxes/${SANDBOX}`);
  test("Sandbox cleaned up", resp.status === 404);
}

summary();
