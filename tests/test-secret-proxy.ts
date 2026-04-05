/**
 * CX04 smolvm — Secret Proxy End-to-End Test
 *
 * Tests the full secret proxy flow:
 * - Env var injection (placeholder key + base URL)
 * - Env var stripping (can't override protected vars)
 * - Proxy reachability from inside VM
 * - Validation (unknown secret names rejected)
 * - No-secret sandbox (no proxy env vars)
 * - Network auto-enable when secrets configured
 *
 * PREREQUISITE: Server must be started with secret proxy enabled:
 *   smolvm serve start --listen 127.0.0.1:8080 --secret anthropic=test-ant-test-key
 *
 * Run: deno task test-proxy
 */

import {
  apiPost, apiGet, apiDelete,
  exec, sh,
  cleanup,
  createReporter,
} from "./_helpers.ts";

const SANDBOX = "cx04-proxy-test";
const SANDBOX_NOSECRET = "cx04-proxy-nosecret";
const { test, skip, summary } = createReporter();

console.log("\n==========================================");
console.log("  CX04 smolvm — Secret Proxy E2E Test");
console.log("==========================================\n");

// ============================================================================
// Check if server has secrets configured
// ============================================================================

console.log("Pre-flight:");

// Try creating a sandbox with secrets to see if server has them configured
await cleanup(SANDBOX);
{
  const resp = await apiPost("/sandboxes", {
    name: SANDBOX,
    resources: { cpus: 2, memory_mb: 1024, network: true },
    secrets: ["anthropic"],
  });
  if (!resp.ok) {
    const text = await resp.text();
    if (text.includes("not configured") || text.includes("unknown secret") || resp.status === 400) {
      console.log("  ⚠️  Server not started with --secret anthropic=<key>");
      console.log("  ⚠️  Start server with: smolvm serve start --secret anthropic=test-ant-test-key");
      console.log("  ⚠️  Skipping proxy tests.\n");
      skip("All proxy tests", "server has no secrets configured");
      summary();
      Deno.exit(0);
    }
    test("Create sandbox with secrets", false, `unexpected error: ${text}`);
    summary();
    Deno.exit(1);
  }
  test("Create sandbox with secrets", true);
}

// Start the sandbox
{
  const resp = await apiPost(`/sandboxes/${SANDBOX}/start`);
  test("Start sandbox", resp.ok, `status=${resp.status}`);
}

// ============================================================================
// Env var injection
// ============================================================================

console.log("\nEnv Var Injection:");

{
  const result = await sh(SANDBOX, "env | grep ANTHROPIC_BASE_URL || echo 'NOT_SET'");
  const hasBaseUrl = result.stdout.includes("http://localhost:9800/anthropic");
  test("ANTHROPIC_BASE_URL injected", hasBaseUrl, `got: ${result.stdout.trim()}`);
}

{
  const result = await sh(SANDBOX, "env | grep ANTHROPIC_API_KEY || echo 'NOT_SET'");
  const hasPlaceholder = result.stdout.includes("smolvm-placeholder");
  test("ANTHROPIC_API_KEY is placeholder", hasPlaceholder, `got: ${result.stdout.trim()}`);
}

// ============================================================================
// Env var stripping
// ============================================================================

console.log("\nEnv Var Stripping:");

{
  // Try to override the API key via exec env — should be stripped
  const result = await exec(SANDBOX, ["sh", "-c", "echo $ANTHROPIC_API_KEY"], {
    env: [{ name: "ANTHROPIC_API_KEY", value: "test-ant-attack-key" }],
  });
  const wasStripped = !result.stdout.includes("test-ant-attack-key");
  const hasPlaceholder = result.stdout.includes("smolvm-placeholder");
  test("Override attempt stripped", wasStripped, `got: ${result.stdout.trim()}`);
  test("Placeholder still injected", hasPlaceholder, `got: ${result.stdout.trim()}`);
}

{
  // Non-protected env vars should still work
  const result = await exec(SANDBOX, ["sh", "-c", "echo $MY_CUSTOM_VAR"], {
    env: [{ name: "MY_CUSTOM_VAR", value: "custom-value" }],
  });
  test("Non-protected env vars work", result.stdout.trim() === "custom-value",
    `got: ${result.stdout.trim()}`);
}

// ============================================================================
// Proxy reachability
// ============================================================================

console.log("\nProxy Reachability:");

{
  // Check if the proxy port is listening inside the VM
  const result = await sh(SANDBOX, "curl -s -o /dev/null -w '%{http_code}' http://localhost:9800/anthropic/v1/messages -X POST -H 'Content-Type: application/json' -d '{}' 2>/dev/null || echo 'CURL_FAILED'", { timeout_secs: 15 });
  const output = result.stdout.trim();
  // Any HTTP response (even 400/401) means the proxy is reachable and forwarding
  const isReachable = /^\d{3}$/.test(output) && output !== "000";
  test("Proxy port reachable from VM", isReachable, `http_code: ${output}`);
  if (isReachable) {
    console.log(`     📋 Response code from Anthropic API: ${output} (expected 400 or 401 = proxy forwarding)`);
  }
}

// ============================================================================
// Network auto-enable
// ============================================================================

console.log("\nNetwork Auto-enable:");

{
  const resp = await apiGet(`/sandboxes/${SANDBOX}`);
  if (resp.ok) {
    const info = await resp.json();
    test("Network enabled when secrets configured", info.network === true);
  } else {
    test("Network enabled when secrets configured", false, `status=${resp.status}`);
  }
}

// ============================================================================
// Validation — unknown secret name
// ============================================================================

console.log("\nValidation:");

{
  const resp = await apiPost("/sandboxes", {
    name: "cx04-proxy-bad-secret",
    resources: { cpus: 2, memory_mb: 1024 },
    secrets: ["nonexistent-provider"],
  });
  const rejected = !resp.ok;
  test("Unknown secret name rejected", rejected, `status=${resp.status}`);
  if (!resp.ok) {
    const text = await resp.text();
    console.log(`     📋 Error: ${text.substring(0, 100)}`);
  } else {
    // Clean up if it somehow succeeded
    await cleanup("cx04-proxy-bad-secret");
  }
}

// ============================================================================
// No-secret sandbox — should have no proxy env vars
// ============================================================================

console.log("\nNo-Secret Sandbox:");

await cleanup(SANDBOX_NOSECRET);
{
  const createResp = await apiPost("/sandboxes", {
    name: SANDBOX_NOSECRET,
    resources: { cpus: 2, memory_mb: 1024, network: true },
    // no secrets field
  });
  if (createResp.ok) {
    const startResp = await apiPost(`/sandboxes/${SANDBOX_NOSECRET}/start`);
    if (startResp.ok) {
      const result = await sh(SANDBOX_NOSECRET, "env | grep ANTHROPIC || echo 'NONE'");
      const noProxyVars = !result.stdout.includes("ANTHROPIC_BASE_URL") && !result.stdout.includes("smolvm-placeholder");
      test("No proxy env vars without secrets", noProxyVars, `got: ${result.stdout.trim()}`);
    } else {
      test("No proxy env vars without secrets", false, "failed to start sandbox");
    }
  } else {
    test("No proxy env vars without secrets", false, "failed to create sandbox");
  }
}

// ============================================================================
// Cleanup
// ============================================================================

console.log("\nCleanup:");
{
  await cleanup(SANDBOX);
  await cleanup(SANDBOX_NOSECRET);
  const resp1 = await apiGet(`/sandboxes/${SANDBOX}`);
  const resp2 = await apiGet(`/sandboxes/${SANDBOX_NOSECRET}`);
  test("Sandboxes cleaned up", resp1.status === 404 && resp2.status === 404);
}

summary();
