/**
 * Shared test helpers for smolvm test suites.
 *
 * Centralizes API calls, exec normalization, and test reporting
 * so each test file can focus on assertions.
 */

export const BASE = "http://127.0.0.1:9090";
export const API = `${BASE}/api/v1`;

/** Read API token from SMOLVM_API_TOKEN env var. When set, all API calls include Authorization header. */
const API_TOKEN = Deno.env.get("SMOLVM_API_TOKEN");

/** Build headers for API requests, including auth token if configured. */
function apiHeaders(contentType?: string): Record<string, string> {
  const h: Record<string, string> = {};
  if (contentType) h["Content-Type"] = contentType;
  if (API_TOKEN) h["Authorization"] = `Bearer ${API_TOKEN}`;
  return h;
}

// ============================================================================
// Types
// ============================================================================

export interface ExecResult {
  exit_code: number;
  stdout: string;
  stderr: string;
}

export interface MachineInfo {
  name: string;
  state: string;
  pid?: number;
  mounts: unknown[];
  ports: unknown[];
  resources: Record<string, unknown>;
  network: boolean;
}

export interface ExecOpts {
  env?: { name: string; value: string }[];
  workdir?: string;
  timeout_secs?: number;
  user?: string;
}

// ============================================================================
// Response normalization
// ============================================================================

/** New binary returns exitCode (camelCase), tests use exit_code (snake_case). */
function normalizeExecResult(data: Record<string, unknown>): ExecResult {
  if (data.exitCode !== undefined && data.exit_code === undefined) {
    data.exit_code = data.exitCode as number;
  }
  return data as unknown as ExecResult;
}

// ============================================================================
// API helpers
// ============================================================================

/** Default timeout for API calls (30s). Prevents tests from hanging if server is unresponsive. */
const API_TIMEOUT_MS = 30_000;

/** Longer timeout for operations that pull images (120s). */
const IMAGE_TIMEOUT_MS = 120_000;

export async function apiPost(path: string, body?: unknown): Promise<Response> {
  return fetch(`${API}${path}`, {
    method: "POST",
    headers: apiHeaders("application/json"),
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
}

export async function apiGet(path: string): Promise<Response> {
  return fetch(`${API}${path}`, {
    headers: apiHeaders(),
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
}

export async function apiPut(path: string, body?: unknown): Promise<Response> {
  return fetch(`${API}${path}`, {
    method: "PUT",
    headers: apiHeaders("application/json"),
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
}

export async function apiDelete(path: string): Promise<Response> {
  return fetch(`${API}${path}`, {
    method: "DELETE",
    headers: apiHeaders(),
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
}

// ============================================================================
// Exec helpers
// ============================================================================

/** Execute a command in a machine. Normalizes the response format. */
export async function exec(
  machine: string,
  command: string[],
  opts?: ExecOpts,
): Promise<ExecResult> {
  const timeoutSecs = opts?.timeout_secs ?? 30;
  // Client-side timeout as fallback (agent timeout_secs not always enforced)
  const clientTimeoutMs = (timeoutSecs + 5) * 1000;
  const resp = await fetch(`${API}/machines/${machine}/exec`, {
    method: "POST",
    headers: apiHeaders("application/json"),
    body: JSON.stringify({ command, timeout_secs: timeoutSecs, ...opts }),
    signal: AbortSignal.timeout(clientTimeoutMs),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`exec failed (${resp.status}): ${text}`);
  }
  return normalizeExecResult(await resp.json());
}

/** Run a command via OCI image overlay. Normalizes the response format. */
export async function run(
  machine: string,
  image: string,
  command: string[],
  opts?: ExecOpts,
): Promise<ExecResult> {
  const resp = await fetch(`${API}/machines/${machine}/run`, {
    method: "POST",
    headers: apiHeaders("application/json"),
    body: JSON.stringify({ image, command, timeout_secs: 30, ...opts }),
    signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`run failed (${resp.status}): ${text}`);
  }
  return normalizeExecResult(await resp.json());
}

/** Pull an OCI image into a machine (longer timeout for large images). */
export async function pullImage(machine: string, image: string): Promise<Response> {
  return fetch(`${API}/machines/${machine}/images/pull`, {
    method: "POST",
    headers: apiHeaders("application/json"),
    body: JSON.stringify({ image }),
    signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS),
  });
}

/** Shorthand: run a shell command via sh -c. */
export async function sh(
  machine: string,
  cmd: string,
  opts?: ExecOpts,
): Promise<ExecResult> {
  return exec(machine, ["sh", "-c", cmd], { timeout_secs: 30, ...opts });
}

// ============================================================================
// Machine lifecycle helpers
// ============================================================================

/** Stop and delete a machine, ignoring errors. */
export async function cleanup(name: string) {
  try { await apiPost(`/machines/${name}/stop`); } catch { /* */ }
  try { await apiDelete(`/machines/${name}`); } catch { /* */ }
}

/** Create and start a machine, wait for it to be ready. */
export async function createAndStart(name: string, opts?: {
  mounts?: { source: string; target: string; readonly?: boolean }[];
  ports?: { host: number; guest: number }[];
  resources?: Record<string, unknown>;
}) {
  await cleanup(name);
  const createResp = await apiPost("/machines", {
    name,
    mounts: opts?.mounts ?? [],
    ports: opts?.ports ?? [],
    resources: { cpus: 2, memory_mb: 1024, network: true, ...opts?.resources },
  });
  if (!createResp.ok) throw new Error(`create failed: ${await createResp.text()}`);
  const startResp = await apiPost(`/machines/${name}/start`);
  if (!startResp.ok) throw new Error(`start failed: ${await startResp.text()}`);
  return startResp.json();
}

// ============================================================================
// Test reporter
// ============================================================================

export function createReporter() {
  let _passed = 0;
  let _failed = 0;
  let _skipped = 0;
  const _failures: string[] = [];

  return {
    test(name: string, ok: boolean, detail?: string) {
      if (ok) {
        console.log(`  ✅ ${name}`);
        _passed++;
      } else {
        console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
        _failed++;
        _failures.push(name);
      }
    },

    skip(name: string, reason: string) {
      console.log(`  ⬜ ${name} — ${reason}`);
      _skipped++;
    },

    summary() {
      console.log("\n==========================================");
      const parts = [`${_passed} passed`, `${_failed} failed`];
      if (_skipped) parts.push(`${_skipped} skipped`);
      console.log(`  Results: ${parts.join(", ")}`);
      if (_failures.length > 0) {
        console.log(`  Failed: ${_failures.join(", ")}`);
      }
      console.log("==========================================\n");
    },

    get passed() { return _passed; },
    get failed() { return _failed; },
    get skipped() { return _skipped; },
    get failures() { return _failures; },
  };
}
