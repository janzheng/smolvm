#!/usr/bin/env -S deno run --allow-net --allow-env --allow-read --allow-write --allow-run
/**
 * smolctl — CLI for managing smolvm machines via REST API.
 *
 * Like `wrangler` for Cloudflare Workers, but for smolvm microVMs.
 *
 * Environment:
 *   SMOLVM_URL         Server URL (default: http://127.0.0.1:9090)
 *   SMOLVM_API_TOKEN   Bearer token for auth
 */

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

// Load .env file if present (won't override existing env vars)
// Searches: project dir (../), then ~/.smolvm/
function loadEnvFile(path: string): boolean {
  try {
    const envText = Deno.readTextFileSync(path);
    for (const line of envText.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq < 0) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
      if (!Deno.env.get(key)) Deno.env.set(key, val);
    }
    return true;
  } catch { return false; }
}
// Try project-local .env first (next to cli/), then ~/.smolvm/.env as fallback
const cliDir = new URL(".", import.meta.url).pathname;
loadEnvFile(`${cliDir}../.env`) || loadEnvFile(`${Deno.env.get("HOME")}/.smolvm/.env`);
// Auto-refresh expired OAuth token (non-blocking — warns on failure)
// Deferred to after module load; called before main dispatch

let BASE_URL = (Deno.env.get("SMOLVM_URL") ?? "http://127.0.0.1:9090").replace(/\/$/, "");
let API = `${BASE_URL}/api/v1`;
let TOKEN = Deno.env.get("SMOLVM_API_TOKEN");
const TIMEOUT_MS = 30_000;
const LONG_TIMEOUT_MS = 120_000;

// ---------------------------------------------------------------------------
// Machine presets (permission configs for headless agents)
// ---------------------------------------------------------------------------

interface MachineConfig {
  allow: string[];
  deny?: string[];
}

const SANDBOX_PRESETS: Record<string, MachineConfig> = {
  /** Auto-approve everything non-destructive. The "stop asking me" mode. */
  permissive: {
    allow: [
      "Read", "Write", "Edit", "Glob", "Grep", "NotebookEdit",
      "WebSearch", "WebFetch",
      "Bash",
      "Agent", "Task", "TaskOutput", "ToolSearch", "Skill",
      "mcp__*",
    ],
  },
  /** Research — web + files, no git */
  research: {
    allow: [
      "Read", "Write", "Edit", "Glob", "Grep",
      "WebSearch", "WebFetch",
      "Bash(mkdir:*)", "Bash(ls:*)", "Bash(cat:*)", "Bash(curl:*)", "Bash(jq:*)",
      "ToolSearch", "mcp__*",
    ],
    deny: ["Bash(git:*)", "Bash(gh:*)", "Bash(sudo:*)"],
  },
  /** Developer — everything, deny only destructive git ops */
  developer: {
    allow: [
      "Read", "Write", "Edit", "Glob", "Grep", "NotebookEdit",
      "WebSearch", "WebFetch", "Bash",
      "Agent", "Task", "TaskOutput", "ToolSearch", "Skill", "mcp__*",
    ],
    deny: [
      "Bash(git push --force:*)", "Bash(git reset --hard:*)",
      "Bash(git clean:*)", "Bash(sudo:*)",
    ],
  },
};

function resolveMachineConfig(value: string): MachineConfig {
  if (SANDBOX_PRESETS[value]) return SANDBOX_PRESETS[value];
  try { return JSON.parse(value) as MachineConfig; }
  catch { die(`Unknown machine preset: ${value}. Try: permissive, research, developer, or JSON`); }
}

/** Write agent settings.json to machine via file API, return the path inside the VM. */
async function writeAgentSettings(machine: string, config: MachineConfig): Promise<string> {
  const settings = JSON.stringify({
    permissions: {
      allow: config.allow,
      ...(config.deny ? { deny: config.deny } : {}),
    },
  }, null, 2);
  const encoded = btoa(settings);
  const settingsPath = "/tmp/agent-settings.json";
  const encodedPath = encodeURIComponent(settingsPath);
  const resp = await apiCall("PUT", `/machines/${machine}/files/${encodedPath}`, { content: encoded });
  await okOrDie(resp, "write agent settings");
  return settingsPath;
}

/** Check agent output for signs of permission denials and emit a warning. */
function checkPermissionDenials(
  exitCode: number, stdout: string, stderr: string,
  machineName: string, outputJson: boolean,
): void {
  if (exitCode === 0) return;
  const combined = ((stdout ?? "") + (stderr ?? "")).toLowerCase();
  const signals = ["permission", "denied", "not allowed", "don't have permission", "tool_use_blocked"];
  if (!signals.some((s) => combined.includes(s))) return;

  if (outputJson) {
    console.error(JSON.stringify({ warning: "permission_denial_detected", machine: machineName, hint: "Try a more permissive preset." }));
  } else {
    console.error(`\nAgent may have hit permission restrictions in machine "${machineName}".`);
    console.error(`  Inspect presets: smolctl machine ls / smolctl machine show <preset>`);
    console.error(`  Try: --machine permissive`);
  }
}

// ---------------------------------------------------------------------------
// Machine inspect commands
// ---------------------------------------------------------------------------

function cmdMachineLs() {
  const rows = Object.entries(SANDBOX_PRESETS).map(([name, config]) => ({
    name,
    allow: config.allow.length,
    deny: (config.deny ?? []).length,
  }));
  table(rows, ["name", "allow", "deny"]);
}

function cmdMachineShow(preset: string) {
  const config = SANDBOX_PRESETS[preset];
  if (!config) die(`Unknown preset: ${preset}. Available: ${Object.keys(SANDBOX_PRESETS).join(", ")}`);
  console.log(`Preset: ${preset}\n`);
  console.log("Allow:");
  for (const rule of config.allow) console.log(`  + ${rule}`);
  if (config.deny?.length) {
    console.log("\nDeny:");
    for (const rule of config.deny) console.log(`  - ${rule}`);
  }
}

function cmdMachineTest(preset: string, tool: string) {
  const config = SANDBOX_PRESETS[preset];
  if (!config) die(`Unknown preset: ${preset}. Available: ${Object.keys(SANDBOX_PRESETS).join(", ")}`);
  const matches = (pattern: string, value: string) => {
    if (pattern === value) return true;
    if (pattern.endsWith("*") && value.startsWith(pattern.slice(0, -1))) return true;
    return false;
  };
  const denied = config.deny?.some((p) => matches(p, tool)) ?? false;
  const allowed = config.allow.some((p) => matches(p, tool));
  if (denied) console.log(`DENIED: "${tool}" by preset "${preset}"`);
  else if (allowed) console.log(`ALLOWED: "${tool}" by preset "${preset}"`);
  else console.log(`UNMATCHED: "${tool}" — would prompt in default mode`);
}

// ---------------------------------------------------------------------------
// OAuth — PKCE flow for Claude subscription auth
// ---------------------------------------------------------------------------

const OAUTH_CLIENT_ID = atob("OWQxYzI1MGEtZTYxYi00NGQ5LTg4ZWQtNTk0NGQxOTYyZjVl");
const OAUTH_AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const OAUTH_TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
const OAUTH_REDIRECT_URI = "https://console.anthropic.com/oauth/code/callback";
const OAUTH_SCOPES = "org:create_api_key user:profile user:inference";

function base64Url(buf: Uint8Array): string {
  return btoa(String.fromCharCode(...buf))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

async function generatePKCE(): Promise<{ verifier: string; challenge: string }> {
  const raw = new Uint8Array(32);
  crypto.getRandomValues(raw);
  const verifier = base64Url(raw);
  const hashBuf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const challenge = base64Url(new Uint8Array(hashBuf));
  return { verifier, challenge };
}

function createOAuthSession(verifier: string, challenge: string, state: string): string {
  const params = new URLSearchParams({
    code: "true",
    client_id: OAUTH_CLIENT_ID,
    response_type: "code",
    redirect_uri: OAUTH_REDIRECT_URI,
    scope: OAUTH_SCOPES,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
  });
  return `${OAUTH_AUTHORIZE_URL}?${params.toString()}`;
}

function parseAuthCode(input: string): { code: string; state: string } {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("Authorization code is required");
  // Try parsing as full callback URL
  try {
    const url = new URL(trimmed);
    const code = url.searchParams.get("code")?.trim();
    const state = url.searchParams.get("state")?.trim();
    if (code && state) return { code, state };
  } catch { /* not a URL */ }
  // Parse as code#state
  const [codeRaw, stateRaw] = trimmed.split("#", 2);
  const code = codeRaw?.trim();
  const state = stateRaw?.trim();
  if (!code) throw new Error("Authorization code is required");
  if (!state) throw new Error("State is required. Paste in code#state format.");
  return { code, state };
}

async function exchangeAuthCode(code: string, state: string, verifier: string): Promise<{
  accessToken: string; refreshToken: string; expiresAt: number;
}> {
  const resp = await fetch(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(15_000),
    body: JSON.stringify({
      grant_type: "authorization_code",
      client_id: OAUTH_CLIENT_ID,
      code,
      state,
      redirect_uri: OAUTH_REDIRECT_URI,
      code_verifier: verifier,
    }),
  });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    throw new Error(`Token exchange failed (${resp.status}): ${errText || "Unknown error"}`);
  }
  const data = await resp.json() as { access_token?: string; refresh_token?: string; expires_in?: number };
  if (typeof data.access_token !== "string" || typeof data.refresh_token !== "string" || typeof data.expires_in !== "number") {
    throw new Error("Invalid token response from Anthropic");
  }
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1000 - 5 * 60 * 1000, // 5-min buffer
  };
}

async function refreshAccessToken(refreshToken: string): Promise<{
  accessToken: string; refreshToken: string; expiresAt: number;
} | null> {
  try {
    const resp = await fetch(OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: OAUTH_CLIENT_ID,
      }),
    });
    if (!resp.ok) return null;
    const data = await resp.json() as { access_token?: string; refresh_token?: string; expires_in?: number };
    if (typeof data.access_token !== "string" || typeof data.refresh_token !== "string" || typeof data.expires_in !== "number") return null;
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Date.now() + data.expires_in * 1000 - 5 * 60 * 1000,
    };
  } catch { return null; }
}

function maskToken(token: string): string {
  if (token.length <= 15) return "***";
  return token.slice(0, 12) + "..." + token.slice(-4);
}

/** Resolve the project .env path (next to cli/) */
function envFilePath(): string {
  const dir = new URL(".", import.meta.url).pathname;
  return `${dir}../.env`;
}

/** Update or insert a key=value in the .env file */
function upsertEnvVar(envPath: string, key: string, value: string): void {
  let lines: string[];
  try { lines = Deno.readTextFileSync(envPath).split("\n"); } catch { lines = []; }
  const idx = lines.findIndex((l) => l.trim().startsWith(`${key}=`) || l.trim().startsWith(`${key} =`));
  if (idx >= 0) {
    lines[idx] = `${key}=${value}`;
  } else {
    // Add before first blank line at end, or append
    lines.push(`${key}=${value}`);
  }
  Deno.writeTextFileSync(envPath, lines.join("\n"));
  // Ensure 600 permissions
  try { Deno.chmodSync(envPath, 0o600); } catch { /* Windows or permission issue */ }
}

/** Remove a key from the .env file */
function removeEnvVar(envPath: string, key: string): void {
  try {
    const lines = Deno.readTextFileSync(envPath).split("\n");
    const filtered = lines.filter((l) => !l.trim().startsWith(`${key}=`) && !l.trim().startsWith(`${key} =`));
    Deno.writeTextFileSync(envPath, filtered.join("\n"));
  } catch { /* file doesn't exist */ }
}

async function cmdAuthLogin() {
  console.log("Authenticating with Claude (Anthropic OAuth)...\n");

  // 1. Generate PKCE
  const { verifier, challenge } = await generatePKCE();
  const stateRaw = new Uint8Array(32);
  crypto.getRandomValues(stateRaw);
  const state = base64Url(stateRaw);

  // 2. Build auth URL and open browser
  const authUrl = createOAuthSession(verifier, challenge, state);
  console.log("Opening browser for authorization...");
  console.log(`If it doesn't open, visit:\n  ${authUrl}\n`);

  try {
    const cmd = Deno.build.os === "darwin" ? "open" : "xdg-open";
    const proc = new Deno.Command(cmd, { args: [authUrl], stderr: "null", stdout: "null" });
    proc.spawn();
  } catch { /* couldn't open browser — URL is printed above */ }

  // 3. Prompt for code
  const buf = new Uint8Array(2048);
  Deno.stdout.writeSync(new TextEncoder().encode("Paste the authorization code (code#state):\n> "));
  const n = await Deno.stdin.read(buf);
  if (!n) die("No input received");
  const rawCode = new TextDecoder().decode(buf.subarray(0, n));

  // 4. Parse and validate
  let parsed: { code: string; state: string };
  try {
    parsed = parseAuthCode(rawCode);
  } catch (e) {
    die((e as Error).message);
  }
  if (parsed!.state !== state) {
    die("State mismatch — the authorization code doesn't match this session. Try again.");
  }

  // 5. Exchange for tokens
  console.log("\nExchanging code for tokens...");
  let tokens: { accessToken: string; refreshToken: string; expiresAt: number };
  try {
    tokens = await exchangeAuthCode(parsed!.code, parsed!.state, verifier);
  } catch (e) {
    die(`Token exchange failed: ${(e as Error).message}`);
  }

  // 6. Write to .env
  const envPath = envFilePath();
  upsertEnvVar(envPath, "CLAUDE_CODE_OAUTH_TOKEN", tokens!.accessToken);
  upsertEnvVar(envPath, "CLAUDE_CODE_OAUTH_REFRESH_TOKEN", tokens!.refreshToken);
  upsertEnvVar(envPath, "CLAUDE_CODE_OAUTH_EXPIRES_AT", tokens!.expiresAt.toString());

  // Also set in current process
  Deno.env.set("CLAUDE_CODE_OAUTH_TOKEN", tokens!.accessToken);
  Deno.env.set("CLAUDE_CODE_OAUTH_REFRESH_TOKEN", tokens!.refreshToken);
  Deno.env.set("CLAUDE_CODE_OAUTH_EXPIRES_AT", tokens!.expiresAt.toString());

  const hoursLeft = Math.round((tokens!.expiresAt - Date.now()) / 3600000 * 10) / 10;
  console.log(`\nLogged in. Token expires in ${hoursLeft} hours.`);
  console.log(`Token: ${maskToken(tokens!.accessToken)}`);
  console.log(`Saved to: ${envPath}`);

  // Check .gitignore
  try {
    const gitignore = Deno.readTextFileSync(`${new URL(".", import.meta.url).pathname}../.gitignore`);
    if (!gitignore.includes(".env")) {
      console.warn("\nWARNING: .env is not in .gitignore! Add it to avoid committing secrets.");
    }
  } catch { /* no .gitignore */ }
}

async function cmdAuthStatus() {
  const token = Deno.env.get("CLAUDE_CODE_OAUTH_TOKEN");
  const expiresAt = parseInt(Deno.env.get("CLAUDE_CODE_OAUTH_EXPIRES_AT") ?? "0");
  const refreshToken = Deno.env.get("CLAUDE_CODE_OAUTH_REFRESH_TOKEN");

  if (!token) {
    console.log("Not authenticated. Run: smolctl auth login");
    return;
  }

  const now = Date.now();
  const expired = expiresAt > 0 && expiresAt < now;
  const hoursLeft = expiresAt > 0 ? Math.round((expiresAt - now) / 3600000 * 10) / 10 : "unknown";

  console.log(`Token:     ${maskToken(token)}`);
  console.log(`Status:    ${expired ? "EXPIRED" : "active"}`);
  console.log(`Expires:   ${expiresAt > 0 ? new Date(expiresAt).toISOString() : "unknown"} (${expired ? "expired" : `${hoursLeft}h left`})`);
  console.log(`Refresh:   ${refreshToken ? "available" : "none"}`);

  // Source
  const envPath = envFilePath();
  try { Deno.statSync(envPath); console.log(`Source:    ${envPath}`); } catch { console.log("Source:    env var"); }
}

function cmdAuthLogout() {
  const envPath = envFilePath();
  removeEnvVar(envPath, "CLAUDE_CODE_OAUTH_TOKEN");
  removeEnvVar(envPath, "CLAUDE_CODE_OAUTH_REFRESH_TOKEN");
  removeEnvVar(envPath, "CLAUDE_CODE_OAUTH_EXPIRES_AT");
  console.log("Logged out. Tokens removed from .env");
}

/** Check token expiry on startup and auto-refresh if possible */
async function autoRefreshToken(): Promise<void> {
  const expiresAt = parseInt(Deno.env.get("CLAUDE_CODE_OAUTH_EXPIRES_AT") ?? "0");
  if (expiresAt <= 0 || expiresAt > Date.now()) return; // not expired or no expiry info

  const refreshTok = Deno.env.get("CLAUDE_CODE_OAUTH_REFRESH_TOKEN");
  if (!refreshTok) {
    console.error("OAuth token expired. Run: smolctl auth login");
    return;
  }

  const tokens = await refreshAccessToken(refreshTok);
  if (!tokens) {
    console.error("OAuth token expired and refresh failed. Run: smolctl auth login");
    return;
  }

  // Update .env and current process
  const envPath = envFilePath();
  upsertEnvVar(envPath, "CLAUDE_CODE_OAUTH_TOKEN", tokens.accessToken);
  upsertEnvVar(envPath, "CLAUDE_CODE_OAUTH_REFRESH_TOKEN", tokens.refreshToken);
  upsertEnvVar(envPath, "CLAUDE_CODE_OAUTH_EXPIRES_AT", tokens.expiresAt.toString());
  Deno.env.set("CLAUDE_CODE_OAUTH_TOKEN", tokens.accessToken);
  Deno.env.set("CLAUDE_CODE_OAUTH_REFRESH_TOKEN", tokens.refreshToken);
  Deno.env.set("CLAUDE_CODE_OAUTH_EXPIRES_AT", tokens.expiresAt.toString());

  const hoursLeft = Math.round((tokens.expiresAt - Date.now()) / 3600000 * 10) / 10;
  console.error(`Token refreshed (expires in ${hoursLeft}h)`);
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function authHeaders(contentType?: string): Record<string, string> {
  const h: Record<string, string> = {};
  if (contentType) h["Content-Type"] = contentType;
  if (TOKEN) h["Authorization"] = `Bearer ${TOKEN}`;
  return h;
}

async function apiCall(
  method: string,
  path: string,
  body?: unknown,
  timeout = TIMEOUT_MS,
): Promise<Response> {
  const url = path.startsWith("http") ? path : `${API}${path}`;
  const init: RequestInit = {
    method,
    headers: authHeaders(body !== undefined ? "application/json" : undefined),
    signal: AbortSignal.timeout(timeout),
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  return fetch(url, init);
}

async function jsonResult<T>(resp: Response): Promise<T> {
  if (!resp.ok) {
    const text = await resp.text();
    die(`API error (${resp.status}): ${text}`);
  }
  return resp.json() as Promise<T>;
}

async function okOrDie(resp: Response, action: string): Promise<void> {
  if (!resp.ok) {
    const text = await resp.text();
    die(`${action} failed (${resp.status}): ${text}`);
  }
  await resp.text();
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

function die(msg: string, code = 1): never {
  console.error(`error: ${msg}`);
  Deno.exit(code);
}

function table(rows: Record<string, unknown>[], columns?: string[]) {
  if (rows.length === 0) {
    console.log("(none)");
    return;
  }
  const cols = columns ?? Object.keys(rows[0]);
  const widths = cols.map((c) =>
    Math.max(c.length, ...rows.map((r) => String(r[c] ?? "").length))
  );
  console.log(cols.map((c, i) => c.toUpperCase().padEnd(widths[i])).join("  "));
  console.log(widths.map((w) => "─".repeat(w)).join("  "));
  for (const row of rows) {
    console.log(cols.map((c, i) => String(row[c] ?? "").padEnd(widths[i])).join("  "));
  }
}

// ---------------------------------------------------------------------------
// Metadata store (~/.smolvm/metadata/)
// ---------------------------------------------------------------------------

interface MachineMeta {
  name: string;
  owner?: string;
  labels?: Record<string, string>;
  description?: string;
  created_at: string;
  starter?: string;
  secrets?: string[];
  signature_verified?: boolean;
  signature_key_id?: string;
  signature_timestamp?: string;
  node?: string;
}

const SMOLVM_HOME = `${Deno.env.get("HOME")}/.smolvm`;

async function saveMeta(meta: MachineMeta): Promise<void> {
  const dir = `${SMOLVM_HOME}/metadata`;
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(`${dir}/${meta.name}.json`, JSON.stringify(meta, null, 2) + "\n");
}

async function loadMeta(name: string): Promise<MachineMeta | null> {
  try {
    const text = await Deno.readTextFile(`${SMOLVM_HOME}/metadata/${name}.json`);
    return JSON.parse(text) as MachineMeta;
  } catch {
    return null;
  }
}

async function deleteMeta(name: string): Promise<void> {
  try { await Deno.remove(`${SMOLVM_HOME}/metadata/${name}.json`); } catch { /* ok */ }
}

async function listMeta(): Promise<MachineMeta[]> {
  const dir = `${SMOLVM_HOME}/metadata`;
  const results: MachineMeta[] = [];
  try {
    for await (const entry of Deno.readDir(dir)) {
      if (entry.isFile && entry.name.endsWith(".json")) {
        try {
          const text = await Deno.readTextFile(`${dir}/${entry.name}`);
          results.push(JSON.parse(text));
        } catch { /* skip corrupt */ }
      }
    }
  } catch { /* dir doesn't exist */ }
  return results.sort((a, b) => a.name.localeCompare(b.name));
}

/** Parse --label key=value flags into a Record. */
function parseLabels(flags: Record<string, string[]>): Record<string, string> | undefined {
  const labelPairs = flagAll(flags, "label");
  if (labelPairs.length === 0) return undefined;
  const labels: Record<string, string> = {};
  for (const pair of labelPairs) {
    const [k, ...v] = pair.split("=");
    labels[k] = v.join("=");
  }
  return labels;
}

// ---------------------------------------------------------------------------
// Pool management (~/.smolvm/pool.json)
// ---------------------------------------------------------------------------

const POOL_FILE = `${SMOLVM_HOME}/pool.json`;
const POOL_HEALTH_TIMEOUT_MS = 2_000;

interface PoolNode {
  name: string;
  url: string;
  token?: string;
  max_machines?: number;
}

interface PoolConfig {
  nodes: PoolNode[];
  strategy: "round-robin" | "least-loaded";
  _rr_index?: number; // round-robin counter (not persisted, runtime only)
}

async function loadPoolConfig(): Promise<PoolConfig> {
  try {
    const text = await Deno.readTextFile(POOL_FILE);
    return JSON.parse(text) as PoolConfig;
  } catch {
    return { nodes: [], strategy: "round-robin" };
  }
}

async function savePoolConfig(config: PoolConfig): Promise<void> {
  await Deno.mkdir(SMOLVM_HOME, { recursive: true });
  // Strip runtime-only fields before persisting
  const toSave = { nodes: config.nodes, strategy: config.strategy };
  await Deno.writeTextFile(POOL_FILE, JSON.stringify(toSave, null, 2) + "\n");
}

/** Make an API call to a specific node (with its own token). */
async function nodeApiCall(
  node: PoolNode,
  method: string,
  path: string,
  body?: unknown,
  timeout = TIMEOUT_MS,
): Promise<Response> {
  const baseUrl = node.url.replace(/\/$/, "");
  const url = path.startsWith("http") ? path : `${baseUrl}/api/v1${path}`;
  const h: Record<string, string> = {};
  if (body !== undefined) h["Content-Type"] = "application/json";
  if (node.token) h["Authorization"] = `Bearer ${node.token}`;
  else if (TOKEN) h["Authorization"] = `Bearer ${TOKEN}`;
  const init: RequestInit = { method, headers: h, signal: AbortSignal.timeout(timeout) };
  if (body !== undefined) init.body = JSON.stringify(body);
  return fetch(url, init);
}

/** Check health of a single pool node. Returns { online, machineCount }. */
async function checkNodeHealth(node: PoolNode): Promise<{ online: boolean; machine_count: number }> {
  try {
    const baseUrl = node.url.replace(/\/$/, "");
    const h: Record<string, string> = {};
    if (node.token) h["Authorization"] = `Bearer ${node.token}`;
    else if (TOKEN) h["Authorization"] = `Bearer ${TOKEN}`;
    const resp = await fetch(`${baseUrl}/health`, {
      headers: h,
      signal: AbortSignal.timeout(POOL_HEALTH_TIMEOUT_MS),
    });
    if (!resp.ok) { await resp.text(); return { online: false, machine_count: 0 }; }
    await resp.json();
    // Try to count machines
    try {
      const sbResp = await fetch(`${baseUrl}/api/v1/machines`, {
        headers: h,
        signal: AbortSignal.timeout(POOL_HEALTH_TIMEOUT_MS),
      });
      if (sbResp.ok) {
        const data = await sbResp.json() as { machines: unknown[] };
        return { online: true, machine_count: data.machines?.length ?? 0 };
      }
      await sbResp.text();
    } catch { /* ignore machine count failure */ }
    return { online: true, machine_count: 0 };
  } catch {
    return { online: false, machine_count: 0 };
  }
}

/** Resolve which node a machine is on (from metadata). */
async function resolveNodeForMachine(name: string): Promise<PoolNode | null> {
  const meta = await loadMeta(name);
  if (meta?.node) {
    const pool = await loadPoolConfig();
    const node = pool.nodes.find((n) => n.name === meta.node);
    if (node) return node;
  }
  return null;
}

/** Pick a node using the pool routing strategy. */
async function pickNode(pool: PoolConfig, explicitNode?: string): Promise<PoolNode> {
  if (pool.nodes.length === 0) die("pool has no nodes. Run 'smolctl pool add <name> <url>' first.");

  // Explicit node selection
  if (explicitNode) {
    const node = pool.nodes.find((n) => n.name === explicitNode);
    if (!node) die(`node '${explicitNode}' not found in pool. Run 'smolctl pool ls' to see available nodes.`);
    return node;
  }

  if (pool.strategy === "least-loaded") {
    // Check all nodes in parallel, pick the one with most remaining capacity
    const checks = await Promise.all(
      pool.nodes.map(async (node) => {
        const health = await checkNodeHealth(node);
        const remaining = node.max_machines
          ? node.max_machines - health.machine_count
          : Infinity;
        return { node, online: health.online, remaining };
      }),
    );
    const online = checks.filter((c) => c.online && c.remaining > 0);
    if (online.length === 0) die("no online nodes with capacity found in pool.");
    online.sort((a, b) => b.remaining - a.remaining);
    return online[0].node;
  }

  // Default: round-robin
  const idx = pool._rr_index ?? 0;
  const node = pool.nodes[idx % pool.nodes.length];
  pool._rr_index = (idx + 1) % pool.nodes.length;
  return node;
}

// --- Pool commands ---

async function cmdPoolAdd(name: string, url: string, args: string[]) {
  const { flags } = parseFlags(args, ["token", "max"]);
  const config = await loadPoolConfig();
  // Remove existing node with same name
  config.nodes = config.nodes.filter((n) => n.name !== name);
  const node: PoolNode = { name, url: url.replace(/\/$/, "") };
  if (flag(flags, "token")) node.token = flag(flags, "token");
  const maxStr = flag(flags, "max");
  if (maxStr) {
    const max = parseInt(maxStr);
    if (isNaN(max) || max < 1) die("--max must be a positive integer");
    node.max_machines = max;
  }
  config.nodes.push(node);
  await savePoolConfig(config);
  console.log(`Added node '${name}' (${url})`);
}

async function cmdPoolRm(name: string) {
  const config = await loadPoolConfig();
  const before = config.nodes.length;
  config.nodes = config.nodes.filter((n) => n.name !== name);
  if (config.nodes.length === before) die(`node '${name}' not found in pool.`);
  await savePoolConfig(config);
  console.log(`Removed node '${name}' from pool.`);
}

async function cmdPoolLs() {
  const config = await loadPoolConfig();
  if (config.nodes.length === 0) {
    console.log("No nodes in pool. Run 'smolctl pool add <name> <url>' to add one.");
    return;
  }
  // Check all nodes in parallel
  const results = await Promise.all(
    config.nodes.map(async (node) => {
      const health = await checkNodeHealth(node);
      const maxStr = node.max_machines != null ? String(node.max_machines) : "-";
      const machineStr = health.online
        ? `${health.machine_count}/${node.max_machines != null ? node.max_machines : "\u221e"}`
        : "-";
      return {
        name: node.name,
        url: node.url,
        status: health.online ? "online" : "offline",
        machines: machineStr,
        max: maxStr,
      };
    }),
  );
  table(results, ["name", "url", "status", "machines", "max"]);
}

async function cmdPoolStatus() {
  const config = await loadPoolConfig();
  if (config.nodes.length === 0) {
    console.log("No nodes in pool.");
    return;
  }
  const results = await Promise.all(
    config.nodes.map(async (node) => {
      const health = await checkNodeHealth(node);
      return { node, ...health };
    }),
  );
  const onlineCount = results.filter((r) => r.online).length;
  const totalMachinees = results.reduce((sum, r) => sum + r.machine_count, 0);
  const totalCapacity = config.nodes.reduce((sum, n) => {
    if (n.max_machines == null) return Infinity;
    return sum === Infinity ? Infinity : sum + n.max_machines;
  }, 0);
  console.log(`Pool strategy: ${config.strategy}`);
  console.log(`Nodes: ${onlineCount}/${config.nodes.length} online`);
  console.log(`Machinees: ${totalMachinees}${totalCapacity === Infinity ? "" : `/${totalCapacity}`}`);
  for (const r of results) {
    const icon = r.online ? "+" : "-";
    console.log(`  [${icon}] ${r.node.name} (${r.node.url}) — ${r.machine_count} machines`);
  }
}

async function cmdPoolRoute(machineName: string) {
  const node = await resolveNodeForMachine(machineName);
  if (node) {
    console.log(`Machine '${machineName}' is on node '${node.name}' (${node.url})`);
  } else {
    console.log(`Machine '${machineName}' has no pool node assignment (using default server).`);
  }
}

async function cmdPoolStrategy(strategy: string) {
  if (strategy !== "round-robin" && strategy !== "least-loaded") {
    die(`invalid strategy '${strategy}'. Choose: round-robin, least-loaded`);
  }
  const config = await loadPoolConfig();
  config.strategy = strategy;
  await savePoolConfig(config);
  console.log(`Pool strategy set to '${strategy}'.`);
}

// ---------------------------------------------------------------------------
// Session recording (~/.smolvm/sessions/)
// ---------------------------------------------------------------------------

interface AuditEntry {
  timestamp: string;
  machine: string;
  action: string;
  duration_ms?: number;
  details?: Record<string, unknown>;
}

async function recordSession(entry: AuditEntry): Promise<void> {
  const dir = `${SMOLVM_HOME}/sessions`;
  await Deno.mkdir(dir, { recursive: true });
  const file = `${dir}/${entry.machine}.ndjson`;
  await Deno.writeTextFile(file, JSON.stringify(entry) + "\n", { append: true });
}

async function cmdSessionLs() {
  const dir = `${SMOLVM_HOME}/sessions`;
  const sessions: { name: string; entries: number; last_action: string }[] = [];
  try {
    for await (const entry of Deno.readDir(dir)) {
      if (entry.isFile && entry.name.endsWith(".ndjson")) {
        const name = entry.name.replace(".ndjson", "");
        const text = await Deno.readTextFile(`${dir}/${entry.name}`);
        const lines = text.trim().split("\n").filter(Boolean);
        const last = lines.length > 0 ? JSON.parse(lines[lines.length - 1]) : {};
        sessions.push({ name, entries: lines.length, last_action: last.action ?? "?" });
      }
    }
  } catch { /* dir doesn't exist */ }
  if (sessions.length === 0) {
    console.log("No recorded sessions.");
    return;
  }
  table(sessions, ["name", "entries", "last_action"]);
}

async function cmdSessionShow(name: string) {
  const file = `${SMOLVM_HOME}/sessions/${name}.ndjson`;
  let text: string;
  try {
    text = await Deno.readTextFile(file);
  } catch {
    die(`No session found for: ${name}`);
  }
  const lines = text.trim().split("\n").filter(Boolean);
  for (const line of lines) {
    const entry = JSON.parse(line) as AuditEntry;
    const dur = entry.duration_ms ? ` (${entry.duration_ms}ms)` : "";
    console.log(`[${entry.timestamp}] ${entry.action}${dur}`);
    if (entry.details) {
      for (const [k, v] of Object.entries(entry.details)) {
        const val = typeof v === "string" ? v : JSON.stringify(v);
        console.log(`  ${k}: ${val.slice(0, 200)}`);
      }
    }
  }
}

async function cmdSessionRm(name: string) {
  try {
    await Deno.remove(`${SMOLVM_HOME}/sessions/${name}.ndjson`);
    console.log(`Deleted session: ${name}`);
  } catch {
    die(`No session found for: ${name}`);
  }
}

/**
 * Audit trail: show secret access history for a machine.
 * Combines metadata (which secrets were enabled) with session logs
 * (when the machine was created, executed commands, etc.)
 */
async function cmdAudit(name: string) {
  const meta = await loadMeta(name);
  const sessionFile = `${SMOLVM_HOME}/sessions/${name}.ndjson`;

  console.log(`=== Audit Trail: ${name} ===\n`);

  // Metadata
  if (meta) {
    console.log(`Owner:    ${meta.owner ?? "unknown"}`);
    console.log(`Created:  ${meta.created_at}`);
    console.log(`Starter:  ${meta.starter ?? "default"}`);
    console.log(`Secrets:  ${meta.secrets?.join(", ") ?? "none"}`);
    if (meta.labels && Object.keys(meta.labels).length > 0) {
      console.log(`Labels:   ${Object.entries(meta.labels).map(([k, v]) => `${k}=${v}`).join(", ")}`);
    }
  } else {
    console.log("(no cached metadata)");
  }

  // Session log with secret-relevant events highlighted
  console.log("\n--- Event Log ---");
  let text: string;
  try {
    text = await Deno.readTextFile(sessionFile);
  } catch {
    console.log("(no session log)");
    return;
  }

  const lines = text.trim().split("\n").filter(Boolean);
  for (const line of lines) {
    const entry = JSON.parse(line) as AuditEntry;
    const dur = entry.duration_ms ? ` (${entry.duration_ms}ms)` : "";
    // Highlight secret-related events
    const isSecretRelated = entry.action === "create" && entry.details?.secrets;
    const marker = isSecretRelated ? " [SECRETS]" : "";
    console.log(`  [${entry.timestamp}] ${entry.action}${dur}${marker}`);
    if (entry.details) {
      for (const [k, v] of Object.entries(entry.details)) {
        if (k === "secrets" || k === "command" || k === "exit_code" || k === "prompt") {
          const val = typeof v === "string" ? v : JSON.stringify(v);
          console.log(`    ${k}: ${val.slice(0, 300)}`);
        }
      }
    }
  }

  // Summary
  const totalExecs = lines.filter(l => {
    const e = JSON.parse(l) as AuditEntry;
    return e.action === "exec" || e.action === "job_exec";
  }).length;
  console.log(`\n--- Summary ---`);
  console.log(`  Total events:    ${lines.length}`);
  console.log(`  Exec calls:      ${totalExecs}`);
  console.log(`  Secrets enabled: ${meta?.secrets?.join(", ") ?? "none"}`);
}

// ---------------------------------------------------------------------------
// Structured event log (~/.smolvm/events.ndjson)
// ---------------------------------------------------------------------------

interface EventLogEntry {
  timestamp: string;
  event: string;       // "machine.create" | "machine.start" | "machine.stop" | "machine.delete" | "exec" | "job.submit" | "job.complete" etc.
  machine?: string;
  actor?: string;      // owner/user
  details?: Record<string, unknown>;
}

async function logEvent(entry: EventLogEntry): Promise<void> {
  const file = `${SMOLVM_HOME}/events.ndjson`;
  await Deno.mkdir(SMOLVM_HOME, { recursive: true });
  await Deno.writeTextFile(file, JSON.stringify(entry) + "\n", { append: true });
}

async function cmdEvents(args: string[]) {
  const { flags, positional } = parseFlags(args, ["machine", "event", "since", "limit", "json"]);
  const filterMachine = flag(flags, "machine");
  const filterEvent = flag(flags, "event");
  const since = flag(flags, "since");
  const limit = parseInt(flag(flags, "limit") ?? "50");
  const outputJson = hasFlag(flags, "json");

  const file = `${SMOLVM_HOME}/events.ndjson`;
  let text: string;
  try {
    text = await Deno.readTextFile(file);
  } catch {
    console.log("No events recorded.");
    return;
  }

  let entries = text.trim().split("\n").filter(Boolean).map(l => JSON.parse(l) as EventLogEntry);

  // Apply filters
  if (filterMachine) entries = entries.filter(e => e.machine === filterMachine);
  if (filterEvent) entries = entries.filter(e => e.event.includes(filterEvent));
  if (since) {
    const sinceDate = new Date(since);
    entries = entries.filter(e => new Date(e.timestamp) >= sinceDate);
  }

  // Take last N
  entries = entries.slice(-limit);

  if (entries.length === 0) {
    console.log("No matching events.");
    return;
  }

  if (outputJson) {
    for (const e of entries) console.log(JSON.stringify(e));
  } else {
    for (const e of entries) {
      const sb = e.machine ? ` [${e.machine}]` : "";
      const actor = e.actor ? ` by ${e.actor}` : "";
      console.log(`${e.timestamp}  ${e.event}${sb}${actor}`);
      if (e.details && !positional.includes("--brief")) {
        for (const [k, v] of Object.entries(e.details)) {
          const val = typeof v === "string" ? v : JSON.stringify(v);
          if (val.length < 200) console.log(`  ${k}: ${val}`);
        }
      }
    }
    console.log(`\n(${entries.length} event${entries.length !== 1 ? "s" : ""})`);
  }
}

// ---------------------------------------------------------------------------
// NDJSON status streaming
// ---------------------------------------------------------------------------

interface StatusEvent {
  status: "queued" | "preparing" | "running" | "completed" | "failed";
  timestamp: string;
  machine: string;
  details?: Record<string, unknown>;
  error?: string;
}

function emitStatus(event: StatusEvent): void {
  Deno.stderr.writeSync(new TextEncoder().encode(JSON.stringify(event) + "\n"));
}

// ---------------------------------------------------------------------------
// Lifecycle hooks
// ---------------------------------------------------------------------------

/** Run a command inside a machine with short timeout, swallowing errors. */
async function safeExec(name: string, cmd: string[]): Promise<{ exit_code: number; stdout: string; stderr: string } | null> {
  try {
    const resp = await apiCall("POST", `/machines/${name}/exec`, { command: cmd, timeoutSecs: 5 }, 10_000);
    if (!resp.ok) return null;
    return await resp.json();
  } catch { return null; }
}

/** Check for uncommitted work / running processes before teardown. */
async function preStopCheck(name: string): Promise<{ safe: boolean; warnings: string[] }> {
  const warnings: string[] = [];

  // Check for uncommitted git changes (try /storage/workspace first, fall back to /workspace)
  const git = await safeExec(name, ["sh", "-c", "cd /storage/workspace && git status --porcelain 2>/dev/null || cd /workspace && git status --porcelain 2>/dev/null"]);
  if (git && git.stdout.trim()) {
    warnings.push(`Uncommitted git changes in workspace:\n${git.stdout.trim()}`);
  }

  // Check for running user processes (exclude system)
  const ps = await safeExec(name, ["sh", "-c", "ps -eo pid,comm 2>/dev/null | grep -v -E '(PID|init|sh|ps|grep)'"]);
  if (ps && ps.stdout.trim()) {
    warnings.push(`Running processes:\n${ps.stdout.trim()}`);
  }

  return { safe: warnings.length === 0, warnings };
}

// ---------------------------------------------------------------------------
// Code signing (HMAC-SHA256)
// ---------------------------------------------------------------------------

const KEYS_DIR = `${SMOLVM_HOME}/keys`;
const TRUSTED_DIR = `${KEYS_DIR}/trusted`;

interface SignatureFile {
  hash: string;
  signature: string;
  timestamp: string;
  signer: string;
}

/** Load the signing key from ~/.smolvm/keys/signing.key */
async function loadSigningKey(): Promise<CryptoKey> {
  let raw: Uint8Array;
  try {
    raw = await Deno.readFile(`${KEYS_DIR}/signing.key`);
  } catch {
    die("No signing key found. Run 'smolctl sign generate' first.");
  }
  return crypto.subtle.importKey(
    "raw",
    raw.slice().buffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

/** Compute SHA-256 hex digest of a Uint8Array */
async function sha256hex(data: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", data.slice().buffer);
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Compute HMAC-SHA256 hex signature */
async function hmacSign(key: CryptoKey, data: Uint8Array): Promise<string> {
  const sig = await crypto.subtle.sign("HMAC", key, data.slice().buffer);
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Verify HMAC-SHA256 signature */
async function hmacVerify(key: CryptoKey, data: Uint8Array, signatureHex: string): Promise<boolean> {
  const sigBytes = new Uint8Array(signatureHex.match(/.{2}/g)!.map((b) => parseInt(b, 16)));
  return crypto.subtle.verify("HMAC", key, sigBytes.slice().buffer, data.slice().buffer);
}

/** Get key ID: first 8 chars of SHA-256 of the key material */
async function getKeyId(): Promise<string> {
  const raw = await Deno.readFile(`${KEYS_DIR}/signing.key`);
  const hash = await sha256hex(raw);
  return hash.slice(0, 8);
}

/** Hash a single file */
async function hashFile(path: string): Promise<string> {
  const data = await Deno.readFile(path);
  return sha256hex(data);
}

/** Hash a directory: sorted manifest of relative-path:sha256 pairs */
async function hashDirectory(dirPath: string): Promise<string> {
  const entries: string[] = [];
  async function walk(dir: string, prefix: string) {
    const items: Deno.DirEntry[] = [];
    for await (const entry of Deno.readDir(dir)) {
      items.push(entry);
    }
    items.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of items) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = `${dir}/${entry.name}`;
      if (entry.isDirectory) {
        await walk(full, rel);
      } else if (entry.isFile && !entry.name.endsWith(".sig")) {
        const h = await hashFile(full);
        entries.push(`${rel}:${h}`);
      }
    }
  }
  await walk(dirPath, "");
  const manifest = entries.join("\n");
  return sha256hex(new TextEncoder().encode(manifest));
}

/** Generate an HMAC-SHA256 signing keypair (shared secret) */
async function cmdSignGenerate() {
  await Deno.mkdir(KEYS_DIR, { recursive: true });

  const keyPath = `${KEYS_DIR}/signing.key`;
  const pubPath = `${KEYS_DIR}/signing.pub`;

  // Generate 32 random bytes as the HMAC key
  const keyBytes = crypto.getRandomValues(new Uint8Array(32));
  await Deno.writeFile(keyPath, keyBytes);

  // Set restrictive permissions on the private key
  try {
    const proc = new Deno.Command("chmod", { args: ["0600", keyPath] }).spawn();
    await proc.output();
  } catch { /* Windows: skip chmod */ }

  // The "public key" is the SHA-256 hash of the key (for identification, not verification)
  const keyId = await sha256hex(keyBytes);
  await Deno.writeTextFile(pubPath, keyId + "\n");

  console.log(`Signing key generated.`);
  console.log(`  Private key: ${keyPath}`);
  console.log(`  Public ID:   ${pubPath}`);
  console.log(`  Key ID:      ${keyId.slice(0, 8)}`);
  console.log(`\nNote: HMAC-SHA256 uses a shared secret. Share the key file`);
  console.log(`(not the pub ID) with parties who need to verify signatures.`);
}

/** Sign a file or directory */
async function cmdSignFile(targetPath: string) {
  const key = await loadSigningKey();
  const keyId = await getKeyId();

  let resolvedPath: string;
  try {
    resolvedPath = Deno.realPathSync(targetPath);
  } catch {
    die(`path not found: ${targetPath}`);
  }

  const stat = await Deno.stat(resolvedPath);
  const contentHash = stat.isDirectory
    ? await hashDirectory(resolvedPath)
    : await hashFile(resolvedPath);

  const hashBytes = new TextEncoder().encode(contentHash);
  const signature = await hmacSign(key, hashBytes);

  const sigData: SignatureFile = {
    hash: contentHash,
    signature,
    timestamp: new Date().toISOString(),
    signer: keyId,
  };

  const sigPath = `${resolvedPath}.sig`;
  await Deno.writeTextFile(sigPath, JSON.stringify(sigData, null, 2) + "\n");
  console.log(`Signed: ${resolvedPath}`);
  console.log(`  Hash:      ${contentHash}`);
  console.log(`  Signature: ${sigPath}`);
  console.log(`  Signer:    ${keyId}`);
}

/** Verify a signature file */
async function cmdSignVerify(targetPath: string): Promise<boolean> {
  const key = await loadSigningKey();

  let resolvedPath: string;
  try {
    resolvedPath = Deno.realPathSync(targetPath);
  } catch {
    die(`path not found: ${targetPath}`);
  }

  const sigPath = `${resolvedPath}.sig`;
  let sigText: string;
  try {
    sigText = await Deno.readTextFile(sigPath);
  } catch {
    console.error(`FAIL: no signature file found at ${sigPath}`);
    return false;
  }

  const sigData = JSON.parse(sigText) as SignatureFile;

  // Recompute hash
  const stat = await Deno.stat(resolvedPath);
  const currentHash = stat.isDirectory
    ? await hashDirectory(resolvedPath)
    : await hashFile(resolvedPath);

  if (currentHash !== sigData.hash) {
    console.error(`FAIL: content has changed since signing.`);
    console.error(`  Expected hash: ${sigData.hash}`);
    console.error(`  Current hash:  ${currentHash}`);
    return false;
  }

  // Verify HMAC
  const hashBytes = new TextEncoder().encode(currentHash);
  const valid = await hmacVerify(key, hashBytes, sigData.signature);

  if (valid) {
    console.log(`PASS: signature verified.`);
    console.log(`  Hash:      ${sigData.hash}`);
    console.log(`  Signer:    ${sigData.signer}`);
    console.log(`  Signed at: ${sigData.timestamp}`);
    return true;
  } else {
    console.error(`FAIL: HMAC signature does not match.`);
    console.error(`  Signer claimed: ${sigData.signer}`);
    return false;
  }
}

/** Add a trusted key */
async function cmdSignTrust(keyPathOrValue: string) {
  await Deno.mkdir(TRUSTED_DIR, { recursive: true });

  let keyContent: string;
  try {
    // Try reading as a file first
    keyContent = (await Deno.readTextFile(keyPathOrValue)).trim();
  } catch {
    // Treat as a raw key value
    keyContent = keyPathOrValue.trim();
  }

  const keyId = (await sha256hex(new TextEncoder().encode(keyContent))).slice(0, 8);
  const outPath = `${TRUSTED_DIR}/${keyId}.pub`;
  await Deno.writeTextFile(outPath, keyContent + "\n");
  console.log(`Trusted key added: ${outPath}`);
  console.log(`  Key ID: ${keyId}`);
}

/** Verify signature for sync push --verify */
async function verifySyncSignature(localDir: string): Promise<{ valid: boolean; sigData?: SignatureFile }> {
  const sigPath = `${localDir}.sig`;
  let sigText: string;
  try {
    sigText = await Deno.readTextFile(sigPath);
  } catch {
    return { valid: false };
  }

  const sigData = JSON.parse(sigText) as SignatureFile;
  const key = await loadSigningKey();

  // Recompute directory hash
  const currentHash = await hashDirectory(localDir);
  if (currentHash !== sigData.hash) return { valid: false, sigData };

  const hashBytes = new TextEncoder().encode(currentHash);
  const valid = await hmacVerify(key, hashBytes, sigData.signature);
  return { valid, sigData };
}

// ---------------------------------------------------------------------------
// Flag parsing
// ---------------------------------------------------------------------------

/** Parse --key value pairs from args array. Returns map + remaining positional args. */
function parseFlags(args: string[], known: string[]): { flags: Record<string, string[]>; positional: string[] } {
  const flags: Record<string, string[]> = {};
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      if (known.includes(key)) {
        // Boolean flags (no value)
        if (key === "force" || key === "no-network" || key === "no-follow" || key === "dry-run" || key === "keep" || key === "json" || key === "status" || key === "verify" || key === "signed-only" || key === "ngrok" || key === "auth" || key === "pool" || key === "with-mcp" || key === "incremental" || key === "recursive") {
          flags[key] = (flags[key] ?? []).concat("true");
        } else if (args[i + 1]) {
          flags[key] = (flags[key] ?? []).concat(args[++i]);
        }
      } else {
        positional.push(arg);
      }
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}

function flag(flags: Record<string, string[]>, key: string): string | undefined {
  return flags[key]?.[0];
}
function flagAll(flags: Record<string, string[]>, key: string): string[] {
  return flags[key] ?? [];
}
function hasFlag(flags: Record<string, string[]>, key: string): boolean {
  return key in flags;
}

// ---------------------------------------------------------------------------
// Machine commands
// ---------------------------------------------------------------------------

async function cmdHealth() {
  const resp = await fetch(`${BASE_URL}/health`, {
    headers: authHeaders(),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const data = await jsonResult<Record<string, unknown>>(resp);
  console.log(`Server: ${BASE_URL}`);
  for (const [k, v] of Object.entries(data)) {
    console.log(`  ${k}: ${v}`);
  }
}

async function cmdList() {
  const resp = await apiCall("GET", "/machines");
  const data = await jsonResult<{ machines: Record<string, unknown>[] }>(resp);
  const rows = data.machines.map((s) => ({
    name: s.name,
    state: s.state,
    pid: s.pid ?? "-",
    network: (s as Record<string, unknown>).network ?? "-",
  }));
  table(rows, ["name", "state", "pid", "network"]);
}

async function cmdCreate(name: string, args: string[]) {
  const { flags } = parseFlags(args, ["cpus", "memory", "no-network", "init", "user", "starter", "secret", "label", "owner", "description", "setup", "allowed-domains", "allow-cidr", "allow-host", "mcp", "with-mcp", "pool", "node"]);
  const resources: Record<string, unknown> = {
    cpus: parseInt(flag(flags, "cpus") ?? "2"),
    memoryMb: parseInt(flag(flags, "memory") ?? "1024"),
    network: !hasFlag(flags, "no-network"),
  };
  // Parse allowed domains (comma-separated or repeated flags)
  const allowedDomainsRaw = flagAll(flags, "allowed-domains");
  const allowedDomains = allowedDomainsRaw.flatMap((d: string) => d.split(",").map((s: string) => s.trim()).filter(Boolean));
  if (allowedDomains.length > 0) {
    resources.allowedDomains = allowedDomains;
  }
  // Parse --allow-cidr (CIDR-based egress filtering, implies network)
  const allowedCidrsRaw = flagAll(flags, "allow-cidr");
  const allowedCidrs = allowedCidrsRaw.flatMap((c: string) => c.split(",").map((s: string) => s.trim()).filter(Boolean));
  if (allowedCidrs.length > 0) {
    resources.allowedCidrs = allowedCidrs;
    resources.network = true;
  }
  // Parse --allow-host (resolve hostnames to CIDRs via DNS)
  const allowedHostsRaw = flagAll(flags, "allow-host");
  const allowedHosts = allowedHostsRaw.flatMap((h: string) => h.split(",").map((s: string) => s.trim()).filter(Boolean));
  if (allowedHosts.length > 0) {
    // Resolve hostnames to IP addresses and add as CIDRs
    const resolvedCidrs: string[] = resources.allowedCidrs as string[] ?? [];
    for (const host of allowedHosts) {
      try {
        const ips = await Deno.resolveDns(host, "A");
        for (const ip of ips) resolvedCidrs.push(`${ip}/32`);
        const ips6 = await Deno.resolveDns(host, "AAAA").catch(() => [] as string[]);
        for (const ip of ips6) resolvedCidrs.push(`${ip}/128`);
      } catch {
        console.error(`warning: could not resolve ${host}, skipping`);
      }
    }
    if (resolvedCidrs.length > 0) {
      resources.allowedCidrs = resolvedCidrs;
      resources.network = true;
    }
  }
  const opts: Record<string, unknown> = { name, resources };
  const initCmds = flagAll(flags, "init");
  if (initCmds.length > 0) opts.init_commands = initCmds;
  if (flag(flags, "user")) opts.default_user = flag(flags, "user");
  if (flag(flags, "starter")) opts.from_starter = flag(flags, "starter");
  const secrets = flagAll(flags, "secret");
  if (secrets.length > 0) opts.secrets = secrets;
  // Parse --mcp "name=fs,cmd=npx -y @mcp/server /workspace" flags
  const mcpSpecs = flagAll(flags, "mcp");
  if (mcpSpecs.length > 0) {
    const mcpServers: Array<{ name: string; command: string[]; env?: Array<{ name: string; value: string }>; workdir?: string }> = [];
    for (const spec of mcpSpecs) {
      const parts: Record<string, string> = {};
      for (const kv of spec.split(",")) {
        const eq = kv.indexOf("=");
        if (eq > 0) parts[kv.slice(0, eq).trim()] = kv.slice(eq + 1).trim();
      }
      if (!parts.name || !parts.cmd) {
        die(`invalid --mcp format '${spec}': expected 'name=<name>,cmd=<command>'`);
      }
      mcpServers.push({
        name: parts.name,
        command: parts.cmd.split(/\s+/),
        workdir: parts.workdir,
      });
    }
    opts.mcp_servers = mcpServers;
  }

  // --with-mcp: auto-configure built-in MCP servers (filesystem, exec, git)
  if (hasFlag(flags, "with-mcp")) {
    const builtinMcp = [
      {
        name: "filesystem",
        command: ["sh", "/opt/smolvm/mcp-servers/filesystem.sh"],
        env: [],
      },
      {
        name: "exec",
        command: ["sh", "/opt/smolvm/mcp-servers/exec.sh"],
        env: [],
      },
      {
        name: "git",
        command: ["sh", "/opt/smolvm/mcp-servers/git.sh"],
        env: [],
      },
    ];
    // Merge with any explicit --mcp servers (explicit ones take precedence by being first)
    const existing = (opts.mcp_servers as Array<{ name: string }>) ?? [];
    const existingNames = new Set(existing.map((s) => s.name));
    const toAdd = builtinMcp.filter((s) => !existingNames.has(s.name));
    opts.mcp_servers = [...existing, ...toAdd];
    console.log(`Built-in MCP servers enabled: ${toAdd.map((s) => s.name).join(", ")}`);
  }

  // Pool-aware routing: pick a node if --pool is set
  let targetNode: PoolNode | undefined;
  if (hasFlag(flags, "pool")) {
    const pool = await loadPoolConfig();
    targetNode = await pickNode(pool, flag(flags, "node"));
    console.log(`Routing to node '${targetNode.name}' (${targetNode.url})`);
  } else if (flag(flags, "node")) {
    // --node without --pool: look up the node directly
    const pool = await loadPoolConfig();
    const nodeName = flag(flags, "node")!;
    const node = pool.nodes.find((n) => n.name === nodeName);
    if (!node) die(`node '${nodeName}' not found in pool. Run 'smolctl pool ls' to see available nodes.`);
    targetNode = node;
    console.log(`Routing to node '${targetNode.name}' (${targetNode.url})`);
  }

  const t0 = Date.now();
  const resp = targetNode
    ? await nodeApiCall(targetNode, "POST", "/machines", opts, LONG_TIMEOUT_MS)
    : await apiCall("POST", "/machines", opts, LONG_TIMEOUT_MS);
  const data = await jsonResult<Record<string, unknown>>(resp);
  console.log(`Created machine: ${data.name} (${data.state})`);
  if (allowedDomains.length > 0) {
    console.log(`DNS egress filtering enabled for: ${allowedDomains.join(", ")}`);
  }

  // Save local metadata (with node assignment if pool-routed)
  await saveMeta({
    name,
    owner: flag(flags, "owner") ?? Deno.env.get("USER") ?? "unknown",
    labels: parseLabels(flags),
    description: flag(flags, "description"),
    created_at: new Date().toISOString(),
    starter: flag(flags, "starter"),
    secrets: secrets.length > 0 ? secrets : undefined,
    node: targetNode?.name,
  });

  // Record session + event log
  const now = new Date().toISOString();
  await recordSession({ timestamp: now, machine: name, action: "create", duration_ms: Date.now() - t0 });
  await logEvent({ timestamp: now, event: "machine.create", machine: name, actor: flag(flags, "owner") ?? Deno.env.get("USER"), details: { starter: flag(flags, "starter"), secrets: secrets.length > 0 ? secrets : undefined, node: targetNode?.name } });
}

/** API call that auto-routes to the correct pool node for a machine. */
async function machineApiCall(
  name: string,
  method: string,
  path: string,
  body?: unknown,
  timeout = TIMEOUT_MS,
): Promise<Response> {
  const node = await resolveNodeForMachine(name);
  if (node) return nodeApiCall(node, method, path, body, timeout);
  return apiCall(method, path, body, timeout);
}

async function cmdStart(name: string) {
  const resp = await machineApiCall(name, "POST", `/machines/${name}/start`);
  const data = await jsonResult<Record<string, unknown>>(resp);
  console.log(`Started: ${data.name} (pid: ${data.pid ?? "?"})`);
  await logEvent({ timestamp: new Date().toISOString(), event: "machine.start", machine: name });
}

async function cmdStop(name: string) {
  const resp = await machineApiCall(name, "POST", `/machines/${name}/stop`);
  const data = await jsonResult<Record<string, unknown>>(resp);
  console.log(`Stopped: ${data.name}`);
  await logEvent({ timestamp: new Date().toISOString(), event: "machine.stop", machine: name });
}

async function cmdDelete(name: string, force: boolean) {
  const qs = force ? "?force=true" : "";
  const resp = await machineApiCall(name, "DELETE", `/machines/${name}${qs}`);
  await okOrDie(resp, "delete");
  console.log(`Deleted: ${name}`);
  await logEvent({ timestamp: new Date().toISOString(), event: "machine.delete", machine: name, details: { force } });
}

async function cmdInfo(name: string) {
  const resp = await machineApiCall(name, "GET", `/machines/${name}`);
  const data = await jsonResult<Record<string, unknown>>(resp);
  console.log(JSON.stringify(data, null, 2));
}

async function cmdExec(name: string, command: string[], args: string[]) {
  const { flags } = parseFlags(args, ["env", "workdir", "user", "timeout", "signed-only"]);

  // Check signature verification if --signed-only
  if (hasFlag(flags, "signed-only")) {
    const meta = await loadMeta(name);
    if (!meta?.signature_verified) {
      die(`Machine '${name}' does not have verified signed content.\n` +
        `  Push signed content with 'smolctl sync push ${name} <dir> --verify' first.`);
    }
    console.log(`[signed-only] Content verified (signer: ${meta.signature_key_id}, signed: ${meta.signature_timestamp})`);
  }

  const body: Record<string, unknown> = {
    command,
    timeoutSecs: parseInt(flag(flags, "timeout") ?? "30"),
  };
  const envPairs = flagAll(flags, "env").map((e) => {
    const [n, ...v] = e.split("=");
    return { name: n, value: v.join("=") };
  });
  if (envPairs.length > 0) body.env = envPairs;
  if (flag(flags, "workdir")) body.workdir = flag(flags, "workdir");
  if (flag(flags, "user")) body.user = flag(flags, "user");

  const t0 = Date.now();
  const clientTimeout = (parseInt(flag(flags, "timeout") ?? "30") + 5) * 1000;
  const resp = await machineApiCall(name, "POST", `/machines/${name}/exec`, body, clientTimeout);
  const data = await jsonResult<{ exitCode?: number; exit_code?: number; stdout: string; stderr: string }>(resp);
  const code = data.exit_code ?? data.exitCode ?? -1;
  if (data.stdout) Deno.stdout.writeSync(new TextEncoder().encode(data.stdout));
  if (data.stderr) Deno.stderr.writeSync(new TextEncoder().encode(data.stderr));
  await recordSession({ timestamp: new Date().toISOString(), machine: name, action: "exec", duration_ms: Date.now() - t0, details: { command, exit_code: code } });
  if (code !== 0) Deno.exit(code);
}

async function cmdSh(name: string, cmd: string, args: string[]) {
  await cmdExec(name, ["sh", "-c", cmd], args);
}

async function cmdUp(name: string, args: string[]) {
  const { flags } = parseFlags(args, ["setup", "with-mcp"]);
  // Pass all args through to create (it parses its own flags)
  await cmdCreate(name, args);
  await cmdStart(name);
  await recordSession({ timestamp: new Date().toISOString(), machine: name, action: "start" });

  // Auto-install MCP server scripts into the machine when --with-mcp is used
  if (hasFlag(flags, "with-mcp")) {
    console.log("Installing built-in MCP servers...");
    await cmdMcpInstall(name);
  }

  // Post-start setup hooks
  const setupCmds = flagAll(flags, "setup");
  for (const cmd of setupCmds) {
    console.log(`[setup] ${cmd}`);
    const resp = await apiCall("POST", `/machines/${name}/exec`, {
      command: ["sh", "-c", cmd],
      timeoutSecs: 120,
    }, 130_000);
    const data = await jsonResult<{ exit_code?: number; exitCode?: number; stdout: string; stderr: string }>(resp);
    const code = data.exit_code ?? data.exitCode ?? -1;
    if (data.stdout) Deno.stdout.writeSync(new TextEncoder().encode(data.stdout));
    if (data.stderr) Deno.stderr.writeSync(new TextEncoder().encode(data.stderr));
    if (code !== 0) die(`Setup command failed (exit ${code}): ${cmd}`);
  }

  console.log(`Machine ${name} is up and running.`);
}

async function cmdDown(name: string, force = false) {
  if (!force) {
    const check = await preStopCheck(name);
    if (!check.safe) {
      console.warn("Pre-stop warnings:");
      for (const w of check.warnings) console.warn(`  ${w}`);
      console.warn("\nUse 'smolctl down <name> --force' to override.");
      Deno.exit(1);
    }
  }
  try { await cmdStop(name); } catch { /* already stopped */ }
  await cmdDelete(name, false);
  await deleteMeta(name);
  await recordSession({ timestamp: new Date().toISOString(), machine: name, action: "down" });
}

/**
 * Resume a machine from cached metadata.
 * Re-creates the machine with the same configuration (starter, secrets, labels, resources)
 * and optionally restores the session log.
 */
async function cmdResume(name: string, args: string[]) {
  const { flags } = parseFlags(args, ["setup"]);
  const ts = () => new Date().toISOString();

  // Load saved metadata
  const meta = await loadMeta(name);
  if (!meta) die(`No cached metadata for machine: ${name}. Cannot resume.`);

  // Check if machine already exists on the server
  try {
    const resp = await apiCall("GET", `/machines/${name}`);
    if (resp.ok) {
      const data = await resp.json();
      if (data.state === "running") {
        console.log(`Machine ${name} is already running. Reconnecting.`);
        await recordSession({ timestamp: ts(), machine: name, action: "resume", details: { mode: "reconnect" } });
        return;
      }
      if (data.state === "stopped") {
        console.log(`Machine ${name} exists but is stopped. Restarting.`);
        await cmdStart(name);
        await recordSession({ timestamp: ts(), machine: name, action: "resume", details: { mode: "restart" } });
        return;
      }
    }
  } catch { /* machine doesn't exist on server, will re-create */ }

  // Re-create from metadata
  console.log(`Resuming machine: ${name} (starter: ${meta.starter ?? "default"})`);
  const createOpts: Record<string, unknown> = {
    name,
    resources: {
      cpus: 2,
      memoryMb: 1024,
      network: true,
    },
  };
  if (meta.starter) createOpts.from_starter = meta.starter;
  if (meta.secrets && meta.secrets.length > 0) createOpts.secrets = meta.secrets;

  const createResp = await apiCall("POST", "/machines", createOpts, LONG_TIMEOUT_MS);
  await jsonResult<Record<string, unknown>>(createResp);

  await cmdStart(name);

  // Update metadata with resumed timestamp
  meta.created_at = ts();
  await saveMeta(meta);

  // Post-start setup hooks
  for (const cmd of flagAll(flags, "setup")) {
    console.log(`[setup] ${cmd}`);
    const resp = await apiCall("POST", `/machines/${name}/exec`, {
      command: ["sh", "-c", cmd], timeoutSecs: 120,
    }, 130_000);
    const data = await jsonResult<{ exit_code?: number; exitCode?: number }>(resp);
    if ((data.exit_code ?? data.exitCode ?? -1) !== 0) die(`Setup command failed: ${cmd}`);
  }

  await recordSession({ timestamp: ts(), machine: name, action: "resume", details: { mode: "recreate", starter: meta.starter, secrets: meta.secrets } });
  console.log(`Machine ${name} resumed.`);
}

async function cmdPrune() {
  const resp = await apiCall("GET", "/machines");
  const data = await jsonResult<{ machines: { name: string; state: string }[] }>(resp);
  if (data.machines.length === 0) {
    console.log("No machines to prune.");
    return;
  }
  for (const sb of data.machines) {
    try {
      if (sb.state === "running") await apiCall("POST", `/machines/${sb.name}/stop`);
    } catch { /* ignore */ }
    try {
      await apiCall("DELETE", `/machines/${sb.name}?force=true`);
      console.log(`  pruned: ${sb.name}`);
    } catch (e) {
      console.error(`  failed: ${sb.name} — ${e}`);
    }
  }
  console.log(`Pruned ${data.machines.length} machine(es).`);
}

async function cmdStats(name: string) {
  const resp = await machineApiCall(name, "GET", `/machines/${name}/stats`);
  const data = await jsonResult<Record<string, unknown>>(resp);
  console.log(`Machine: ${data.name} (${data.state})`);
  console.log(`  CPUs:     ${data.cpus}`);
  console.log(`  Memory:   ${data.memoryMb} MB`);
  console.log(`  Network:  ${data.network}`);
  if (data.pid) console.log(`  PID:      ${data.pid}`);
  const overlay = data.overlay_disk as Record<string, unknown> | undefined;
  if (overlay) {
    console.log(`  Overlay:  ${(overlay.apparent_size_gb as number).toFixed(2)} GB (${overlay.path})`);
  }
  const storage = data.storage_disk as Record<string, unknown> | undefined;
  if (storage) {
    console.log(`  Storage:  ${(storage.apparent_size_gb as number).toFixed(2)} GB (${storage.path})`);
  }
}

async function cmdStarters() {
  const resp = await apiCall("GET", "/starters");
  const data = await jsonResult<{ starters: Record<string, unknown>[] }>(resp);
  if (data.starters.length === 0) {
    console.log("No starters available.");
    return;
  }
  const rows = data.starters.map((s) => ({
    name: s.name,
    description: s.description ?? "-",
    image: s.image ?? "-",
    tags: Array.isArray(s.tags) ? (s.tags as string[]).join(", ") : "-",
  }));
  table(rows, ["name", "description", "image", "tags"]);
}

// ---------------------------------------------------------------------------
// Starter authoring commands
// ---------------------------------------------------------------------------

const STARTERS_DIR = `${SMOLVM_HOME}/starters`;

interface StarterMeta {
  name: string;
  version: string;
  description: string;
  base_image: string;
  tags: string[];
  author?: string;
  init_commands?: string[];
  env?: Record<string, string>;
  mcp_servers?: Array<{ name: string; command: string[] }>;
}

function starterDockerfile(name: string, description: string, baseImage: string): string {
  return `# smolvm starter: ${name}
# ${description}

FROM ${baseImage}

# Install common tools
RUN apt-get update && apt-get install -y \\
    curl git vim \\
    && rm -rf /var/lib/apt/lists/*

# Custom setup
# Add your packages and configuration here

# Set working directory
WORKDIR /workspace

# Default command
CMD ["/bin/bash"]
`;
}

function starterReadme(meta: StarterMeta): string {
  const tagsList = meta.tags.map((t: string) => `- ${t}`).join("\n");
  return [
    `# ${meta.name}`,
    "",
    meta.description,
    "",
    "## Base Image",
    "",
    "`" + meta.base_image + "`",
    "",
    "## Tags",
    "",
    tagsList,
    "",
    "## Usage",
    "",
    "```bash",
    "# Build the starter image",
    `smolctl starter build ${meta.name}`,
    "",
    "# Create a machine using this starter",
    `smolctl up my-machine --starter ${meta.name}`,
    "```",
    "",
    "## Customization",
    "",
    "Edit the `Dockerfile` to add your packages and configuration.",
    "Edit `starter.json` to update metadata, init commands, and environment variables.",
    "",
  ].join("\n");
}

async function cmdStarterInit(name: string, args: string[]) {
  if (!name) die("usage: smolctl starter init <name>");

  const { flags } = parseFlags(args, ["base-image", "description", "tag", "author"]);

  const baseImage = flag(flags, "base-image") ?? "ubuntu:22.04";
  const description = flag(flags, "description") ?? `Custom ${name} development environment`;
  const tags = flagAll(flags, "tag");
  const author = flag(flags, "author") ?? Deno.env.get("USER") ?? "user";

  const dir = `${STARTERS_DIR}/${name}`;

  // Check if already exists
  try {
    await Deno.stat(dir);
    die(`starter "${name}" already exists at ${dir}`);
  } catch {
    // Good - doesn't exist yet
  }

  await Deno.mkdir(dir, { recursive: true });

  const meta: StarterMeta = {
    name,
    version: "1.0.0",
    description,
    base_image: baseImage,
    tags: tags.length > 0 ? tags : ["custom"],
    author,
    init_commands: [],
    env: {},
    mcp_servers: [],
  };

  await Deno.writeTextFile(`${dir}/starter.json`, JSON.stringify(meta, null, 2) + "\n");
  await Deno.writeTextFile(`${dir}/Dockerfile`, starterDockerfile(name, description, baseImage));
  await Deno.writeTextFile(`${dir}/README.md`, starterReadme(meta));

  console.log(`Starter "${name}" created at ${dir}`);
  console.log(`  Dockerfile:    ${dir}/Dockerfile`);
  console.log(`  Metadata:      ${dir}/starter.json`);
  console.log(`  README:        ${dir}/README.md`);
  console.log(`\nNext steps:`);
  console.log(`  1. Edit ${dir}/Dockerfile to customize your environment`);
  console.log(`  2. Run: smolctl starter build ${name}`);
}

async function cmdStarterLs() {
  const rows: { name: string; description: string; base_image: string; tags: string; source: string }[] = [];

  // List built-in starters from API (best-effort)
  try {
    const resp = await apiCall("GET", "/starters");
    if (resp.ok) {
      const data = await resp.json() as { starters: Record<string, unknown>[] };
      for (const s of data.starters) {
        rows.push({
          name: String(s.name ?? ""),
          description: String(s.description ?? "-"),
          base_image: String(s.image ?? "-"),
          tags: Array.isArray(s.tags) ? (s.tags as string[]).join(", ") : "-",
          source: "built-in",
        });
      }
    }
  } catch {
    // API not available
  }

  // List custom starters from ~/.smolvm/starters/
  try {
    for await (const entry of Deno.readDir(STARTERS_DIR)) {
      if (!entry.isDirectory) continue;
      try {
        const text = await Deno.readTextFile(`${STARTERS_DIR}/${entry.name}/starter.json`);
        const meta = JSON.parse(text) as StarterMeta;
        rows.push({
          name: meta.name,
          description: meta.description || "-",
          base_image: meta.base_image || "-",
          tags: meta.tags?.join(", ") ?? "-",
          source: "custom",
        });
      } catch {
        rows.push({
          name: entry.name,
          description: "-",
          base_image: "-",
          tags: "-",
          source: "custom",
        });
      }
    }
  } catch {
    // Directory doesn't exist
  }

  if (rows.length === 0) {
    console.log("No starters found. Create one with: smolctl starter init <name>");
    return;
  }
  table(rows, ["name", "description", "base_image", "tags", "source"]);
}

async function cmdStarterBuild(name: string) {
  if (!name) die("usage: smolctl starter build <name>");

  const dir = `${STARTERS_DIR}/${name}`;
  try {
    await Deno.stat(`${dir}/Dockerfile`);
  } catch {
    die(`starter "${name}" not found at ${dir} or missing Dockerfile`);
  }

  const tag = `smolvm-starter-${name}:latest`;
  console.log(`Building starter "${name}" -> ${tag} ...`);

  const cmd = new Deno.Command("docker", {
    args: ["build", "-t", tag, dir],
    stdout: "inherit",
    stderr: "inherit",
  });
  const result = await cmd.output();

  if (!result.success) {
    die(`docker build failed with exit code ${result.code}`);
  }

  console.log(`\nStarter "${name}" built successfully as ${tag}`);
}

async function cmdStarterValidate(name: string) {
  if (!name) die("usage: smolctl starter validate <name>");

  const dir = `${STARTERS_DIR}/${name}`;
  let errors = 0;
  let warnings = 0;

  // Check directory exists
  try {
    await Deno.stat(dir);
  } catch {
    die(`starter "${name}" not found at ${dir}`);
  }

  // Check Dockerfile
  try {
    const dockerfile = await Deno.readTextFile(`${dir}/Dockerfile`);
    if (!dockerfile.includes("FROM")) {
      console.error(`  FAIL: Dockerfile missing FROM instruction`);
      errors++;
    } else {
      console.log(`  OK: Dockerfile exists and has FROM instruction`);
    }
  } catch {
    console.error(`  FAIL: Dockerfile not found`);
    errors++;
  }

  // Check starter.json
  try {
    const text = await Deno.readTextFile(`${dir}/starter.json`);
    const meta = JSON.parse(text) as StarterMeta;

    const required: (keyof StarterMeta)[] = ["name", "version", "description", "base_image", "tags"];
    for (const field of required) {
      if (!meta[field]) {
        console.error(`  FAIL: starter.json missing required field "${field}"`);
        errors++;
      }
    }
    if (meta.name && meta.version && meta.description && meta.base_image && meta.tags) {
      console.log(`  OK: starter.json has all required fields`);
    }

    if (!meta.author) {
      console.log(`  WARN: starter.json missing optional "author" field`);
      warnings++;
    }
  } catch (e) {
    if (e instanceof SyntaxError) {
      console.error(`  FAIL: starter.json is not valid JSON`);
    } else {
      console.error(`  FAIL: starter.json not found`);
    }
    errors++;
  }

  // Check README
  try {
    await Deno.stat(`${dir}/README.md`);
    console.log(`  OK: README.md exists`);
  } catch {
    console.log(`  WARN: README.md not found`);
    warnings++;
  }

  console.log(`\nValidation: ${errors} errors, ${warnings} warnings`);
  if (errors > 0) {
    Deno.exit(1);
  }
}

async function cmdStarterExport(name: string, outputPath?: string) {
  if (!name) die("usage: smolctl starter export <name> [path]");

  const dir = `${STARTERS_DIR}/${name}`;
  try {
    await Deno.stat(dir);
  } catch {
    die(`starter "${name}" not found at ${dir}`);
  }

  let tarball = outputPath ?? `${name}.tar.gz`;
  // If outputPath is a directory, append the filename
  try {
    const stat = await Deno.stat(tarball);
    if (stat.isDirectory) tarball = `${tarball.replace(/\/$/, "")}/${name}.tar.gz`;
  } catch { /* path doesn't exist yet, use as-is */ }
  console.log(`Exporting starter "${name}" -> ${tarball} ...`);

  const cmd = new Deno.Command("tar", {
    args: ["-czf", tarball, "-C", STARTERS_DIR, name],
    stdout: "inherit",
    stderr: "inherit",
  });
  const result = await cmd.output();

  if (!result.success) {
    die(`tar export failed with exit code ${result.code}`);
  }

  console.log(`Exported: ${tarball}`);
}

async function cmdStarterImport(tarPath: string) {
  if (!tarPath) die("usage: smolctl starter import <path>");

  try {
    await Deno.stat(tarPath);
  } catch {
    die(`file not found: ${tarPath}`);
  }

  await Deno.mkdir(STARTERS_DIR, { recursive: true });

  console.log(`Importing starter from ${tarPath} ...`);

  const cmd = new Deno.Command("tar", {
    args: ["-xzf", tarPath, "-C", STARTERS_DIR],
    stdout: "inherit",
    stderr: "inherit",
  });
  const result = await cmd.output();

  if (!result.success) {
    die(`tar import failed with exit code ${result.code}`);
  }

  // Try to read the name from the extracted starter
  const basename = tarPath.replace(/.*\//, "").replace(/\.tar\.gz$/, "");
  try {
    const text = await Deno.readTextFile(`${STARTERS_DIR}/${basename}/starter.json`);
    const meta = JSON.parse(text) as StarterMeta;
    console.log(`Imported starter "${meta.name}" to ${STARTERS_DIR}/${basename}/`);
  } catch {
    console.log(`Imported to ${STARTERS_DIR}/ - check contents with: smolctl starter ls`);
  }
}

// ---------------------------------------------------------------------------
// Provider commands
// ---------------------------------------------------------------------------

interface ProviderConfig {
  providers: { name: string; url: string; token?: string; default?: boolean }[];
}

const PROVIDER_CONFIG_PATH = `${Deno.env.get("HOME") ?? "~"}/.smolvm/providers.json`;

async function loadProviderConfig(): Promise<ProviderConfig> {
  try {
    const text = await Deno.readTextFile(PROVIDER_CONFIG_PATH);
    return JSON.parse(text) as ProviderConfig;
  } catch {
    // Default config: just the local provider
    return {
      providers: [{ name: "local", url: "http://127.0.0.1:9090", default: true }],
    };
  }
}

async function saveProviderConfig(config: ProviderConfig): Promise<void> {
  const dir = PROVIDER_CONFIG_PATH.replace(/\/[^/]+$/, "");
  try {
    await Deno.mkdir(dir, { recursive: true });
  } catch { /* exists */ }
  await Deno.writeTextFile(PROVIDER_CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
}

async function cmdProviderInfo() {
  const resp = await apiCall("GET", "/provider");
  const data = await jsonResult<{
    name: string;
    version: string;
    capabilities: string[];
    max_machines?: number;
    region?: string;
  }>(resp);
  console.log(`Provider: ${data.name}`);
  console.log(`Version:  ${data.version}`);
  console.log(`Region:   ${data.region ?? "-"}`);
  console.log(`Max VMs:  ${data.max_machines ?? "unlimited"}`);
  console.log(`Capabilities: ${data.capabilities.join(", ")}`);
}

async function cmdProviderList() {
  const config = await loadProviderConfig();
  const rows = config.providers.map((p) => ({
    name: p.name,
    url: p.url,
    default: p.default ? "yes" : "",
    auth: p.token ? "token" : "-",
  }));
  table(rows, ["name", "url", "default", "auth"]);
}

async function cmdProviderAdd(name: string, url: string, token?: string) {
  if (!name || !url) die("usage: smolctl provider add <name> <url> [--token TOKEN]");
  const config = await loadProviderConfig();
  // Remove existing provider with the same name
  config.providers = config.providers.filter((p) => p.name !== name);
  const entry: { name: string; url: string; token?: string; default?: boolean } = { name, url };
  if (token) entry.token = token;
  // If this is the first provider, make it default
  if (config.providers.length === 0) entry.default = true;
  config.providers.push(entry);
  await saveProviderConfig(config);
  console.log(`Provider '${name}' added (${url})`);
}

async function cmdProviderUse(name: string) {
  if (!name) die("usage: smolctl provider use <name>");
  const config = await loadProviderConfig();
  const found = config.providers.find((p) => p.name === name);
  if (!found) die(`provider '${name}' not found. Run 'smolctl provider list' to see available providers.`);
  for (const p of config.providers) p.default = false;
  found.default = true;
  await saveProviderConfig(config);
  console.log(`Default provider set to '${name}' (${found.url})`);
}

async function cmdProviderRemove(name: string) {
  if (!name) die("usage: smolctl provider rm <name>");
  if (name === "local") die("cannot remove the built-in 'local' provider");
  const config = await loadProviderConfig();
  const before = config.providers.length;
  config.providers = config.providers.filter((p) => p.name !== name);
  if (config.providers.length === before) die(`provider '${name}' not found`);
  // If we removed the default, make the first one default
  if (!config.providers.some((p) => p.default) && config.providers.length > 0) {
    config.providers[0].default = true;
  }
  await saveProviderConfig(config);
  console.log(`Provider '${name}' removed`);
}

async function cmdMetrics() {
  const resp = await fetch(`${BASE_URL}/metrics`, {
    headers: authHeaders(),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!resp.ok) {
    const text = await resp.text();
    die(`metrics failed (${resp.status}): ${text}`);
  }
  const text = await resp.text();
  console.log(text);
}

async function cmdLogs(name: string, args: string[]) {
  const { flags } = parseFlags(args, ["tail", "no-follow"]);
  const tail = flag(flags, "tail") ?? "100";
  const follow = !hasFlag(flags, "no-follow");
  const qs = `?follow=${follow}&tail=${tail}`;
  const resp = await fetch(`${API}/machines/${name}/logs${qs}`, {
    headers: authHeaders(),
  });
  if (!resp.ok) {
    const text = await resp.text();
    die(`logs failed (${resp.status}): ${text}`);
  }
  if (resp.body) {
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        for (const line of chunk.split("\n")) {
          if (line.startsWith("data:")) {
            console.log(line.slice(5).trim());
          } else if (line.trim() && !line.startsWith(":") && !line.startsWith("event:")) {
            Deno.stdout.writeSync(new TextEncoder().encode(line + "\n"));
          }
        }
      }
    } catch { /* stream closed */ }
  }
}

// ---------------------------------------------------------------------------
// Clone / Diff / Merge
// ---------------------------------------------------------------------------

async function cmdClone(source: string, newName: string, args?: string[]) {
  const noBranch = args?.includes("--no-branch");
  // Flush source filesystem to ensure consistent clone (ext4 journal may have unflushed writes)
  try { await gitExec(source, "sync", 5); } catch { /* best effort */ }
  const resp = await apiCall("POST", `/machines/${source}/clone`, { name: newName });
  const data = await jsonResult<Record<string, unknown>>(resp);
  console.log(`Cloned: ${source} -> ${data.name} (${data.state})`);

  // Start the clone so we can exec
  try {
    const startResp = await apiCall("POST", `/machines/${newName}/start`);
    await jsonResult<Record<string, unknown>>(startResp);
  } catch { /* already running or can't start */ }

  // Mount per-VM storage disk (clones don't re-run init_commands)
  await ensureStorageMounted(newName);

  // Auto-create git branch if workspace has git
  if (!noBranch) {
    if (await hasGitWorkspace(newName)) {
      const ws = await getGitWs(newName);
      await gitExec(newName, `cd ${ws} && git checkout -b ${newName} 2>/dev/null || true`);
      const branch = await gitCurrentBranch(newName);
      console.log(`Git branch: ${branch}`);
    }
  }
}

async function cmdDiff(name: string, other: string) {
  const resp = await apiCall("GET", `/machines/${name}/diff/${other}`);
  const data = await jsonResult<Record<string, unknown>>(resp);
  console.log(JSON.stringify(data, null, 2));
}

async function cmdMerge(source: string, target: string) {
  const resp = await apiCall("POST", `/machines/${source}/merge/${target}`, {});
  const data = await jsonResult<Record<string, unknown>>(resp);
  console.log(JSON.stringify(data, null, 2));
}

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

async function cmdSnapshotPush(name: string, args?: string[]) {
  const { flags } = parseFlags(args ?? [], ["desc", "description", "parent", "incremental"]);
  const description = flag(flags, "desc") || flag(flags, "description") || undefined;
  const parent_snapshot = flag(flags, "parent") || undefined;
  const incremental = hasFlag(flags, "incremental") ? true : undefined;
  const body: Record<string, unknown> = {};
  if (description) body.description = description;
  if (parent_snapshot) body.parent_snapshot = parent_snapshot;
  if (incremental) body.incremental = true;
  const resp = await apiCall("POST", `/machines/${name}/push`, Object.keys(body).length ? body : undefined);
  const data = await jsonResult<{ name: string; path: string; manifest: Record<string, unknown> }>(resp);
  console.log(`Pushed snapshot: ${data.name}`);
  if (data.manifest.snapshot_version && (data.manifest.snapshot_version as number) >= 2) console.log(`  type: incremental (v${data.manifest.sequence ?? data.manifest.snapshot_version})`);
  if (data.manifest.git_branch) console.log(`  git: ${data.manifest.git_branch}@${(data.manifest.git_commit as string || "").slice(0, 8)}${data.manifest.git_dirty ? " (dirty)" : ""}`);
  if (data.manifest.sha256) console.log(`  sha256: ${data.manifest.sha256}`);
  if (data.manifest.description) console.log(`  desc: ${data.manifest.description}`);
}

async function cmdSnapshotLs(flags: string[] = []) {
  const isRemote = flags.includes("--remote");

  if (isRemote) {
    if (_providerOverride) {
      console.log(`Listing snapshots from provider: ${_providerOverride}`);
    } else {
      console.log(`Listing snapshots from current server (${BASE_URL})`);
    }
  }

  const resp = await apiCall("GET", "/snapshots");
  const data = await jsonResult<{ snapshots: Record<string, unknown>[] }>(resp);
  if (data.snapshots.length === 0) {
    console.log("(none)");
    return;
  }
  for (const s of data.snapshots) {
    const parts = [s.name as string];
    if (s.git_branch) parts.push(`[${s.git_branch}@${(s.git_commit as string || "").slice(0, 8)}]`);
    if (s.description) parts.push(`— ${s.description}`);
    console.log(`  ${parts.join(" ")}`);
  }
}

async function cmdSnapshotPull(snapName: string, machineName: string) {
  const resp = await apiCall("POST", `/snapshots/${snapName}/pull`, { name: machineName });
  const data = await jsonResult<Record<string, unknown>>(resp);
  console.log(`Pulled: ${snapName} -> ${data.name} (${data.state})`);
}

async function cmdSnapshotRm(name: string) {
  const resp = await apiCall("DELETE", `/snapshots/${name}`);
  await okOrDie(resp, "snapshot delete");
  console.log(`Deleted snapshot: ${name}`);
}

function snapshotsDir(): string {
  const home = Deno.env.get("HOME") || "~";
  if (Deno.build.os === "darwin") {
    return `${home}/Library/Application Support/smolvm/snapshots`;
  }
  return `${home}/.local/share/smolvm/snapshots`;
}

async function cmdSnapshotExport(name: string, destPath?: string) {
  const src = `${snapshotsDir()}/${name}.smolvm`;
  try {
    await Deno.stat(src);
  } catch {
    die(`snapshot '${name}' not found at ${src}`);
  }
  const dst = destPath || `./${name}.smolvm`;
  await Deno.copyFile(src, dst);
  const stat = await Deno.stat(dst);
  const sizeMb = ((stat.size || 0) / (1024 * 1024)).toFixed(1);
  console.log(`Exported: ${dst} (${sizeMb} MB)`);
  // Copy SHA-256 sidecar if present
  const sha256Src = `${src}.sha256`;
  try {
    await Deno.copyFile(sha256Src, `${dst}.sha256`);
    const hash = (await Deno.readTextFile(sha256Src)).trim();
    console.log(`  sha256: ${hash}`);
  } catch { /* no sidecar */ }
}

async function cmdSnapshotImport(filePath: string, overrideName?: string) {
  try {
    await Deno.stat(filePath);
  } catch {
    die(`file not found: ${filePath}`);
  }
  if (!filePath.endsWith(".smolvm") && !filePath.endsWith(".smolvm.tar.gz")) {
    die(`expected .smolvm file, got: ${filePath}`);
  }
  // Derive name from filename or use override
  const basename = filePath.split("/").pop()!;
  const name = overrideName || basename.replace(".smolvm.tar.gz", "").replace(".smolvm", "");
  const snapDir = snapshotsDir();
  await Deno.mkdir(snapDir, { recursive: true });
  const dst = `${snapDir}/${name}.smolvm`;
  await Deno.copyFile(filePath, dst);
  // Copy sidecar if present
  try {
    await Deno.copyFile(`${filePath}.sha256`, `${dst}.sha256`);
  } catch { /* no sidecar */ }
  const stat = await Deno.stat(dst);
  const sizeMb = ((stat.size || 0) / (1024 * 1024)).toFixed(1);
  console.log(`Imported snapshot: ${name} (${sizeMb} MB)`);
  // Try to read manifest from archive
  try {
    const proc = new Deno.Command("tar", {
      args: ["xf", filePath, "manifest.json", "-O"],
      stdout: "piped", stderr: "null",
    });
    const out = await proc.output();
    if (out.success) {
      const manifest = JSON.parse(new TextDecoder().decode(out.stdout));
      if (manifest.description) console.log(`  desc: ${manifest.description}`);
      if (manifest.git_branch) console.log(`  git: ${manifest.git_branch}@${(manifest.git_commit || "").slice(0, 8)}`);
      if (manifest.parent_snapshot) console.log(`  parent: ${manifest.parent_snapshot}`);
    }
  } catch { /* can't read manifest, not critical */ }
  console.log(`Use: smolctl snapshot pull ${name} <machine-name>`);
}

async function cmdSnapshotUpload(name: string) {
  const snapDir = snapshotsDir();
  const filePath = `${snapDir}/${name}.smolvm`;
  let fileInfo: Deno.FileInfo;
  try {
    fileInfo = await Deno.stat(filePath);
  } catch {
    die(`snapshot '${name}' not found at ${filePath}`);
  }
  const sizeMb = ((fileInfo!.size || 0) / (1024 * 1024)).toFixed(1);
  console.log(`Uploading snapshot '${name}' (${sizeMb} MB)...`);

  // Read the snapshot file
  const fileData = await Deno.readFile(filePath);

  // Read SHA-256 sidecar if present
  let sha256: string | undefined;
  try {
    sha256 = (await Deno.readTextFile(`${filePath}.sha256`)).trim();
  } catch { /* no sidecar */ }

  // POST to upload endpoint
  const hdrs: Record<string, string> = {
    "Content-Type": "application/octet-stream",
  };
  if (sha256) hdrs["X-Smolvm-Sha256"] = sha256;
  if (TOKEN) hdrs["Authorization"] = `Bearer ${TOKEN}`;

  const resp = await fetch(
    `${API}/snapshots/upload?name=${encodeURIComponent(name)}`,
    {
      method: "POST",
      headers: hdrs,
      body: fileData,
      // 30 min timeout for large snapshot uploads
      signal: AbortSignal.timeout(30 * 60 * 1000),
    },
  );
  if (!resp.ok) {
    const text = await resp.text();
    die(`upload failed (${resp.status}): ${text}`);
  }
  const result = await resp.json();
  console.log(`Uploaded: ${name} (${sizeMb} MB)`);
  if (sha256) console.log(`  sha256: ${sha256}`);
  if (result.manifest || result.name) {
    console.log(`  server: ${JSON.stringify(result)}`);
  }
}

async function cmdSnapshotDownload(name: string) {
  console.log(`Downloading snapshot '${name}'...`);

  // Ensure snapshots directory exists
  const snapDir = snapshotsDir();
  await Deno.mkdir(snapDir, { recursive: true });
  const dst = `${snapDir}/${name}.smolvm`;

  // Use curl for reliable large-file streaming (Deno fetch drops connection on big responses).
  // Download to a temp file first, then move — avoids clobbering the source file when
  // the server reads from the same snapshots directory (local provider).
  const url = `${API}/snapshots/${encodeURIComponent(name)}/download`;
  const tmpDst = await Deno.makeTempFile({ suffix: ".smolvm" });
  const headerDump = await Deno.makeTempFile({ suffix: ".headers" });
  const curlArgs = [
    "-f", "-s", "-S", "--show-error",
    "-o", tmpDst,
    "-D", headerDump,
  ];
  if (TOKEN) curlArgs.push("-H", `Authorization: Bearer ${TOKEN}`);
  curlArgs.push(url);

  const proc = new Deno.Command("curl", { args: curlArgs, stdout: "piped", stderr: "piped" });
  const result = await proc.output();
  if (!result.success) {
    const stderr = new TextDecoder().decode(result.stderr);
    try { await Deno.remove(tmpDst); } catch { /* ignore */ }
    try { await Deno.remove(headerDump); } catch { /* ignore */ }
    die(`download failed: ${stderr}`);
  }

  // Move temp file to final destination
  await Deno.rename(tmpDst, dst);

  // Parse SHA-256 from response headers
  let sha256: string | undefined;
  try {
    const headerText = await Deno.readTextFile(headerDump);
    const sha256Match = headerText.match(/x-smolvm-sha256:\s*(\S+)/i);
    sha256 = sha256Match?.[1];
  } catch { /* ignore */ }
  try { await Deno.remove(headerDump); } catch { /* ignore */ }

  if (sha256) {
    await Deno.writeTextFile(`${dst}.sha256`, sha256 + "\n");
    // Validate hash
    const downloaded = await Deno.readFile(dst);
    const hashBuf = await crypto.subtle.digest("SHA-256", downloaded);
    const hashHex = Array.from(new Uint8Array(hashBuf))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    if (hashHex !== sha256) {
      console.error(`warning: SHA-256 mismatch! expected ${sha256}, got ${hashHex}`);
    } else {
      console.log(`  sha256: ${sha256} (verified)`);
    }
  }

  const stat = await Deno.stat(dst);
  const sizeMb = ((stat.size || 0) / (1024 * 1024)).toFixed(1);
  console.log(`Downloaded: ${dst} (${sizeMb} MB)`);
  console.log(`Use: smolctl snapshot pull ${name} <machine-name>`);
}

// ---------------------------------------------------------------------------
// Workspace export/import — lightweight (~1MB git repo vs ~100MB full disk)
// ---------------------------------------------------------------------------

async function cmdWorkspaceExport(machine: string, destPath?: string) {
  console.log(`Exporting workspace from '${machine}'...`);

  // Check machine is running
  const infoResp = await apiCall("GET", `/machines/${machine}`);
  if (!infoResp.ok) die(`machine '${machine}' not found`);
  const info = await infoResp.json();
  if (info.state !== "running") die(`machine '${machine}' is not running (state: ${info.state}). Start it first.`);

  // Resolve workspace path inside VM
  const wsCheck = await apiCall("POST", `/machines/${machine}/exec`, {
    command: ["sh", "-c", "test -d /storage/workspace/.git && echo /storage/workspace || (test -d /workspace/.git && echo /workspace || echo none)"],
    timeoutSecs: 5,
  });
  const wsData = await jsonResult<{ stdout: string }>(wsCheck);
  const wsPath = wsData.stdout.trim();
  if (wsPath === "none") die(`no git workspace found in '${machine}'. Initialize with: smolctl git init ${machine}`);

  // Capture git info for the filename/metadata
  const gitInfoResp = await apiCall("POST", `/machines/${machine}/exec`, {
    command: ["sh", "-c", `cd ${wsPath} && echo "$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)|$(git rev-parse --short HEAD 2>/dev/null || echo unknown)|$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')"`],
    timeoutSecs: 5,
  });
  const gitInfo = await jsonResult<{ stdout: string }>(gitInfoResp);
  const [branch, commit, dirtyCount] = gitInfo.stdout.trim().split("|");

  // Tar the workspace inside the VM and base64 encode for transport
  const tarCmd = `cd ${wsPath} && tar czf - . 2>/dev/null | base64`;
  const resp = await apiCall("POST", `/machines/${machine}/exec`, {
    command: ["sh", "-c", tarCmd],
    timeoutSecs: 120,
  }, LONG_TIMEOUT_MS);
  const data = await jsonResult<{ exitCode?: number; exit_code?: number; stdout: string; stderr: string }>(resp);
  const code = data.exit_code ?? data.exitCode ?? -1;
  if (code !== 0) die(`workspace tar failed: ${data.stderr}`);

  // Decode base64 to raw bytes
  const b64 = data.stdout.replace(/\s/g, "");
  const raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const sizeMb = (raw.byteLength / (1024 * 1024)).toFixed(2);

  // Write to destination
  const dst = destPath || `./${machine}-workspace.tar.gz`;
  await Deno.writeFile(dst, raw);

  console.log(`Exported workspace: ${dst} (${sizeMb} MB)`);
  console.log(`  git: ${branch}@${commit}${parseInt(dirtyCount) > 0 ? " (dirty)" : ""}`);
  console.log(`  source: ${machine}:${wsPath}`);
}

async function cmdWorkspaceImport(filePath: string, machine: string) {
  console.log(`Importing workspace into '${machine}'...`);

  // Verify file exists
  let fileInfo: Deno.FileInfo;
  try {
    fileInfo = await Deno.stat(filePath);
  } catch {
    die(`file not found: ${filePath}`);
    return; // unreachable, for TS
  }
  const sizeMb = ((fileInfo.size || 0) / (1024 * 1024)).toFixed(2);

  // Check machine is running
  const infoResp = await apiCall("GET", `/machines/${machine}`);
  if (!infoResp.ok) die(`machine '${machine}' not found`);
  const info = await infoResp.json();
  if (info.state !== "running") die(`machine '${machine}' is not running (state: ${info.state}). Start it first.`);

  // Ensure workspace directory exists and has git
  await apiCall("POST", `/machines/${machine}/exec`, {
    command: ["sh", "-c", "mkdir -p /storage/workspace && test -L /workspace || ln -sfn /storage/workspace /workspace 2>/dev/null || true"],
    timeoutSecs: 5,
  });

  // Upload the tar.gz via archive endpoint to /storage/workspace
  const tarData = await Deno.readFile(filePath);
  const qs = `?dir=${encodeURIComponent("/storage/workspace")}`;
  const resp = await fetch(`${API}/machines/${machine}/archive/upload${qs}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/gzip",
      ...(TOKEN ? { "Authorization": `Bearer ${TOKEN}` } : {}),
    },
    body: tarData,
    signal: AbortSignal.timeout(LONG_TIMEOUT_MS),
  });
  await okOrDie(resp, "workspace import");

  // Mark safe.directory so git works
  await apiCall("POST", `/machines/${machine}/exec`, {
    command: ["sh", "-c", "git config --global --add safe.directory /storage/workspace 2>/dev/null || true"],
    timeoutSecs: 5,
  });

  // Verify git history survived
  const verifyResp = await apiCall("POST", `/machines/${machine}/exec`, {
    command: ["sh", "-c", "cd /storage/workspace && git log --oneline -3 2>/dev/null || echo '(no git history)'"],
    timeoutSecs: 5,
  });
  const verifyData = await jsonResult<{ stdout: string }>(verifyResp);

  console.log(`Imported workspace: ${filePath} (${sizeMb} MB) -> ${machine}:/storage/workspace`);
  console.log(`  recent commits:`);
  for (const line of verifyData.stdout.trim().split("\n").slice(0, 3)) {
    console.log(`    ${line}`);
  }
}

// ---------------------------------------------------------------------------
// Docker interop — workspace-only Dockerfile generation
// ---------------------------------------------------------------------------

async function cmdToDocker(machine: string, args: string[]) {
  const { flags } = parseFlags(args, ["tag", "output"]);
  const tag = flagAll(flags, "tag")[0] || `${machine}:latest`;
  const outputDir = flagAll(flags, "output")[0] || `./${machine}-docker`;

  console.log(`Generating Docker build context from '${machine}'...`);

  // Check machine is running
  const infoResp = await apiCall("GET", `/machines/${machine}`);
  if (!infoResp.ok) die(`machine '${machine}' not found`);
  const info = await infoResp.json();
  if (info.state !== "running") die(`machine '${machine}' is not running (state: ${info.state}). Start it first.`);

  // Resolve workspace path
  const wsCheck = await apiCall("POST", `/machines/${machine}/exec`, {
    command: ["sh", "-c", "test -d /storage/workspace/.git && echo /storage/workspace || (test -d /workspace/.git && echo /workspace || echo none)"],
    timeoutSecs: 5,
  });
  const wsData = await jsonResult<{ stdout: string }>(wsCheck);
  const wsPath = wsData.stdout.trim();
  if (wsPath === "none") die(`no git workspace found in '${machine}'. Initialize with: smolctl git init ${machine}`);

  // Get git info
  const gitResp = await apiCall("POST", `/machines/${machine}/exec`, {
    command: ["sh", "-c", `cd ${wsPath} && echo "$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)|$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"`],
    timeoutSecs: 5,
  });
  const gitInfo = await jsonResult<{ stdout: string }>(gitResp);
  const [branch, commit] = gitInfo.stdout.trim().split("|");

  // Detect installed packages (best-effort)
  const pkgResp = await apiCall("POST", `/machines/${machine}/exec`, {
    command: ["sh", "-c", "apk info -q 2>/dev/null | sort | tr '\\n' ' '"],
    timeoutSecs: 5,
  });
  const pkgData = await jsonResult<{ stdout: string }>(pkgResp);
  const packages = pkgData.stdout.trim();

  // Export workspace
  const workspaceTar = `${outputDir}/workspace.tar.gz`;
  await Deno.mkdir(outputDir, { recursive: true });

  const tarCmd = `cd ${wsPath} && tar czf - . 2>/dev/null | base64`;
  const resp = await apiCall("POST", `/machines/${machine}/exec`, {
    command: ["sh", "-c", tarCmd],
    timeoutSecs: 120,
  }, LONG_TIMEOUT_MS);
  const data = await jsonResult<{ exitCode?: number; exit_code?: number; stdout: string; stderr: string }>(resp);
  const code = data.exit_code ?? data.exitCode ?? -1;
  if (code !== 0) die(`workspace tar failed: ${data.stderr}`);

  const b64 = data.stdout.replace(/\s/g, "");
  const raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  await Deno.writeFile(workspaceTar, raw);

  // Extract workspace into build context
  const wsDir = `${outputDir}/workspace`;
  await Deno.mkdir(wsDir, { recursive: true });
  const extractProc = new Deno.Command("tar", {
    args: ["xzf", workspaceTar, "-C", wsDir],
    stdout: "piped", stderr: "piped",
  });
  const extractResult = await extractProc.output();
  if (!extractResult.success) die(`tar extract failed: ${new TextDecoder().decode(extractResult.stderr)}`);
  await Deno.remove(workspaceTar);

  // Generate Dockerfile
  const dockerfile = [
    `FROM alpine:3.19`,
    ``,
    `# Generated by smolctl to-docker from machine '${machine}'`,
    `# git: ${branch}@${commit}`,
    `# date: ${new Date().toISOString()}`,
    ``,
  ];
  if (packages) {
    // Filter to commonly useful packages (skip base system)
    const skipPkgs = new Set(["alpine-baselayout", "alpine-keys", "apk-tools", "busybox", "libc-utils", "musl", "musl-utils", "scanelf", "ssl_client", "zlib", "ca-certificates-bundle", "libcrypto3", "libssl3"]);
    const userPkgs = packages.split(/\s+/).filter(p => p && !skipPkgs.has(p));
    if (userPkgs.length > 0) {
      dockerfile.push(`RUN apk add --no-cache ${userPkgs.join(" ")}`);
      dockerfile.push(``);
    }
  }
  dockerfile.push(`COPY workspace/ /workspace`);
  dockerfile.push(`WORKDIR /workspace`);
  dockerfile.push(``);
  dockerfile.push(`# Add your CMD/ENTRYPOINT here:`);
  dockerfile.push(`# CMD ["sh"]`);
  dockerfile.push(``);

  await Deno.writeTextFile(`${outputDir}/Dockerfile`, dockerfile.join("\n"));

  // Generate .dockerignore
  await Deno.writeTextFile(`${outputDir}/.dockerignore`, `.git\n*.tar.gz\n`);

  const wsSizeMb = (raw.byteLength / (1024 * 1024)).toFixed(2);
  console.log(`Docker build context: ${outputDir}/`);
  console.log(`  Dockerfile + workspace/ (${wsSizeMb} MB)`);
  console.log(`  git: ${branch}@${commit}`);
  if (packages) console.log(`  packages: ${packages.split(/\s+/).slice(0, 10).join(", ")}${packages.split(/\s+/).length > 10 ? "..." : ""}`);
  console.log(``);
  console.log(`Build and run:`);
  console.log(`  cd ${outputDir}`);
  console.log(`  docker build -t ${tag} .`);
  console.log(`  docker run -it ${tag} sh`);
}

async function cmdSnapshotDescribe(name: string) {
  const resp = await apiCall("GET", "/snapshots");
  const data = await jsonResult<{ snapshots: Record<string, unknown>[] }>(resp);
  const snap = data.snapshots.find(s => s.name === name);
  if (!snap) die(`snapshot '${name}' not found`);
  console.log(`Name:        ${snap.name}`);
  console.log(`Platform:    ${snap.platform}`);
  console.log(`Created:     ${snap.created_at}`);
  console.log(`Network:     ${snap.network}`);
  const oMb = ((snap.overlay_size_bytes as number || 0) / (1024 * 1024)).toFixed(1);
  const sMb = ((snap.storage_size_bytes as number || 0) / (1024 * 1024)).toFixed(1);
  console.log(`Overlay:     ${oMb} MB`);
  console.log(`Storage:     ${sMb} MB`);
  if (snap.description) console.log(`Description: ${snap.description}`);
  if (snap.owner) console.log(`Owner:       ${snap.owner}`);
  if (snap.parent_snapshot) console.log(`Parent:      ${snap.parent_snapshot}`);
  if (snap.git_branch) console.log(`Git branch:  ${snap.git_branch}`);
  if (snap.git_commit) console.log(`Git commit:  ${snap.git_commit}`);
  if (snap.git_dirty !== undefined && snap.git_dirty !== null) console.log(`Git dirty:   ${snap.git_dirty}`);
  if (snap.sha256) console.log(`SHA-256:     ${snap.sha256}`);
}

async function cmdSnapshotMerge(snapName: string, targetVm: string, args: string[]) {
  const { flags } = parseFlags(args, ["strategy"]);
  const strategy = flag(flags, "strategy");
  const tempName = `_merge-${snapName}-${Date.now()}`;

  // 1. Pull snapshot into temp machine
  console.log(`Pulling snapshot '${snapName}' into temp machine '${tempName}'...`);
  const pullResp = await apiCall("POST", `/snapshots/${snapName}/pull`, { name: tempName });
  await okOrDie(pullResp, "snapshot pull for merge");

  try {
    // 2. Start temp machine
    console.log("Starting temp machine...");
    const startResp = await apiCall("POST", `/machines/${tempName}/start`);
    await okOrDie(startResp, "start temp machine");
    // Wait for ready
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 1000));
      try {
        const r = await gitExec(tempName, "echo ready", 5);
        if (r.exit_code === 0) break;
      } catch { /* not ready yet */ }
    }
    // Mount storage
    await ensureStorageMounted(tempName);

    // 3. Git merge using existing infrastructure
    console.log(`Merging ${tempName} → ${targetVm}...`);
    await cmdGitMerge(tempName, targetVm, strategy ? ["--strategy", strategy] : []);
    console.log(`Merged snapshot '${snapName}' into '${targetVm}'`);
  } finally {
    // 4. Clean up temp machine
    console.log("Cleaning up temp machine...");
    try { await apiCall("POST", `/machines/${tempName}/stop`); } catch { /* may already be stopped */ }
    try { await apiCall("DELETE", `/machines/${tempName}`); } catch { /* best effort */ }
  }
}

// ── Snapshot file access ──────────────────────────────────────────────

/**
 * Boot a temp machine from a snapshot, run a callback, then clean up.
 * Reusable helper for snapshot merge, cp, ls-files.
 */
async function withTempFromSnapshot(
  snapName: string,
  prefix: string,
  fn: (tempName: string) => Promise<void>,
): Promise<void> {
  const tempName = `_${prefix}-${snapName}-${Date.now()}`;
  console.log(`Pulling snapshot '${snapName}' into temp machine '${tempName}'...`);
  const pullResp = await apiCall("POST", `/snapshots/${snapName}/pull`, { name: tempName }, LONG_TIMEOUT_MS);
  await okOrDie(pullResp, "snapshot pull");

  try {
    console.log("Starting temp machine...");
    const startResp = await apiCall("POST", `/machines/${tempName}/start`, undefined, LONG_TIMEOUT_MS);
    await okOrDie(startResp, "start temp machine");
    // Wait for ready
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 1000));
      try {
        const r = await gitExec(tempName, "echo ready", 5);
        if (r.exit_code === 0) break;
      } catch { /* not ready yet */ }
    }
    // Don't mount /dev/vda — pulled snapshots store workspace in overlay, not ext4 disk.
    // Mounting /dev/vda would hide the overlay workspace.
    await fn(tempName);
  } finally {
    console.log("Cleaning up temp machine...");
    try { await apiCall("POST", `/machines/${tempName}/stop`); } catch { /* may already be stopped */ }
    try { await apiCall("DELETE", `/machines/${tempName}`); } catch { /* best effort */ }
  }
}

/**
 * Check if a name refers to an existing snapshot on disk.
 * Snapshots can be .smolvm or .smolvm.tar.gz
 */
function isSnapshot(name: string): boolean {
  const dir = snapshotsDir();
  for (const ext of [".smolvm", ".smolvm.tar.gz"]) {
    try {
      Deno.statSync(`${dir}/${name}${ext}`);
      return true;
    } catch { /* try next */ }
  }
  return false;
}

/**
 * smolctl snapshot ls-files <snap> [path] [--recursive]
 */
async function cmdSnapshotLsFiles(snapName: string, path?: string, args: string[] = []) {
  if (!snapName) die("usage: smolctl snapshot ls-files <snap-name> [path] [--recursive]");
  if (!isSnapshot(snapName)) die(`Snapshot '${snapName}' not found in ${snapshotsDir()}`);

  const { flags } = parseFlags(args, ["recursive"]);
  const recursive = hasFlag(flags, "recursive") || args.includes("-r");
  const targetPath = path || "/storage/workspace";

  await withTempFromSnapshot(snapName, "ls", async (tempName) => {
    const cmd = recursive
      ? `find ${targetPath} -type f 2>/dev/null | sort`
      : `ls -la ${targetPath} 2>/dev/null`;
    const resp = await apiCall("POST", `/machines/${tempName}/exec`, {
      command: ["sh", "-c", cmd],
      timeoutSecs: 15,
    }, LONG_TIMEOUT_MS);
    const result = await jsonResult<{ stdout?: string; stderr?: string; exit_code?: number }>(resp);
    if (result.stdout) {
      console.log(result.stdout.trim());
    } else {
      console.log("(no files found at " + targetPath + ")");
    }
  });
}

/**
 * smolctl snapshot cp <src> <dst> [--exclude ...]
 * Supports: snapshot:path → local  OR  local → snapshot:path
 */
async function cmdSnapshotCp(src: string, dst: string, args: string[]) {
  if (!src || !dst) die("usage: smolctl snapshot cp <src> <dst> [--exclude pattern]\n  e.g.  smolctl snapshot cp my-snap:/workspace/file.txt ./file.txt\n        smolctl snapshot cp ./file.txt my-snap:/workspace/file.txt");

  const srcP = parseCpPath(src);
  const dstP = parseCpPath(dst);
  const { flags } = parseFlags(args, ["exclude"]);
  const excludes = flagAll(flags, "exclude");

  const srcIsSnap = srcP.machine && isSnapshot(srcP.machine);
  const dstIsSnap = dstP.machine && isSnapshot(dstP.machine);

  if (srcIsSnap && !dstP.machine) {
    // Extract from snapshot → local
    const snapName = srcP.machine!;
    const remotePath = srcP.path;
    const localPath = dstP.path;
    console.log(`Extracting ${snapName}:${remotePath} → ${localPath}`);

    await withTempFromSnapshot(snapName, "cp", async (tempName) => {
      await cpMachineToLocal(tempName, remotePath, localPath, excludes);
    });
    console.log(`Done: extracted from snapshot '${snapName}'`);

  } else if (!srcP.machine && dstIsSnap) {
    // Inject local → snapshot
    const snapName = dstP.machine!;
    const remotePath = dstP.path;
    const localPath = srcP.path;
    const filename = localPath.split("/").pop() || "files";
    console.log(`Injecting ${localPath} → ${snapName}:${remotePath}`);

    await withTempFromSnapshot(snapName, "cp", async (tempName) => {
      await cpLocalToMachine(localPath, tempName, remotePath, excludes);
      // Git commit the change
      await gitExec(tempName, `cd /storage/workspace && git add -A && git commit -m "snapshot cp: added ${filename}" --allow-empty`, 15);
      // Push back as updated snapshot
      console.log("Pushing updated snapshot...");
      const pushResp = await apiCall("POST", `/machines/${tempName}/push`, { description: `snapshot cp: added ${filename}` });
      await okOrDie(pushResp, "push updated snapshot");
    });
    console.log(`Done: injected into snapshot '${snapName}'`);

  } else {
    die("snapshot cp requires one snapshot:path and one local path.\n  e.g.  smolctl snapshot cp my-snap:/workspace/file.txt ./file.txt");
  }
}

async function cmdSnapshotLineage(name: string) {
  const resp = await apiCall("GET", "/snapshots");
  const data = await jsonResult<{ snapshots: Record<string, unknown>[] }>(resp);
  const byName = new Map(data.snapshots.map(s => [s.name as string, s]));

  const chain: Record<string, unknown>[] = [];
  let current: string | undefined = name;
  const seen = new Set<string>();
  while (current && byName.has(current) && !seen.has(current)) {
    seen.add(current);
    const snap = byName.get(current)!;
    chain.push(snap);
    current = snap.parent_snapshot as string | undefined;
  }

  if (chain.length === 0) {
    die(`snapshot '${name}' not found`);
  }
  for (let i = 0; i < chain.length; i++) {
    const s = chain[i];
    const indent = i === 0 ? "→ " : "  ";
    const desc = s.description ? ` — ${s.description}` : "";
    const git = s.git_branch ? ` [${s.git_branch}@${(s.git_commit as string || "").slice(0, 8)}]` : "";
    console.log(`${indent}${s.name} (${s.created_at})${git}${desc}`);
  }
}

async function cmdSnapshotHistory(name: string) {
  const resp = await apiCall("GET", `/snapshots/${name}/history`);
  const data = await jsonResult<{
    chain: Record<string, unknown>[];
    total_snapshots: number;
    full_snapshots: number;
    incremental_snapshots: number;
    total_size_bytes: number;
  }>(resp);

  console.log(`Snapshot history: ${name}`);
  console.log(`  versions: ${data.total_snapshots} (${data.full_snapshots} full, ${data.incremental_snapshots} incremental)`);
  console.log(`  total size: ${formatBytes(data.total_size_bytes)}`);
  console.log();

  for (const snap of data.chain) {
    const ver = snap.sequence ?? snap.snapshot_version ?? "?";
    const type = (snap.snapshot_version as number) >= 2 ? "delta" : "full";
    const desc = snap.description ? ` — ${snap.description}` : "";
    const git = snap.git_branch ? ` [${snap.git_branch}@${(snap.git_commit as string || "").slice(0, 8)}]` : "";
    const sha = snap.sha256 ? ` ${(snap.sha256 as string).slice(0, 12)}...` : "";
    console.log(`  v${ver} (${type})${git}${desc}${sha}`);
    if (snap.created_at) console.log(`    created: ${snap.created_at}`);
  }
}

async function cmdSnapshotRollback(snapName: string, machineName: string, args: string[]) {
  const { flags } = parseFlags(args, ["version"]);
  const version = flag(flags, "version") ? parseInt(flag(flags, "version")!) : undefined;

  const body: Record<string, unknown> = { machine_name: machineName };
  if (version !== undefined) body.version = version;

  console.log(`Rolling back ${machineName} to ${snapName}${version ? ` v${version}` : " (latest)"}...`);
  const resp = await apiCall("POST", `/snapshots/${snapName}/rollback`, body);
  const data = await jsonResult<{
    machine_name: string;
    restored_version: number;
    manifest: Record<string, unknown>;
  }>(resp);
  console.log(`Rolled back: ${data.machine_name} → v${data.restored_version}`);
  if (data.manifest.git_branch) console.log(`  git: ${data.manifest.git_branch}@${(data.manifest.git_commit as string || "").slice(0, 8)}`);
  if (data.manifest.description) console.log(`  desc: ${data.manifest.description}`);
}

async function cmdSnapshotSquash(name: string, args: string[]) {
  const { flags } = parseFlags(args, ["keep"]);
  const keepOld = hasFlag(flags, "keep");

  // 1. Get history to see what we're squashing
  const histResp = await apiCall("GET", `/snapshots/${name}/history`);
  const hist = await jsonResult<{
    chain: Record<string, unknown>[];
    total_snapshots: number;
    total_size_bytes: number;
  }>(histResp);

  if (hist.total_snapshots <= 1) {
    console.log(`Nothing to squash — ${name} has only ${hist.total_snapshots} version(s).`);
    return;
  }

  console.log(`Squashing ${hist.total_snapshots} versions of ${name} (${formatBytes(hist.total_size_bytes)})...`);

  // 2. Pull latest into a temp machine
  const tempName = `_squash-${name}-${Date.now()}`;
  const pullResp = await apiCall("POST", `/snapshots/${name}/pull`, { name: tempName });
  await jsonResult(pullResp);

  // 3. Push as a fresh full snapshot (overwrites latest)
  const pushResp = await apiCall("POST", `/machines/${tempName}/push`, {
    description: `squashed from ${hist.total_snapshots} versions`,
  });
  await jsonResult(pushResp);

  // 4. Clean up temp machine
  await apiCall("DELETE", `/machines/${tempName}`);

  // 5. Delete old versioned archives (unless --keep)
  if (!keepOld) {
    // List snapshot files and delete versioned ones
    const snapDir = snapshotsDir();
    try {
      for await (const entry of Deno.readDir(snapDir)) {
        if (entry.name.startsWith(`${name}.v`) && entry.name.endsWith(".smolvm")) {
          await Deno.remove(`${snapDir}/${entry.name}`);
        }
        // Also clean up sidecar sha256 files
        if (entry.name.startsWith(`${name}.v`) && entry.name.endsWith(".sha256")) {
          await Deno.remove(`${snapDir}/${entry.name}`);
        }
      }
    } catch {
      // ignore if dir doesn't exist
    }
  }

  // 6. Show result
  const newHistResp = await apiCall("GET", `/snapshots/${name}/history`);
  const newHist = await jsonResult<{ total_snapshots: number; total_size_bytes: number }>(newHistResp);
  console.log(`Squashed: ${hist.total_snapshots} → ${newHist.total_snapshots} version(s), ${formatBytes(hist.total_size_bytes)} → ${formatBytes(newHist.total_size_bytes)}`);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
}

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

async function cmdImagePull(machine: string, image: string) {
  console.log(`Pulling ${image}...`);
  const resp = await apiCall("POST", `/machines/${machine}/images/pull`, { image }, LONG_TIMEOUT_MS);
  const data = await jsonResult<Record<string, unknown>>(resp);
  console.log(`Pulled: ${JSON.stringify(data)}`);
}

async function cmdImageLs(machine: string) {
  const resp = await apiCall("GET", `/machines/${machine}/images`);
  const data = await jsonResult<{ images: Record<string, unknown>[] }>(resp);
  if (data.images.length === 0) {
    console.log("(none)");
    return;
  }
  for (const img of data.images) {
    console.log(`  ${img.name ?? img.image ?? JSON.stringify(img)}`);
  }
}

async function cmdRun(machine: string, image: string, command: string[], args: string[]) {
  const { flags } = parseFlags(args, ["env", "workdir", "user", "timeout"]);
  const body: Record<string, unknown> = {
    image,
    command,
    timeoutSecs: parseInt(flag(flags, "timeout") ?? "30"),
  };
  if (flag(flags, "user")) body.user = flag(flags, "user");
  if (flag(flags, "workdir")) body.workdir = flag(flags, "workdir");

  const resp = await apiCall("POST", `/machines/${machine}/run`, body, LONG_TIMEOUT_MS);
  const data = await jsonResult<{ exitCode?: number; exit_code?: number; stdout: string; stderr: string }>(resp);
  const code = data.exit_code ?? data.exitCode ?? -1;
  if (data.stdout) Deno.stdout.writeSync(new TextEncoder().encode(data.stdout));
  if (data.stderr) Deno.stderr.writeSync(new TextEncoder().encode(data.stderr));
  if (code !== 0) Deno.exit(code);
}

// ---------------------------------------------------------------------------
// File commands
// ---------------------------------------------------------------------------

async function cmdFilesLs(name: string, dir?: string) {
  // Work around server-side bug where $f shell variable isn't expanded in stat command.
  // Use exec-based listing instead.
  const targetDir = dir ?? "/";
  // Use a delimiter to avoid ambiguity from spaces in filenames and type names
  const esc = targetDir.replace(/'/g, "'\\''");
  const script = `ls -1a '${esc}' 2>/dev/null | while read f; do [ "$f" = "." ] || [ "$f" = ".." ] && continue; if [ -d "${esc}/$f" ]; then t=dir; else t=file; fi; s=$(stat -c '%s' "${esc}/$f" 2>/dev/null || echo 0); p=$(stat -c '%a' "${esc}/$f" 2>/dev/null || echo 644); echo "$s|$p|$t|$f"; done`;
  const resp = await apiCall("POST", `/machines/${name}/exec`, {
    command: ["sh", "-c", script],
    timeoutSecs: 15,
  });
  const data = await jsonResult<{ stdout: string; stderr: string; exit_code?: number; exitCode?: number }>(resp);
  const stdout = data.stdout ?? "";
  const rows = stdout.split("\n").filter((l: string) => l.trim()).map((line: string) => {
    const [size, perms, typeStr, ...nameParts] = line.split("|");
    return {
      name: nameParts.join("|"),
      type: typeStr === "dir" ? "dir" : "file",
      size: size ?? "0",
      permissions: perms ?? "-",
    };
  });
  table(rows, ["name", "type", "size", "permissions"]);
}

async function cmdFilesCat(name: string, path: string) {
  const encodedPath = encodeURIComponent(path);
  const resp = await apiCall("GET", `/machines/${name}/files/${encodedPath}`);
  const data = await jsonResult<{ content: string }>(resp);
  const decoded = atob(data.content);
  Deno.stdout.writeSync(new TextEncoder().encode(decoded));
}

async function cmdFilesWrite(name: string, path: string, args: string[]) {
  let content: string;
  const dataIdx = args.indexOf("--data");
  if (dataIdx >= 0 && args[dataIdx + 1]) {
    content = args[dataIdx + 1];
  } else if (args.length > 0 && !args[0].startsWith("--")) {
    // Positional content: smolctl files write <name> <path> "content here"
    content = args.join(" ");
  } else {
    // Read from stdin
    const buf = new Uint8Array(1024 * 1024);
    const chunks: Uint8Array[] = [];
    let n: number | null;
    while ((n = await Deno.stdin.read(buf)) !== null) {
      chunks.push(buf.slice(0, n));
    }
    const decoder = new TextDecoder();
    content = chunks.map((c) => decoder.decode(c)).join("");
  }
  const encoded = btoa(content);
  const encodedPath = encodeURIComponent(path);
  const resp = await apiCall("PUT", `/machines/${name}/files/${encodedPath}`, { content: encoded });
  await okOrDie(resp, "write");
  console.log(`Wrote: ${path}`);
}

async function cmdFilesRm(name: string, path: string) {
  const encodedPath = encodeURIComponent(path);
  const resp = await apiCall("DELETE", `/machines/${name}/files/${encodedPath}`);
  await okOrDie(resp, "delete");
  console.log(`Deleted: ${path}`);
}

// ---------------------------------------------------------------------------
// cp — copy files/dirs in and out of machines
// ---------------------------------------------------------------------------

/**
 * Parse a cp-style path: "machine:/path" or "/local/path"
 * Returns { machine, path } if remote, { machine: null, path } if local.
 */
function parseCpPath(s: string): { machine: string | null; path: string } {
  const match = s.match(/^([a-zA-Z0-9_-]+):(.+)$/);
  if (match) return { machine: match[1], path: match[2] };
  return { machine: null, path: s };
}

async function cmdCp(src: string, dst: string, args: string[]) {
  const { flags } = parseFlags(args, ["exclude"]);
  const excludes = flagAll(flags, "exclude");
  const srcP = parseCpPath(src);
  const dstP = parseCpPath(dst);

  if (!srcP.machine && dstP.machine) {
    // Local -> machine (upload)
    await cpLocalToMachine(srcP.path, dstP.machine, dstP.path, excludes);
  } else if (srcP.machine && !dstP.machine) {
    // Machine -> local (download)
    await cpMachineToLocal(srcP.machine, srcP.path, dstP.path);
  } else {
    die("cp requires one local path and one machine:path (e.g., smolctl cp ./src my-vm:/workspace/src)");
  }
}

async function cpLocalToMachine(localPath: string, machine: string, remotePath: string, excludes: string[]) {
  // Create tar of local path, upload via archive endpoint
  const stat = await Deno.stat(localPath).catch(() => null);
  if (!stat) die(`local path not found: ${localPath}`);

  if (stat.isFile) {
    // Single file: read and upload via file API
    const content = await Deno.readTextFile(localPath);
    const encoded = btoa(content);
    const encodedPath = encodeURIComponent(remotePath);
    const resp = await apiCall("PUT", `/machines/${machine}/files/${encodedPath}`, { content: encoded });
    await okOrDie(resp, "upload");
    console.log(`Copied: ${localPath} -> ${machine}:${remotePath}`);
    return;
  }

  // Directory: tar + upload archive
  console.log(`Packing ${localPath}...`);
  const tarArgs = ["tar", "czf", "-", "-C", localPath, "."];
  for (const ex of excludes) {
    tarArgs.splice(3, 0, `--exclude=${ex}`);
  }
  const proc = new Deno.Command(tarArgs[0], {
    args: tarArgs.slice(1),
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const output = await proc.output();
  if (!output.success) {
    const stderr = new TextDecoder().decode(output.stderr);
    die(`tar failed: ${stderr}`);
  }

  const qs = `?dir=${encodeURIComponent(remotePath)}`;
  const resp = await fetch(`${API}/machines/${machine}/archive/upload${qs}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/gzip",
      ...(TOKEN ? { "Authorization": `Bearer ${TOKEN}` } : {}),
    },
    body: output.stdout,
    signal: AbortSignal.timeout(LONG_TIMEOUT_MS),
  });
  await okOrDie(resp, "archive upload");
  const size = (output.stdout.byteLength / 1024).toFixed(1);
  console.log(`Copied: ${localPath} -> ${machine}:${remotePath} (${size}KB compressed)`);
}

async function cpMachineToLocal(machine: string, remotePath: string, localPath: string, excludes: string[] = []) {
  // Use exec to tar inside VM, get base64 output, decode locally
  // This works around the archive download endpoint bug (invalid gzip)
  console.log(`Downloading ${machine}:${remotePath}...`);

  // Check if remote path is a file or directory
  const checkResp = await apiCall("POST", `/machines/${machine}/exec`, {
    command: ["sh", "-c", `test -f '${remotePath}' && echo FILE || echo DIR`],
    timeoutSecs: 5,
  });
  const checkData = await jsonResult<{ stdout: string }>(checkResp);
  const isFile = checkData.stdout.trim() === "FILE";

  if (isFile) {
    // Single file: read via file API and write locally
    const encodedPath = encodeURIComponent(remotePath);
    const fileResp = await apiCall("GET", `/machines/${machine}/files/${encodedPath}`);
    const fileData = await jsonResult<{ content: string }>(fileResp);
    const decoded = atob(fileData.content);
    // Ensure parent directory exists
    const parentDir = localPath.replace(/\/[^/]+$/, "");
    if (parentDir) await Deno.mkdir(parentDir, { recursive: true }).catch(() => {});
    await Deno.writeTextFile(localPath, decoded);
    console.log(`Copied: ${machine}:${remotePath} -> ${localPath}`);
    return;
  }

  // Directory: tar + download
  // Build tar command with optional excludes
  const excludeFlags = excludes.map((ex) => `--exclude='${ex}'`).join(" ");
  const tarCmd = `tar czf - ${excludeFlags} -C '${remotePath}' . 2>/dev/null | base64`.replace(/  +/g, " ");

  // Create tar.gz inside VM, base64 encode for transport
  const resp = await apiCall("POST", `/machines/${machine}/exec`, {
    command: ["sh", "-c", tarCmd],
    timeoutSecs: 120,
  }, LONG_TIMEOUT_MS);
  const data = await jsonResult<{ exitCode?: number; exit_code?: number; stdout: string; stderr: string }>(resp);
  const code = data.exit_code ?? data.exitCode ?? -1;
  if (code !== 0) {
    die(`tar inside machine failed: ${data.stderr}`);
  }

  // Decode base64 and extract
  const b64 = data.stdout.replace(/\s/g, "");
  const raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const size = (raw.byteLength / 1024).toFixed(1);

  await Deno.mkdir(localPath, { recursive: true });
  const proc = new Deno.Command("tar", {
    args: ["xzf", "-", "-C", localPath],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const writer = proc.stdin.getWriter();
  await writer.write(raw);
  await writer.close();
  const output = await proc.output();
  if (!output.success) {
    const stderr = new TextDecoder().decode(output.stderr);
    die(`tar extract failed: ${stderr}`);
  }
  console.log(`Copied: ${machine}:${remotePath} -> ${localPath} (${size}KB compressed)`);
}

// ---------------------------------------------------------------------------
// Sync push/pull
// ---------------------------------------------------------------------------

async function cmdSyncPush(machine: string, args: string[]) {
  const { flags, positional } = parseFlags(args, ["to", "exclude", "dry-run", "verify"]);
  const localDir = positional[0] ?? ".";
  const remoteDir = flag(flags, "to") ?? "/workspace";
  const excludes = flagAll(flags, "exclude");

  // Resolve local path
  let resolvedLocal: string;
  try {
    resolvedLocal = Deno.realPathSync(localDir);
  } catch {
    die(`local path not found: ${localDir}`);
  }

  const stat = await Deno.stat(resolvedLocal);
  if (!stat.isDirectory) die(`sync push expects a directory, got file: ${resolvedLocal}`);

  // Signature verification (--verify flag)
  if (hasFlag(flags, "verify")) {
    console.log("[verify] Checking signature before push...");
    const { valid, sigData } = await verifySyncSignature(resolvedLocal);
    if (!valid) {
      die(`Signature verification failed for ${resolvedLocal}. Aborting push.\n` +
        `  Run 'smolctl sign file ${localDir}' to sign, or remove --verify to push unsigned.`);
    }
    console.log(`[verify] Signature valid (signer: ${sigData!.signer}, signed: ${sigData!.timestamp})`);
    // Store verification in machine metadata
    const meta = await loadMeta(machine) ?? { name: machine, created_at: new Date().toISOString() };
    meta.signature_verified = true;
    meta.signature_key_id = sigData!.signer;
    meta.signature_timestamp = sigData!.timestamp;
    await saveMeta(meta);
  }

  if (hasFlag(flags, "dry-run")) {
    // Show what would be synced
    const tarArgs = ["tar", "tzf", "-", "-C", resolvedLocal, "."];
    for (const ex of excludes) {
      tarArgs.splice(3, 0, `--exclude=${ex}`);
    }
    // Use tar to list files
    const listArgs = ["tar", "tf", "/dev/stdin"];
    const createArgs = ["czf", "-"];
    for (const ex of excludes) {
      createArgs.splice(1, 0, `--exclude=${ex}`);
    }
    createArgs.push("-C", resolvedLocal, ".");
    const proc = new Deno.Command("tar", {
      args: createArgs,
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    const output = await proc.output();
    if (!output.success) {
      die(`tar list failed`);
    }
    // List from the archive
    const listProc = new Deno.Command("tar", {
      args: ["tzf", "-"],
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    const writer = listProc.stdin.getWriter();
    await writer.write(output.stdout);
    await writer.close();
    const listOutput = await listProc.output();
    const listing = new TextDecoder().decode(listOutput.stdout);
    console.log(`[dry-run] Would push ${resolvedLocal} → ${machine}:${remoteDir}`);
    if (excludes.length > 0) console.log(`[dry-run] Excludes: ${excludes.join(", ")}`);
    console.log(listing);
    return;
  }

  await cpLocalToMachine(resolvedLocal, machine, remoteDir, excludes);
}

async function cmdSyncPull(machine: string, args: string[]) {
  const { flags, positional } = parseFlags(args, ["from", "exclude", "dry-run"]);
  const localDir = positional[0] ?? ".";
  const remoteDir = flag(flags, "from") ?? "/workspace";
  const excludes = flagAll(flags, "exclude");

  if (hasFlag(flags, "dry-run")) {
    // Show what's in the remote directory
    const resp = await apiCall("POST", `/machines/${machine}/exec`, {
      command: ["sh", "-c", `ls -la '${remoteDir}' 2>&1`],
      timeoutSecs: 15,
    });
    const data = await jsonResult<{ exit_code?: number; exitCode?: number; stdout: string; stderr: string }>(resp);
    console.log(`[dry-run] Would pull ${machine}:${remoteDir} → ${localDir}`);
    if (excludes.length > 0) console.log(`[dry-run] Excludes: ${excludes.join(", ")}`);
    console.log(data.stdout);
    return;
  }

  await cpMachineToLocal(machine, remoteDir, localDir, excludes);
}

async function cmdSyncWatch(machine: string, args: string[]) {
  const { flags, positional } = parseFlags(args, ["to", "exclude", "debounce"]);
  const localDir = positional[0] ?? ".";
  const remoteDir = flag(flags, "to") ?? "/workspace";
  const excludes = flagAll(flags, "exclude");
  const debounceMs = parseInt(flag(flags, "debounce") ?? "500");

  // Resolve local path
  let resolvedLocal: string;
  try {
    resolvedLocal = Deno.realPathSync(localDir);
  } catch {
    die(`local path not found: ${localDir}`);
  }

  const stat = await Deno.stat(resolvedLocal);
  if (!stat.isDirectory) die(`sync watch expects a directory, got file: ${resolvedLocal}`);

  // Check if exclude patterns match a changed path
  function isExcluded(filePath: string): boolean {
    const rel = filePath.startsWith(resolvedLocal) ? filePath.slice(resolvedLocal.length + 1) : filePath;
    return excludes.some((ex) => rel.includes(ex) || rel.startsWith(ex));
  }

  // Initial full push
  console.log(`[watch] Initial push: ${resolvedLocal} → ${machine}:${remoteDir}`);
  if (excludes.length > 0) console.log(`[watch] Excludes: ${excludes.join(", ")}`);
  console.log(`[watch] Debounce: ${debounceMs}ms\n`);
  await cpLocalToMachine(resolvedLocal, machine, remoteDir, excludes);
  console.log(`[watch] Watching for changes... (Ctrl+C to stop)\n`);

  // Watch loop with debounce
  let timer: number | null = null;
  const pending = new Set<string>();

  const watcher = Deno.watchFs([resolvedLocal]);

  // Handle Ctrl+C
  const abort = new AbortController();
  Deno.addSignalListener("SIGINT", () => {
    console.log("\n[watch] Stopped.");
    abort.abort();
    Deno.exit(0);
  });

  for await (const event of watcher) {
    if (abort.signal.aborted) break;
    if (event.kind !== "create" && event.kind !== "modify" && event.kind !== "remove") continue;

    let hasRelevant = false;
    for (const path of event.paths) {
      if (!isExcluded(path)) {
        const rel = path.slice(resolvedLocal.length + 1);
        pending.add(rel);
        hasRelevant = true;
      }
    }

    if (!hasRelevant) continue;

    // Debounce: reset timer on each event
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(async () => {
      const count = pending.size;
      const files = Array.from(pending).slice(0, 5);
      pending.clear();
      const preview = files.join(", ") + (count > 5 ? `, +${count - 5} more` : "");
      console.log(`[change] ${count} file(s): ${preview}`);
      const t0 = performance.now();
      try {
        await cpLocalToMachine(resolvedLocal, machine, remoteDir, excludes);
        const ms = Math.round(performance.now() - t0);
        console.log(`[synced] ${machine}:${remoteDir} (${ms}ms)\n`);
      } catch (e) {
        console.error(`[error] Sync failed: ${e}\n`);
      }
    }, debounceMs);
  }
}

// ---------------------------------------------------------------------------
// Tunnel management
// ---------------------------------------------------------------------------

const TUNNEL_STATE_DIR = `${Deno.env.get("HOME")}/.smolvm`;
const TUNNEL_STATE_FILE = `${TUNNEL_STATE_DIR}/tunnel.json`;

interface TunnelState {
  type: "cloudflared" | "ngrok";
  pid: number;
  url: string;
  port: number;
  started: string;
}

async function readTunnelState(): Promise<TunnelState | null> {
  try {
    const text = await Deno.readTextFile(TUNNEL_STATE_FILE);
    return JSON.parse(text) as TunnelState;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    Deno.kill(pid, "SIGCONT"); // signal 0 equivalent — checks if alive
    return true;
  } catch {
    return false;
  }
}

async function startNgrokTunnel(port: number, useAuth: boolean): Promise<{ pid: number; url: string }> {
  // Check if ngrok is installed
  try {
    const check = new Deno.Command("ngrok", { args: ["version"], stdout: "piped", stderr: "piped" });
    const out = await check.output();
    if (!out.success) throw new Error();
  } catch {
    die("ngrok not found. Install from https://ngrok.com/download");
  }

  const args = ["http", String(port), "--log=stdout", "--log-format=json"];

  // If auth flag is set, read NGROK_AUTH_TOKEN env
  if (useAuth) {
    const authToken = Deno.env.get("NGROK_AUTH_TOKEN");
    if (!authToken) {
      die("--auth requires NGROK_AUTH_TOKEN env var to be set");
    }
    args.push("--authtoken", authToken);
  }

  const proc = new Deno.Command("ngrok", {
    args,
    stdout: "piped",
    stderr: "piped",
  }).spawn();

  // Wait for ngrok to start, then poll its local API for the tunnel URL
  await new Promise(r => setTimeout(r, 2000));

  let url = "";
  for (let i = 0; i < 10; i++) {
    try {
      const resp = await fetch("http://127.0.0.1:4040/api/tunnels");
      const data = await resp.json();
      if (data.tunnels?.length > 0) {
        url = data.tunnels[0].public_url;
        break;
      }
    } catch { /* not ready yet */ }
    await new Promise(r => setTimeout(r, 1000));
  }

  if (!url) {
    // Try to kill the process we spawned
    try { Deno.kill(proc.pid, "SIGTERM"); } catch { /* ignore */ }
    die("Failed to get ngrok tunnel URL. Check ngrok logs or http://127.0.0.1:4040");
  }

  return { pid: proc.pid, url };
}

async function cmdTunnelStart(args: string[]) {
  const { flags } = parseFlags(args, ["port", "ngrok", "auth"]);
  const port = parseInt(flag(flags, "port") ?? "9090");
  const useNgrok = hasFlag(flags, "ngrok");

  // Check if tunnel already running
  const existing = await readTunnelState();
  if (existing && isProcessAlive(existing.pid)) {
    console.log(`Tunnel already running (${existing.type}, pid: ${existing.pid})`);
    console.log(`  URL: ${existing.url}`);
    console.log(`  export SMOLVM_URL=${existing.url}`);
    return;
  }

  let tunnelPid: number;
  let tunnelUrl: string;
  let tunnelType: "cloudflared" | "ngrok";

  if (useNgrok) {
    // --- ngrok ---
    const useAuth = hasFlag(flags, "auth");
    console.log(`Starting ngrok tunnel → http://localhost:${port}...`);
    const result = await startNgrokTunnel(port, useAuth);
    tunnelPid = result.pid;
    tunnelUrl = result.url;
    tunnelType = "ngrok";
  } else {
    // --- cloudflared (existing logic) ---
    try {
      const which = new Deno.Command("which", { args: ["cloudflared"], stdout: "piped", stderr: "piped" }).outputSync();
      if (!which.success) throw new Error();
    } catch {
      die("cloudflared not found. Install with: brew install cloudflared");
    }

    console.log(`Starting cloudflared tunnel → http://localhost:${port}...`);

    const proc = new Deno.Command("cloudflared", {
      args: ["tunnel", "--url", `http://localhost:${port}`],
      stdout: "piped",
      stderr: "piped",
    }).spawn();

    // Parse stderr for tunnel URL (cloudflared logs the URL there)
    const reader = proc.stderr.getReader();
    let cfUrl = "";
    const decoder = new TextDecoder();
    const timeout = setTimeout(() => {
      if (!cfUrl) {
        console.error("Timed out waiting for tunnel URL (15s). Check cloudflared output.");
      }
    }, 15_000);

    while (!cfUrl) {
      const { value, done } = await reader.read();
      if (done) break;
      const text = decoder.decode(value);
      const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (match) {
        cfUrl = match[0];
      }
    }
    clearTimeout(timeout);
    reader.releaseLock();

    if (!cfUrl) {
      die("Could not parse tunnel URL from cloudflared output");
    }

    tunnelPid = proc.pid;
    tunnelUrl = cfUrl;
    tunnelType = "cloudflared";
  }

  // Save state
  await Deno.mkdir(TUNNEL_STATE_DIR, { recursive: true });
  const state: TunnelState = {
    type: tunnelType,
    pid: tunnelPid,
    url: tunnelUrl,
    port,
    started: new Date().toISOString(),
  };
  await Deno.writeTextFile(TUNNEL_STATE_FILE, JSON.stringify(state, null, 2));

  console.log(`\n${tunnelType} tunnel started:`);
  console.log(`  URL:  ${tunnelUrl}`);
  console.log(`  PID:  ${tunnelPid}`);
  console.log(`  Port: ${port}`);
  console.log(`\nTo use from anywhere:`);
  console.log(`  export SMOLVM_URL=${tunnelUrl}`);
  if (TOKEN) {
    console.log(`  export SMOLVM_API_TOKEN=${TOKEN}`);
  }
}

async function cmdTunnelStatus() {
  const state = await readTunnelState();
  if (!state) {
    console.log("No tunnel running (no state file)");
    return;
  }

  const tunnelType = state.type ?? "cloudflared";
  const alive = isProcessAlive(state.pid);
  console.log(`Tunnel ${alive ? "running" : "stopped"} (${tunnelType}):`);
  console.log(`  Type:    ${tunnelType}`);
  console.log(`  URL:     ${state.url}`);
  console.log(`  PID:     ${state.pid}`);
  console.log(`  Port:    ${state.port}`);
  console.log(`  Started: ${state.started}`);
  console.log(`  Status:  ${alive ? "alive" : "dead"}`);

  if (!alive) {
    console.log(`\nTunnel process is dead. Run 'smolctl tunnel start' to restart.`);
    // Clean up stale state
    await Deno.remove(TUNNEL_STATE_FILE).catch(() => {});
  }
}

async function cmdTunnelStop() {
  const state = await readTunnelState();
  if (!state) {
    console.log("No tunnel running (no state file)");
    return;
  }

  if (isProcessAlive(state.pid)) {
    try {
      Deno.kill(state.pid, "SIGTERM");
      console.log(`Stopped tunnel (pid: ${state.pid})`);
    } catch (e) {
      console.error(`Failed to kill process ${state.pid}: ${e}`);
    }
  } else {
    console.log("Tunnel process was already stopped");
  }

  await Deno.remove(TUNNEL_STATE_FILE).catch(() => {});
}

async function cmdTunnelShare() {
  const state = await readTunnelState();
  if (!state) {
    die("No tunnel running. Start one with: smolctl tunnel start [--ngrok]");
  }
  if (!isProcessAlive(state.pid)) {
    await Deno.remove(TUNNEL_STATE_FILE).catch(() => {});
    die("Tunnel process is dead. Start one with: smolctl tunnel start [--ngrok]");
  }

  const tunnelType = state.type ?? "cloudflared";
  console.log(`Active ${tunnelType} tunnel → ${state.url}\n`);
  console.log("Connect with:");
  if (TOKEN) {
    console.log(`  SMOLVM_URL=${state.url} SMOLVM_API_TOKEN=${TOKEN} smolctl ls`);
  } else {
    console.log(`  SMOLVM_URL=${state.url} smolctl ls`);
  }
}

// ---------------------------------------------------------------------------
// Git clone into machine
// ---------------------------------------------------------------------------

async function cmdGitClone(machine: string, repoUrl: string, dir?: string) {
  const targetDir = dir ?? "/workspace";
  console.log(`Cloning ${repoUrl} into ${machine}:${targetDir}...`);
  await cmdExec(machine, ["sh", "-c", `apk add git 2>/dev/null; git clone ${repoUrl} ${targetDir}`], ["--timeout", "120"]);
  console.log(`Cloned into ${machine}:${targetDir}`);
}

// ---------------------------------------------------------------------------
// Git workspace commands — init, status, log, commit, diff, merge
// ---------------------------------------------------------------------------

/** Execute a shell command inside a machine and return result. */
async function gitExec(
  machine: string,
  shellCmd: string,
  timeoutSecs = 30,
): Promise<{ exit_code: number; stdout: string; stderr: string }> {
  const resp = await apiCall(
    "POST",
    `/machines/${machine}/exec`,
    { command: ["sh", "-c", shellCmd], timeoutSecs: timeoutSecs },
    (timeoutSecs + 10) * 1000,
  );
  // deno-lint-ignore no-explicit-any
  const raw = await jsonResult<any>(resp);
  // API returns camelCase (exitCode) — normalize to snake_case
  return {
    exit_code: raw.exit_code ?? raw.exitCode ?? -1,
    stdout: raw.stdout ?? "",
    stderr: raw.stderr ?? "",
  };
}

/** Ensure /dev/vda is mounted at /storage (needed after clone/restart — init_commands only run on create). */
async function ensureStorageMounted(machine: string): Promise<void> {
  // Check if /dev/vda is actually mounted (not just if /storage dir exists)
  await gitExec(machine, "grep -q '/dev/vda' /proc/mounts 2>/dev/null || (mkdir -p /storage/workspace && mount /dev/vda /storage 2>/dev/null) || true");
  // Ensure /workspace symlink points to /storage/workspace
  await gitExec(machine, "mkdir -p /storage/workspace && (test -L /workspace || (rm -rf /workspace && ln -sfn /storage/workspace /workspace)) 2>/dev/null || true");
}

/** Resolve the git workspace path — prefers /storage/workspace (per-VM isolated), falls back to /workspace. */
async function resolveGitWorkspace(machine: string): Promise<string> {
  const r = await gitExec(machine, "test -d /storage/workspace/.git && echo /storage/workspace || (test -d /workspace/.git && echo /workspace || echo none)");
  return r.stdout.trim();
}

/** Check if workspace has a git repo. */
async function hasGitWorkspace(machine: string): Promise<boolean> {
  const ws = await resolveGitWorkspace(machine);
  return ws !== "none";
}

/** Get current branch name. */
async function gitCurrentBranch(machine: string): Promise<string> {
  const ws = await resolveGitWorkspace(machine);
  if (ws === "none") return "main";
  const r = await gitExec(machine, `git -C ${ws} rev-parse --abbrev-ref HEAD 2>/dev/null || echo main`);
  return r.stdout.trim() || "main";
}

/** Get the workspace path for git operations (resolve once, pass to functions). */
async function getGitWs(machine: string): Promise<string> {
  const ws = await resolveGitWorkspace(machine);
  if (ws === "none") throw new Error(`${machine} has no git workspace. Run: smolctl git init ${machine}`);
  return ws;
}

async function cmdGitInit(machine: string) {
  console.log(`Initializing git workspace in ${machine}:/storage/workspace...`);
  await gitExec(machine, [
    "git config --global user.name smolvm",
    "git config --global user.email smolvm@localhost",
    "git config --global --add safe.directory /storage/workspace",
    "git config --global --add safe.directory /workspace",
    "mkdir -p /storage/workspace",
    "cd /storage/workspace",
    "git init",
    "printf 'node_modules/\\n__pycache__/\\n*.pyc\\n.env\\n' > .gitignore",
    "git add -A",
    "git commit --allow-empty -m 'workspace init'",
  ].join(" && "));
  // Symlink /workspace -> /storage/workspace for compatibility
  await gitExec(machine, "ln -sfn /storage/workspace /workspace 2>/dev/null || true");
  console.log("Git workspace initialized at /storage/workspace (symlinked to /workspace).");
}

async function cmdGitStatus(machine: string) {
  const ws = await getGitWs(machine);
  const r = await gitExec(machine, `cd ${ws} && git status`);
  Deno.stdout.writeSync(new TextEncoder().encode(r.stdout));
}

async function cmdGitLog(machine: string, args: string[]) {
  const ws = await getGitWs(machine);
  const { flags } = parseFlags(args, ["n"]);
  const n = flag(flags, "n") ?? "20";
  const r = await gitExec(machine, `cd ${ws} && git log --oneline -${n}`);
  Deno.stdout.writeSync(new TextEncoder().encode(r.stdout));
}

async function cmdGitCommit(machine: string, args: string[]) {
  const ws = await getGitWs(machine);
  const { flags } = parseFlags(args, ["m"]);
  const msg = flag(flags, "m") ?? "auto-commit";
  const safeMsg = msg.replace(/'/g, "'\\''");
  const r = await gitExec(machine, `cd ${ws} && git add -A && git commit -m '${safeMsg}'`);
  Deno.stdout.writeSync(new TextEncoder().encode(r.stdout));
  if (r.exit_code !== 0 && r.stderr) {
    Deno.stderr.writeSync(new TextEncoder().encode(r.stderr));
  }
}

/**
 * Transfer a git bundle from source to target machine using the file API.
 * Returns the branch name in the source machine.
 */
async function gitBundleTransfer(source: string, target: string): Promise<string> {
  const srcWs = await getGitWs(source);

  // 1. Auto-commit any uncommitted changes in source
  await gitExec(source, `cd ${srcWs} && git add -A && git diff --cached --quiet || git commit -m 'auto-commit before merge' 2>/dev/null || true`);

  // 2. Get source branch name
  const srcBranch = await gitCurrentBranch(source);

  // 3. Create bundle in source
  const bundleResult = await gitExec(source, `cd ${srcWs} && git bundle create /tmp/merge.bundle --all 2>&1`, 60);
  if (bundleResult.exit_code !== 0) {
    die(`Failed to create bundle in ${source}: ${bundleResult.stderr || bundleResult.stdout}`);
  }

  // 4. Read bundle as base64 from source (strip newlines for clean base64)
  const readResult = await gitExec(source, "base64 /tmp/merge.bundle | tr -d '\\n'", 60);
  if (readResult.exit_code !== 0) {
    die(`Failed to read bundle from ${source}: ${readResult.stderr}`);
  }
  const b64 = readResult.stdout.trim();

  // 5. Write bundle to target via exec (decode base64 → file)
  // Split into chunks to avoid command-line length limits
  const chunkSize = 65536;
  for (let i = 0; i < b64.length; i += chunkSize) {
    const chunk = b64.slice(i, i + chunkSize);
    const op = i === 0 ? ">" : ">>";
    const writeResult = await gitExec(target, `printf '%s' '${chunk}' ${op} /tmp/merge.b64`, 30);
    if (writeResult.exit_code !== 0) {
      die(`Failed to write bundle chunk to ${target}: ${writeResult.stderr}`);
    }
  }
  const decodeResult = await gitExec(target, "base64 -d /tmp/merge.b64 > /tmp/merge.bundle && rm /tmp/merge.b64", 30);
  if (decodeResult.exit_code !== 0) {
    die(`Failed to decode bundle in ${target}: ${decodeResult.stderr}`);
  }

  // 6. Add bundle as remote in target and fetch
  const tgtWs = await getGitWs(target);
  const fetchResult = await gitExec(target, [
    `cd ${tgtWs}`,
    "git remote remove bundle-src 2>/dev/null || true",
    "git remote add bundle-src /tmp/merge.bundle",
    "git fetch bundle-src 2>&1",
  ].join(" && "), 60);
  if (fetchResult.exit_code !== 0) {
    die(`Failed to fetch bundle in ${target}: ${fetchResult.stderr || fetchResult.stdout}`);
  }

  return srcBranch;
}

async function cmdGitDiff(source: string, target: string) {
  if (!await hasGitWorkspace(source)) die(`${source} has no git workspace. Run: smolctl git init ${source}`);
  if (!await hasGitWorkspace(target)) die(`${target} has no git workspace. Run: smolctl git init ${target}`);

  const tgtWs = await getGitWs(target);
  console.log(`Diffing ${source} → ${target}...`);

  const srcBranch = await gitBundleTransfer(source, target);

  const statResult = await gitExec(target, `cd ${tgtWs} && git diff --stat HEAD...bundle-src/${srcBranch} 2>/dev/null || git diff --stat bundle-src/${srcBranch} 2>/dev/null`);
  if (statResult.stdout.trim()) {
    console.log("\n--- Diff summary ---");
    Deno.stdout.writeSync(new TextEncoder().encode(statResult.stdout));
  }

  const diffResult = await gitExec(target, `cd ${tgtWs} && git diff HEAD...bundle-src/${srcBranch} 2>/dev/null || git diff bundle-src/${srcBranch} 2>/dev/null`, 60);
  if (diffResult.stdout.trim()) {
    console.log("\n--- Full diff ---");
    Deno.stdout.writeSync(new TextEncoder().encode(diffResult.stdout));
  } else {
    console.log("No differences found.");
  }

  await gitExec(target, `cd ${tgtWs} && git remote remove bundle-src 2>/dev/null || true`);
}

async function cmdGitMerge(source: string, target: string, args: string[]) {
  const { flags } = parseFlags(args, ["branch", "strategy"]);
  const strategy = flag(flags, "strategy"); // "theirs" or "ours"

  // Verify both have git workspaces
  if (!await hasGitWorkspace(source)) die(`${source} has no git workspace. Run: smolctl git init ${source}`);
  if (!await hasGitWorkspace(target)) die(`${target} has no git workspace. Run: smolctl git init ${target}`);

  const tgtWs = await getGitWs(target);

  // Auto-commit uncommitted work in target too
  await gitExec(target, `cd ${tgtWs} && git add -A && git diff --cached --quiet || git commit -m 'auto-commit before merge' 2>/dev/null || true`);

  console.log(`Merging ${source} → ${target}...`);

  // Transfer bundle
  const srcBranch = flag(flags, "branch") || await gitBundleTransfer(source, target);
  if (!flag(flags, "branch")) {
    // Bundle already transferred above
  } else {
    await gitBundleTransfer(source, target);
  }
  const mergeBranch = flag(flags, "branch") || srcBranch;

  // Attempt merge
  const mergeResult = await gitExec(target, `cd ${tgtWs} && git merge bundle-src/${mergeBranch} --no-edit 2>&1`, 60);

  if (mergeResult.exit_code === 0) {
    // Clean merge
    console.log("Merge successful (clean).");
    const logResult = await gitExec(target, `cd ${tgtWs} && git log --oneline -5`);
    Deno.stdout.writeSync(new TextEncoder().encode(logResult.stdout));
  } else {
    // Conflicts
    const conflictResult = await gitExec(target, `cd ${tgtWs} && git diff --name-only --diff-filter=U 2>/dev/null`);
    const conflicts = conflictResult.stdout.trim().split("\n").filter(Boolean);

    if (conflicts.length > 0 && strategy === "theirs") {
      console.log(`Merge conflicts in ${conflicts.length} file(s) — auto-resolving with --strategy theirs...`);
      await gitExec(target, `cd ${tgtWs} && git checkout --theirs . && git add -A && git commit --no-edit -m 'merge: resolved with theirs strategy' 2>&1`);
      console.log("Merge completed (theirs strategy).");
    } else if (conflicts.length > 0 && strategy === "ours") {
      console.log(`Merge conflicts in ${conflicts.length} file(s) — auto-resolving with --strategy ours...`);
      await gitExec(target, `cd ${tgtWs} && git checkout --ours . && git add -A && git commit --no-edit -m 'merge: resolved with ours strategy' 2>&1`);
      console.log("Merge completed (ours strategy).");
    } else if (conflicts.length > 0) {
      console.log(`Merge has ${conflicts.length} conflict(s):`);
      for (const f of conflicts) console.log(`  CONFLICT: ${f}`);
      console.log("\nResolve manually with:");
      console.log(`  smolctl exec ${target} -- vi <file>`);
      console.log(`  smolctl git commit ${target} -m "resolve conflicts"`);
      console.log(`\nOr auto-resolve with:`);
      console.log(`  smolctl git merge ${source} ${target} --strategy theirs`);
    } else {
      // Non-conflict error
      console.error("Merge failed:");
      Deno.stderr.writeSync(new TextEncoder().encode(mergeResult.stdout));
    }
  }

  // Cleanup remote
  await gitExec(target, `cd ${tgtWs} && git remote remove bundle-src 2>/dev/null || true`);
}

// ---------------------------------------------------------------------------
// Fleet fan-out / gather
// ---------------------------------------------------------------------------

async function cmdFleetFanout(source: string, count: number, args: string[]) {
  if (!await hasGitWorkspace(source)) die(`${source} has no git workspace. Run: smolctl git init ${source}`);

  const srcWs = await getGitWs(source);

  // Auto-commit any uncommitted work
  await gitExec(source, `cd ${srcWs} && git add -A && git diff --cached --quiet || git commit -m 'auto-commit before fanout' 2>/dev/null || true`);

  // Flush source filesystem for consistent clones
  try { await gitExec(source, "sync", 5); } catch { /* best effort */ }

  const names: string[] = [];
  console.log(`Fanning out ${source} → ${count} clones...`);

  // Clone sequentially (each clone needs the source to exist)
  for (let i = 0; i < count; i++) {
    const cloneName = `${source}-fork-${i}`;
    names.push(cloneName);
    const resp = await apiCall("POST", `/machines/${source}/clone`, { name: cloneName });
    await jsonResult<Record<string, unknown>>(resp);
    console.log(`  cloned: ${cloneName}`);
  }

  // Start all in parallel
  console.log("Starting clones...");
  await Promise.allSettled(
    names.map(async (name) => {
      const resp = await apiCall("POST", `/machines/${name}/start`);
      await jsonResult<Record<string, unknown>>(resp);
      await ensureStorageMounted(name);
    }),
  );

  // Create branches in parallel
  console.log("Creating branches...");
  await Promise.allSettled(
    names.map(async (name) => {
      const ws = await getGitWs(name);
      await gitExec(name, `cd ${ws} && git checkout -b ${name}`);
    }),
  );

  console.log(`\nFan-out complete. ${count} clones ready:`);
  for (const name of names) console.log(`  ${name}`);
  console.log(`\nRun agents: smolctl exec <name> -- <command>`);
  console.log(`Gather:     smolctl fleet gather ${source}-fork --into ${source}`);
}

async function cmdFleetGather(prefix: string, target: string) {
  if (!await hasGitWorkspace(target)) die(`${target} has no git workspace. Run: smolctl git init ${target}`);

  const tgtWs = await getGitWs(target);

  // Find all machines matching prefix
  const resp = await apiCall("GET", "/machines");
  const data = await jsonResult<{ machines: { name: string; state: string }[] }>(resp);
  const forks = data.machines
    .filter((s) => s.name.startsWith(prefix) && s.name !== target)
    .sort((a, b) => a.name.localeCompare(b.name));

  if (forks.length === 0) {
    console.log(`No machines found matching prefix: ${prefix}`);
    return;
  }

  console.log(`Gathering ${forks.length} fork(s) into ${target}:`);
  const results: { name: string; status: string }[] = [];

  for (const fork of forks) {
    // Ensure running
    if (fork.state !== "running") {
      try {
        await apiCall("POST", `/machines/${fork.name}/start`);
        await new Promise((r) => setTimeout(r, 2000));
        await ensureStorageMounted(fork.name);
      } catch {
        results.push({ name: fork.name, status: "skip (could not start)" });
        continue;
      }
    }

    if (!await hasGitWorkspace(fork.name)) {
      results.push({ name: fork.name, status: "skip (no git workspace)" });
      continue;
    }

    // Auto-commit
    const forkWs = await getGitWs(fork.name);
    await gitExec(fork.name, `cd ${forkWs} && git add -A && git diff --cached --quiet || git commit -m 'auto-commit before gather' 2>/dev/null || true`);

    try {
      // Transfer bundle and merge
      const srcBranch = await gitBundleTransfer(fork.name, target);
      const mergeResult = await gitExec(target, `cd ${tgtWs} && git merge bundle-src/${srcBranch} --no-edit 2>&1`, 60);

      if (mergeResult.exit_code === 0) {
        results.push({ name: fork.name, status: "merged (clean)" });
      } else {
        // Auto-resolve with theirs (fan-out assumes each fork works on different things)
        await gitExec(target, `cd ${tgtWs} && git checkout --theirs . && git add -A && git commit --no-edit -m 'gather: auto-resolved' 2>&1`);
        results.push({ name: fork.name, status: "merged (auto-resolved conflicts)" });
      }
    } catch (e) {
      results.push({ name: fork.name, status: `failed: ${e}` });
    }

    // Cleanup remote
    await gitExec(target, `cd ${tgtWs} && git remote remove bundle-src 2>/dev/null || true`);
  }

  console.log("\nGather results:");
  for (const r of results) console.log(`  ${r.name}: ${r.status}`);
}

// ---------------------------------------------------------------------------
// Container commands
// ---------------------------------------------------------------------------

async function cmdContainerLs(machine: string) {
  const resp = await apiCall("GET", `/machines/${machine}/containers`);
  const data = await jsonResult<{ containers: Record<string, unknown>[] }>(resp);
  const rows = data.containers.map((c) => ({
    id: c.id,
    image: c.image,
    state: c.state,
    command: Array.isArray(c.command) ? (c.command as string[]).join(" ") : "-",
  }));
  table(rows, ["id", "image", "state", "command"]);
}

async function cmdContainerCreate(machine: string, image: string, args: string[]) {
  const { flags } = parseFlags(args, ["env", "workdir", "cmd"]);
  const body: Record<string, unknown> = { image };
  const cmds = flagAll(flags, "cmd");
  if (cmds.length > 0) body.command = cmds;
  const envPairs = flagAll(flags, "env").map((e) => {
    const [n, ...v] = e.split("=");
    return { name: n, value: v.join("=") };
  });
  if (envPairs.length > 0) body.env = envPairs;
  if (flag(flags, "workdir")) body.workdir = flag(flags, "workdir");

  const resp = await apiCall("POST", `/machines/${machine}/containers`, body, LONG_TIMEOUT_MS);
  const data = await jsonResult<Record<string, unknown>>(resp);
  console.log(`Created container: ${data.id} (${data.state})`);
}

async function cmdContainerStart(machine: string, containerId: string) {
  const resp = await apiCall("POST", `/machines/${machine}/containers/${containerId}/start`);
  await okOrDie(resp, "container start");
  console.log(`Started: ${containerId}`);
}

async function cmdContainerStop(machine: string, containerId: string) {
  const resp = await apiCall("POST", `/machines/${machine}/containers/${containerId}/stop`, { timeoutSecs: 10 });
  await okOrDie(resp, "container stop");
  console.log(`Stopped: ${containerId}`);
}

async function cmdContainerRm(machine: string, containerId: string, force: boolean) {
  const body = force ? { force: true } : undefined;
  const resp = await apiCall("DELETE", `/machines/${machine}/containers/${containerId}`, body);
  await okOrDie(resp, "container rm");
  console.log(`Deleted: ${containerId}`);
}

async function cmdContainerExec(machine: string, containerId: string, command: string[], args: string[]) {
  const { flags } = parseFlags(args, ["env", "workdir", "timeout"]);
  const body: Record<string, unknown> = {
    command,
    timeoutSecs: parseInt(flag(flags, "timeout") ?? "30"),
  };
  const envPairs = flagAll(flags, "env").map((e) => {
    const [n, ...v] = e.split("=");
    return { name: n, value: v.join("=") };
  });
  if (envPairs.length > 0) body.env = envPairs;
  if (flag(flags, "workdir")) body.workdir = flag(flags, "workdir");

  const resp = await apiCall("POST", `/machines/${machine}/containers/${containerId}/exec`, body);
  const data = await jsonResult<{ exit_code: number; stdout: string; stderr: string }>(resp);
  if (data.stdout) Deno.stdout.writeSync(new TextEncoder().encode(data.stdout));
  if (data.stderr) Deno.stderr.writeSync(new TextEncoder().encode(data.stderr));
  if (data.exit_code !== 0) Deno.exit(data.exit_code);
}

// ---------------------------------------------------------------------------
// Debug commands
// ---------------------------------------------------------------------------
// MCP commands
// ---------------------------------------------------------------------------

async function cmdMcpTools(machine: string) {
  // Get configured MCP servers from the Rust API
  const serversResp = await apiCall("GET", `/machines/${machine}/mcp/servers`);
  const servers = await jsonResult<Array<{ name: string; command: string[]; workdir?: string }>>(serversResp);

  if (servers.length === 0) {
    console.log("No MCP servers configured. Use --with-mcp when creating machine.");
    return;
  }

  // CLI-side tool discovery via exec (bypasses Rust MCP handler which has a parsing issue)
  const allTools: Array<{ server: string; name: string; description: string }> = [];
  const statuses: Array<{ name: string; running: boolean; tool_count: number }> = [];

  for (const server of servers) {
    const initMsg = JSON.stringify({jsonrpc:"2.0",id:1,method:"initialize",params:{protocolVersion:"2024-11-05",capabilities:{},clientInfo:{name:"smolvm",version:"1.0"}}});
    const listMsg = JSON.stringify({jsonrpc:"2.0",id:2,method:"tools/list",params:{}});
    const cmdStr = server.command.map(s => s.includes(" ") ? `'${s}'` : s).join(" ");
    const shellCmd = `printf '${initMsg}\\n${listMsg}\\n' | timeout 30 ${cmdStr} 2>/dev/null`;

    try {
      const execResp = await apiCall("POST", `/machines/${machine}/exec`, {
        command: ["sh", "-c", shellCmd],
        timeoutSecs: 35,
      }, 40_000);
      const execData = await jsonResult<{ exit_code?: number; exitCode?: number; stdout: string; stderr: string }>(execResp);
      const stdout = execData.stdout || "";

      // Parse JSON-RPC responses line by line
      const lines = stdout.split("\n").filter(l => l.trim());
      const responses = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

      // Second response is tools/list
      const toolsResp = responses[1];
      const toolList = toolsResp?.result?.tools || [];

      for (const tool of toolList) {
        allTools.push({
          server: server.name,
          name: tool.name || "unknown",
          description: tool.description || "",
        });
      }
      statuses.push({ name: server.name, running: true, tool_count: toolList.length });
    } catch (e) {
      statuses.push({ name: server.name, running: false, tool_count: 0 });
      console.error(`  ${server.name}: error — ${e}`);
    }
  }

  console.log("Servers:");
  for (const s of statuses) {
    console.log(`  ${s.name}: ${s.running ? "ok" : "error"} (${s.tool_count} tools)`);
  }
  console.log();

  if (allTools.length === 0) {
    console.log("No MCP tools discovered.");
  } else {
    table(allTools, ["server", "name", "description"]);
  }
}

async function cmdMcpCall(machine: string, server: string, tool: string, argsJson: string) {
  let toolArgs: unknown;
  try {
    toolArgs = JSON.parse(argsJson);
  } catch {
    die(`invalid JSON arguments: ${argsJson}`);
  }

  // Get server config
  const serversResp = await apiCall("GET", `/machines/${machine}/mcp/servers`);
  const servers = await jsonResult<Array<{ name: string; command: string[]; workdir?: string }>>(serversResp);
  const serverConfig = servers.find(s => s.name === server);
  if (!serverConfig) die(`MCP server '${server}' not configured. Available: ${servers.map(s => s.name).join(", ")}`);

  // CLI-side tool call via exec
  const initMsg = JSON.stringify({jsonrpc:"2.0",id:1,method:"initialize",params:{protocolVersion:"2024-11-05",capabilities:{},clientInfo:{name:"smolvm",version:"1.0"}}});
  const callMsg = JSON.stringify({jsonrpc:"2.0",id:2,method:"tools/call",params:{name:tool,arguments:toolArgs}});
  const cmdStr = serverConfig.command.map((s: string) => s.includes(" ") ? `'${s}'` : s).join(" ");
  const shellCmd = `printf '${initMsg}\\n${callMsg}\\n' | timeout 60 ${cmdStr} 2>/dev/null`;

  const execResp = await apiCall("POST", `/machines/${machine}/exec`, {
    command: ["sh", "-c", shellCmd],
    timeoutSecs: 65,
  }, 70_000);
  const execData = await jsonResult<{ exit_code?: number; exitCode?: number; stdout: string; stderr: string }>(execResp);

  const lines = (execData.stdout || "").split("\n").filter(l => l.trim());
  const responses = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const callResp = responses[1];

  if (!callResp) {
    console.error("MCP server returned no response for tool call");
    Deno.exit(1);
  }

  if (callResp.error) {
    console.error(`Tool call error: ${callResp.error.message}`);
    Deno.exit(1);
  }

  const result = callResp.result || {};
  const isError = result.isError || false;
  if (isError) console.error("Tool call returned an error:");
  console.log(JSON.stringify(result.content || [], null, 2));
  if (isError) Deno.exit(1);
}

async function cmdMcpServers(machine: string) {
  const resp = await apiCall("GET", `/machines/${machine}/mcp/servers`);
  const data = await jsonResult<Array<{ name: string; command: string[]; workdir?: string }>>(resp);
  if (data.length === 0) {
    console.log("No MCP servers configured.");
  } else {
    table(data.map(s => ({ name: s.name, command: s.command.join(" "), workdir: s.workdir ?? "" })), ["name", "command", "workdir"]);
  }
}

// ---------------------------------------------------------------------------

/** Push built-in MCP server scripts into a running machine via file API. */
async function cmdMcpInstall(machine: string) {
  const mcpFiles = ["filesystem.sh", "exec.sh", "git.sh"];

  // Resolve the path to mcp-servers/ relative to this CLI script
  const candidates = [
    new URL("../mcp-servers", import.meta.url).pathname,
    `${Deno.cwd()}/mcp-servers`,
    `${Deno.cwd()}/container-experiments/CX04-smolvm/mcp-servers`,
  ];

  let mcpDir: string | null = null;
  for (const dir of candidates) {
    try {
      const stat = await Deno.stat(dir);
      if (stat.isDirectory) { mcpDir = dir; break; }
    } catch { /* try next */ }
  }
  if (!mcpDir) {
    die("Could not find mcp-servers/ directory. Run from the CX04-smolvm project root or alongside the CLI.");
  }

  // Create target directory in the machine
  const mkdirResp = await apiCall("POST", `/machines/${machine}/exec`, {
    command: ["mkdir", "-p", "/opt/smolvm/mcp-servers"],
    timeoutSecs: 10,
  });
  await okOrDie(mkdirResp, "mkdir");

  for (const file of mcpFiles) {
    const contentBytes = await Deno.readFile(`${mcpDir}/${file}`);
    // Chunk-safe base64 encoding (btoa can't handle non-Latin1 or large spreads)
    let binary = "";
    for (let i = 0; i < contentBytes.length; i++) binary += String.fromCharCode(contentBytes[i]);
    const encoded = btoa(binary);
    const encodedPath = encodeURIComponent(`/opt/smolvm/mcp-servers/${file}`);
    const resp = await apiCall("PUT", `/machines/${machine}/files/${encodedPath}`, { content: encoded });
    await okOrDie(resp, `write ${file}`);
    console.log(`  installed: /opt/smolvm/mcp-servers/${file}`);
  }

  // Make scripts executable
  const chmodResp = await apiCall("POST", `/machines/${machine}/exec`, {
    command: ["chmod", "+x", ...mcpFiles.map((s) => `/opt/smolvm/mcp-servers/${s}`)],
    timeoutSecs: 10,
  });
  await okOrDie(chmodResp, "chmod");

  console.log(`\nInstalled ${mcpFiles.length} MCP servers in machine '${machine}'.`);
  console.log("Use --with-mcp on create/up to auto-configure them, or add via --mcp flags.");
}

// ---------------------------------------------------------------------------

async function cmdDebugMounts(machine: string) {
  const resp = await apiCall("GET", `/machines/${machine}/debug/mounts`);
  const data = await jsonResult<{
    configured: { tag: string; source: string; target: string; readonly: boolean }[];
    guest_mounts: string;
    mnt_listing: string;
    virtiofs_supported: boolean;
  }>(resp);

  console.log(`=== Mount Diagnostics: ${machine} ===\n`);
  console.log(`virtiofs supported: ${data.virtiofs_supported}\n`);

  if (data.configured.length > 0) {
    console.log("Configured mounts:");
    table(data.configured.map((m) => ({
      tag: m.tag,
      source: m.source,
      target: m.target,
      readonly: m.readonly ? "yes" : "no",
    })), ["tag", "source", "target", "readonly"]);
  } else {
    console.log("Configured mounts: (none)\n");
  }

  console.log("\nGuest /proc/mounts (filtered):");
  console.log(data.guest_mounts || "(empty)");
  console.log("\nGuest /mnt/ listing:");
  console.log(data.mnt_listing || "(empty)");
}

async function cmdDebugNetwork(machine: string) {
  const resp = await apiCall("GET", `/machines/${machine}/debug/network`);
  const data = await jsonResult<{
    configured_ports: { host: number; guest: number }[];
    listening_ports: string;
    interfaces: string;
    network_enabled: boolean;
  }>(resp);

  console.log(`=== Network Diagnostics: ${machine} ===\n`);
  console.log(`network enabled: ${data.network_enabled}\n`);

  if (data.configured_ports.length > 0) {
    console.log("Configured port mappings:");
    table(data.configured_ports.map((p) => ({
      host: p.host,
      guest: p.guest,
    })), ["host", "guest"]);
  } else {
    console.log("Configured port mappings: (none)\n");
  }

  console.log("\nListening ports:");
  console.log(data.listening_ports || "(none)");
  console.log("\nNetwork interfaces:");
  console.log(data.interfaces || "(none)");
}

async function cmdDnsStatus(machine: string) {
  const resp = await apiCall("GET", `/machines/${machine}/dns`);
  const data = await jsonResult<{ active: boolean; allowed_domains: string[] }>(resp);

  console.log(`=== DNS Filter Status: ${machine} ===\n`);
  console.log(`active: ${data.active}`);
  if (data.active && data.allowed_domains.length > 0) {
    console.log(`allowed domains: ${data.allowed_domains.join(", ")}`);
  } else if (!data.active) {
    console.log("(no DNS egress filtering — all domains can resolve)");
  }
}

// ---------------------------------------------------------------------------
// Agent commands
// ---------------------------------------------------------------------------

/** Resolve OAuth token from: --oauth-token flag, env var, or stdin (if "-"). */
async function resolveOAuthToken(flags: Record<string, string[]>): Promise<string | undefined> {
  const flagVal = flag(flags, "oauth-token");
  if (flagVal && flagVal !== "-") return flagVal.trim();
  if (flagVal === "-") {
    // Read from stdin (pipe)
    const buf = new Uint8Array(4096);
    const n = await Deno.stdin.read(buf);
    if (n && n > 0) return new TextDecoder().decode(buf.subarray(0, n)).trim();
    return undefined;
  }
  return Deno.env.get("CLAUDE_CODE_OAUTH_TOKEN")?.trim();
}

/** Generate a short random suffix for agent machine names. */
function agentId(): string {
  return Math.random().toString(36).slice(2, 8);
}

async function cmdAgentRun(prompt: string, args: string[]) {
  const { flags } = parseFlags(args, [
    "cpus", "memory", "secret", "starter", "name", "timeout", "keep", "user", "workdir", "json", "status", "label", "owner", "description", "setup", "machine", "oauth-token",
  ]);

  const name = flag(flags, "name") ?? `agent-${agentId()}`;
  const starter = flag(flags, "starter") ?? "claude-code";
  const secrets = flagAll(flags, "secret");
  // If using OAuth token (subscription mode), skip default anthropic secret
  const oauthToken = await resolveOAuthToken(flags);
  if (secrets.length === 0 && !oauthToken) secrets.push("anthropic"); // default: anthropic
  const timeoutSecs = parseInt(flag(flags, "timeout") ?? "300");
  const keep = hasFlag(flags, "keep");
  const outputJson = hasFlag(flags, "json");
  const streaming = hasFlag(flags, "status") || outputJson;
  const ts = () => new Date().toISOString();

  // 1. Create machine
  if (streaming) emitStatus({ status: "queued", timestamp: ts(), machine: name, details: { starter, secrets } });
  if (!outputJson) console.log(`Creating agent machine: ${name} (starter: ${starter})`);
  const createOpts: Record<string, unknown> = {
    name,
    from_starter: starter,
    resources: {
      cpus: parseInt(flag(flags, "cpus") ?? "4"),
      memoryMb: parseInt(flag(flags, "memory") ?? "2048"),
      network: true,
    },
    secrets,
  };
  if (flag(flags, "user")) createOpts.default_user = flag(flags, "user");

  const t0 = Date.now();
  const createResp = await apiCall("POST", "/machines", createOpts, LONG_TIMEOUT_MS);
  await jsonResult<Record<string, unknown>>(createResp);
  await recordSession({ timestamp: ts(), machine: name, action: "create", duration_ms: Date.now() - t0, details: { starter, secrets } });

  // Save metadata
  await saveMeta({
    name,
    owner: flag(flags, "owner") ?? Deno.env.get("USER") ?? "unknown",
    labels: parseLabels(flags),
    description: flag(flags, "description") ?? `agent run: ${prompt.slice(0, 100)}`,
    created_at: ts(),
    starter,
    secrets,
  });

  // 2. Start
  if (streaming) emitStatus({ status: "preparing", timestamp: ts(), machine: name });
  if (!outputJson) console.log("Starting machine...");
  const t1 = Date.now();
  const startResp = await apiCall("POST", `/machines/${name}/start`);
  await jsonResult<Record<string, unknown>>(startResp);
  await recordSession({ timestamp: ts(), machine: name, action: "start", duration_ms: Date.now() - t1 });

  // Post-start setup hooks
  const setupCmds = flagAll(flags, "setup");
  for (const cmd of setupCmds) {
    if (!outputJson) console.log(`[setup] ${cmd}`);
    const setupResp = await apiCall("POST", `/machines/${name}/exec`, {
      command: ["sh", "-c", cmd], timeoutSecs: 120,
    }, 130_000);
    const setupResult = await jsonResult<{ exit_code?: number; exitCode?: number; stdout: string; stderr: string }>(setupResp);
    if ((setupResult.exit_code ?? setupResult.exitCode ?? -1) !== 0) {
      die(`Setup command failed: ${cmd}`);
    }
  }

  // 3. Write machine settings + run claude with prompt
  const machinePreset = flag(flags, "machine") ?? "permissive";
  const machineConfig = resolveMachineConfig(machinePreset);
  const settingsPath = await writeAgentSettings(name, machineConfig);
  if (!outputJson) console.log(`Machine: ${SANDBOX_PRESETS[machinePreset] ? machinePreset : "custom"} (${machineConfig.allow.length} allow rules)`);

  if (streaming) emitStatus({ status: "running", timestamp: ts(), machine: name, details: { timeoutSecs: timeoutSecs } });
  if (!outputJson) console.log(`Running agent (timeout: ${timeoutSecs}s)...\n`);
  const execBody: Record<string, unknown> = {
    command: ["claude", "-p", "--settings", settingsPath, "--output-format", "text", prompt],
    timeoutSecs: timeoutSecs,
  };
  // Inject OAuth token for subscription auth (no API key needed)
  if (oauthToken) {
    execBody.env = [{ name: "CLAUDE_CODE_OAUTH_TOKEN", value: oauthToken }];
    if (!outputJson) console.log("Auth: subscription (OAuth token)");
  }
  if (flag(flags, "workdir")) execBody.workdir = flag(flags, "workdir");
  if (flag(flags, "user")) execBody.user = flag(flags, "user");

  const t2 = Date.now();
  const clientTimeout = (timeoutSecs + 10) * 1000;
  const execResp = await apiCall("POST", `/machines/${name}/exec`, execBody, clientTimeout);
  const result = await jsonResult<{ exit_code?: number; exitCode?: number; stdout: string; stderr: string }>(execResp);
  const exitCode = result.exit_code ?? result.exitCode ?? -1;
  await recordSession({ timestamp: ts(), machine: name, action: "exec", duration_ms: Date.now() - t2, details: { prompt: prompt.slice(0, 200), exit_code: exitCode } });

  if (streaming) {
    const status = exitCode === 0 ? "completed" : "failed";
    emitStatus({ status, timestamp: ts(), machine: name, details: { exit_code: exitCode }, error: exitCode !== 0 ? result.stderr?.slice(0, 500) : undefined });
  }

  if (outputJson) {
    console.log(JSON.stringify({ machine: name, exit_code: exitCode, stdout: result.stdout, stderr: result.stderr }));
  } else {
    if (result.stdout) Deno.stdout.writeSync(new TextEncoder().encode(result.stdout));
    if (result.stderr) Deno.stderr.writeSync(new TextEncoder().encode(result.stderr));
  }

  // 4. Cleanup (unless --keep)
  if (!keep) {
    if (!outputJson) console.log(`\nCleaning up machine: ${name}`);
    try { await apiCall("POST", `/machines/${name}/stop`); } catch { /* ok */ }
    try { await apiCall("DELETE", `/machines/${name}?force=true`); } catch { /* ok */ }
    await deleteMeta(name);
    await recordSession({ timestamp: ts(), machine: name, action: "cleanup" });
  } else if (!outputJson) {
    console.log(`\nMachine kept alive: ${name}`);
    console.log(`  Inspect: smolctl sh ${name} "ls /workspace"`);
    console.log(`  Cleanup: smolctl down ${name}`);
  }

  checkPermissionDenials(exitCode, result.stdout, result.stderr, name, outputJson);
  if (exitCode !== 0) Deno.exit(exitCode);
}

async function cmdAgentFleet(prefix: string, promptsFile: string, args: string[]) {
  const { flags } = parseFlags(args, [
    "cpus", "memory", "secret", "starter", "timeout", "keep", "user", "workdir", "json", "machine", "oauth-token",
  ]);

  // Read prompts file: one prompt per line (blank lines skipped)
  let promptText: string;
  try {
    promptText = await Deno.readTextFile(promptsFile);
  } catch {
    die(`Cannot read prompts file: ${promptsFile}`);
  }
  const prompts = promptText.split("\n").map((l) => l.trim()).filter((l) => l.length > 0 && !l.startsWith("#"));
  if (prompts.length === 0) die("No prompts found in file (blank lines and # comments are skipped)");

  const starter = flag(flags, "starter") ?? "claude-code";
  const secrets = flagAll(flags, "secret");
  const oauthToken = await resolveOAuthToken(flags);
  if (secrets.length === 0 && !oauthToken) secrets.push("anthropic");
  const timeoutSecs = parseInt(flag(flags, "timeout") ?? "300");
  const keep = hasFlag(flags, "keep");
  const outputJson = hasFlag(flags, "json");
  const count = prompts.length;

  console.log(`Dispatching ${count} agent(s) with prefix "${prefix}"...`);

  // 1. Create all machines
  const names: string[] = [];
  for (let i = 0; i < count; i++) {
    const name = `${prefix}-${i}`;
    names.push(name);
    const createOpts: Record<string, unknown> = {
      name,
      from_starter: starter,
      resources: {
        cpus: parseInt(flag(flags, "cpus") ?? "2"),
        memoryMb: parseInt(flag(flags, "memory") ?? "2048"),
        network: true,
      },
      secrets,
    };
    if (flag(flags, "user")) createOpts.default_user = flag(flags, "user");
    const resp = await apiCall("POST", "/machines", createOpts, LONG_TIMEOUT_MS);
    await jsonResult<Record<string, unknown>>(resp);
    console.log(`  created: ${name}`);
  }

  // 2. Start all in parallel
  console.log("Starting all machines...");
  await Promise.allSettled(
    names.map(async (name) => {
      const resp = await apiCall("POST", `/machines/${name}/start`);
      await jsonResult<Record<string, unknown>>(resp);
    }),
  );

  // 3. Write machine settings to all machines + dispatch prompts
  const machinePreset = flag(flags, "machine") ?? "permissive";
  const machineConfig = resolveMachineConfig(machinePreset);
  const settingsPaths: Record<string, string> = {};
  for (const name of names) {
    settingsPaths[name] = await writeAgentSettings(name, machineConfig);
  }

  console.log("Running agents...\n");
  const clientTimeout = (timeoutSecs + 10) * 1000;
  const results = await Promise.allSettled(
    names.map(async (name, i) => {
      const execBody: Record<string, unknown> = {
        command: ["claude", "-p", "--settings", settingsPaths[name], "--output-format", "text", prompts[i]],
        timeoutSecs: timeoutSecs,
      };
      if (oauthToken) execBody.env = [{ name: "CLAUDE_CODE_OAUTH_TOKEN", value: oauthToken }];
      if (flag(flags, "workdir")) execBody.workdir = flag(flags, "workdir");
      if (flag(flags, "user")) execBody.user = flag(flags, "user");

      const resp = await apiCall("POST", `/machines/${name}/exec`, execBody, clientTimeout);
      const d = await jsonResult<{ exit_code?: number; exitCode?: number; stdout: string; stderr: string }>(resp);
      return { name, prompt: prompts[i], exit_code: d.exit_code ?? d.exitCode ?? -1, stdout: d.stdout, stderr: d.stderr };
    }),
  );

  // 4. Print results
  for (const r of results) {
    if (r.status === "fulfilled") {
      const { name, prompt, exit_code, stdout, stderr } = r.value;
      if (outputJson) {
        console.log(JSON.stringify({ machine: name, prompt, exit_code, stdout, stderr }));
      } else {
        console.log(`\n${"═".repeat(60)}`);
        console.log(`Agent: ${name} (exit: ${exit_code})`);
        console.log(`Prompt: ${prompt.slice(0, 80)}${prompt.length > 80 ? "..." : ""}`);
        console.log("─".repeat(60));
        if (stdout) Deno.stdout.writeSync(new TextEncoder().encode(stdout));
        if (stderr) Deno.stderr.writeSync(new TextEncoder().encode(stderr));
      }
    } else {
      console.error(`\nAgent ERROR: ${r.reason}`);
    }
  }

  // 5. Cleanup
  if (!keep) {
    console.log(`\nCleaning up fleet "${prefix}"...`);
    await Promise.allSettled(
      names.map(async (name) => {
        try { const r = await apiCall("POST", `/machines/${name}/stop`); await r.text(); } catch { /* ok */ }
        try { const r = await apiCall("DELETE", `/machines/${name}?force=true`); await r.text(); } catch { /* ok */ }
      }),
    );
  } else {
    console.log(`\nMachinees kept alive. Cleanup: smolctl fleet down ${prefix}`);
  }
}

async function cmdAgentMerge(source: string, target: string, args: string[]) {
  const { flags } = parseFlags(args, ["strategy", "files"]);
  const strategy = flag(flags, "strategy") ?? "theirs";
  const files = flagAll(flags, "files");

  const body: Record<string, unknown> = { strategy };
  if (files.length > 0) body.files = files;

  console.log(`Merging ${source} → ${target} (strategy: ${strategy})`);
  const resp = await apiCall("POST", `/machines/${source}/merge/${target}`, body);
  const data = await jsonResult<{ merged_files: string[]; skipped_files: string[] }>(resp);
  console.log(`  merged: ${data.merged_files.length} file(s)`);
  for (const f of data.merged_files) console.log(`    ${f}`);
  if (data.skipped_files.length > 0) {
    console.log(`  skipped: ${data.skipped_files.length} file(s)`);
    for (const f of data.skipped_files) console.log(`    ${f}`);
  }
}

async function cmdAgentCollect(prefix: string, args: string[]) {
  const { flags } = parseFlags(args, ["to", "strategy", "dir"]);
  const targetDir = flag(flags, "to") ?? ".";
  const dir = flag(flags, "dir") ?? "/workspace";

  // Find all fleet machines
  const resp = await apiCall("GET", "/machines");
  const data = await jsonResult<{ machines: { name: string; state: string }[] }>(resp);
  const matches = data.machines
    .filter((s) => s.name.startsWith(`${prefix}-`))
    .sort((a, b) => a.name.localeCompare(b.name));

  if (matches.length === 0) {
    die(`No machines matching prefix "${prefix}".`);
  }

  console.log(`Collecting results from ${matches.length} agent(s) to ${targetDir}/`);

  for (const s of matches) {
    const outDir = `${targetDir}/${s.name}`;
    // Download archive from machine
    const archiveResp = await fetch(
      `${API}/machines/${s.name}/archive?dir=${encodeURIComponent(dir)}`,
      { headers: authHeaders() },
    );
    if (!archiveResp.ok) {
      // Fallback: use exec tar if archive endpoint fails
      console.log(`  ${s.name}: using exec fallback...`);
      const tarResp = await apiCall("POST", `/machines/${s.name}/exec`, {
        command: ["sh", "-c", `tar czf - -C ${dir} . | base64`],
        timeoutSecs: 60,
      }, 70_000);
      const tarData = await jsonResult<{ stdout: string; stderr: string }>(tarResp);
      // Save base64-encoded tar
      await Deno.mkdir(outDir, { recursive: true });
      const proc = new Deno.Command("sh", {
        args: ["-c", `echo '${tarData.stdout.trim()}' | base64 -d | tar xzf - -C '${outDir}'`],
      });
      const { code } = await proc.output();
      if (code === 0) console.log(`  ${s.name}: extracted to ${outDir}/`);
      else console.error(`  ${s.name}: extract failed`);
      continue;
    }

    // Direct archive download worked
    const archiveBytes = new Uint8Array(await archiveResp.arrayBuffer());
    await Deno.mkdir(outDir, { recursive: true });
    const tmpTar = `${outDir}/.tmp-archive.tar.gz`;
    await Deno.writeFile(tmpTar, archiveBytes);
    const proc = new Deno.Command("tar", { args: ["xzf", tmpTar, "-C", outDir] });
    const { code } = await proc.output();
    try { await Deno.remove(tmpTar); } catch { /* ok */ }
    if (code === 0) console.log(`  ${s.name}: extracted to ${outDir}/`);
    else console.error(`  ${s.name}: extract failed`);
  }
  console.log("Done.");
}

// ---------------------------------------------------------------------------
// Agent worker (poll-based job execution)
// ---------------------------------------------------------------------------

/**
 * Agent worker: creates (or reuses) a machine, then enters a poll loop
 * claiming jobs from the work queue and executing them inside the machine.
 *
 * Usage: smolctl agent worker [flags]
 *   --name <name>         machine name (default: worker-<id>)
 *   --starter <name>      starter to use (default: claude-code)
 *   --secret <name>       secret to enable (repeatable, default: anthropic)
 *   --poll-interval <sec> seconds between polls (default: 5)
 *   --max-jobs <n>        exit after N jobs (default: unlimited, 0)
 *   --keep                keep machine alive after worker exits
 *   --status              emit NDJSON status events to stderr
 *   --reuse <name>        reuse existing machine instead of creating one
 */
async function cmdAgentWorker(args: string[]) {
  const { flags } = parseFlags(args, [
    "name", "starter", "secret", "cpus", "memory", "poll-interval", "max-jobs",
    "keep", "status", "reuse", "user", "setup", "machine",
  ]);

  const reuse = flag(flags, "reuse");
  const name = reuse ?? flag(flags, "name") ?? `worker-${agentId()}`;
  const starter = flag(flags, "starter") ?? "claude-code";
  const secrets = flagAll(flags, "secret");
  if (secrets.length === 0) secrets.push("anthropic");
  const pollInterval = parseInt(flag(flags, "poll-interval") ?? "5") * 1000;
  const maxJobs = parseInt(flag(flags, "max-jobs") ?? "0");
  const keep = hasFlag(flags, "keep");
  const streaming = hasFlag(flags, "status");
  const ts = () => new Date().toISOString();

  // Create or verify machine
  if (!reuse) {
    if (streaming) emitStatus({ status: "queued", timestamp: ts(), machine: name, details: { starter, secrets, mode: "worker" } });
    console.log(`Creating worker machine: ${name} (starter: ${starter})`);
    const createOpts: Record<string, unknown> = {
      name,
      from_starter: starter,
      resources: {
        cpus: parseInt(flag(flags, "cpus") ?? "4"),
        memoryMb: parseInt(flag(flags, "memory") ?? "2048"),
        network: true,
      },
      secrets,
    };
    if (flag(flags, "user")) createOpts.default_user = flag(flags, "user");

    const createResp = await apiCall("POST", "/machines", createOpts, LONG_TIMEOUT_MS);
    await jsonResult<Record<string, unknown>>(createResp);

    if (streaming) emitStatus({ status: "preparing", timestamp: ts(), machine: name });
    const startResp = await apiCall("POST", `/machines/${name}/start`);
    await jsonResult<Record<string, unknown>>(startResp);

    // Post-start setup hooks
    for (const cmd of flagAll(flags, "setup")) {
      console.log(`[setup] ${cmd}`);
      const setupResp = await apiCall("POST", `/machines/${name}/exec`, {
        command: ["sh", "-c", cmd], timeoutSecs: 120,
      }, 130_000);
      const setupResult = await jsonResult<{ exit_code?: number; exitCode?: number }>(setupResp);
      if ((setupResult.exit_code ?? setupResult.exitCode ?? -1) !== 0) die(`Setup failed: ${cmd}`);
    }
  } else {
    console.log(`Reusing existing machine: ${name}`);
  }

  // Write machine settings for agent permission control
  const machinePreset = flag(flags, "machine") ?? "permissive";
  const machineConfig = resolveMachineConfig(machinePreset);
  const workerSettingsPath = await writeAgentSettings(name, machineConfig);
  console.log(`Machine: ${SANDBOX_PRESETS[machinePreset] ? machinePreset : "custom"} (settings at ${workerSettingsPath})`);

  if (streaming) emitStatus({ status: "running", timestamp: ts(), machine: name, details: { mode: "worker", poll_interval_ms: pollInterval } });
  console.log(`Worker polling for jobs (interval: ${pollInterval / 1000}s, max: ${maxJobs || "unlimited"})...`);

  let completed = 0;
  let running = true;

  // Handle Ctrl+C gracefully
  const cleanup = async () => {
    running = false;
    console.log("\nWorker shutting down...");
    if (!keep && !reuse) {
      try { await apiCall("POST", `/machines/${name}/stop`); } catch { /* ok */ }
      try { await apiCall("DELETE", `/machines/${name}?force=true`); } catch { /* ok */ }
      console.log(`Machine ${name} cleaned up.`);
    }
  };
  Deno.addSignalListener("SIGINT", () => { cleanup().then(() => Deno.exit(0)); });

  while (running) {
    // Poll for a job
    const pollResp = await apiCall("POST", "/jobs/poll");
    if (pollResp.status === 204) {
      await new Promise((r) => setTimeout(r, pollInterval));
      continue;
    }

    const job = await jsonResult<{
      id: string; machine: string; command: string[]; workdir?: string;
      timeoutSecs: number; env?: { name: string; value: string }[];
    }>(pollResp);

    // Check if job targets this machine (or any)
    if (job.machine !== name && job.machine !== "*") {
      // Job is for a different machine — we already claimed it, so fail it back
      await apiCall("POST", `/jobs/${job.id}/fail`, { error: `claimed by wrong worker (wanted ${job.machine}, got ${name})` });
      continue;
    }

    console.log(`[job ${job.id}] Executing: ${job.command.join(" ")}`);
    if (streaming) emitStatus({ status: "running", timestamp: ts(), machine: name, details: { job_id: job.id, command: job.command } });
    await recordSession({ timestamp: ts(), machine: name, action: "job_exec", details: { job_id: job.id, command: job.command } });

    // Execute the job command inside the machine
    // Inject --settings for claude commands so they run with machine permissions
    const jobCmd = [...job.command];
    if (jobCmd[0] === "claude" && !jobCmd.includes("--settings")) {
      const pIdx = jobCmd.indexOf("-p");
      const insertAt = pIdx >= 0 ? pIdx + 1 : 1;
      jobCmd.splice(insertAt, 0, "--settings", workerSettingsPath);
    }
    const execBody: Record<string, unknown> = {
      command: jobCmd,
      timeoutSecs: job.timeout_secs,
    };
    if (job.workdir) execBody.workdir = job.workdir;
    if (job.env && job.env.length > 0) execBody.env = job.env;

    try {
      const clientTimeout = (job.timeout_secs + 10) * 1000;
      const execResp = await apiCall("POST", `/machines/${name}/exec`, execBody, clientTimeout);
      const result = await jsonResult<{ exit_code?: number; exitCode?: number; stdout: string; stderr: string }>(execResp);
      const exitCode = result.exit_code ?? result.exitCode ?? -1;

      // Complete or fail the job
      if (exitCode === 0) {
        await apiCall("POST", `/jobs/${job.id}/complete`, {
          exit_code: exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
        });
        console.log(`[job ${job.id}] Completed (exit: ${exitCode})`);
        if (streaming) emitStatus({ status: "completed", timestamp: ts(), machine: name, details: { job_id: job.id, exit_code: exitCode } });
      } else {
        await apiCall("POST", `/jobs/${job.id}/fail`, { error: `exit code ${exitCode}: ${result.stderr?.slice(0, 500)}` });
        console.log(`[job ${job.id}] Failed (exit: ${exitCode})`);
        if (streaming) emitStatus({ status: "failed", timestamp: ts(), machine: name, details: { job_id: job.id, exit_code: exitCode }, error: result.stderr?.slice(0, 500) });
      }

      await recordSession({ timestamp: ts(), machine: name, action: "job_complete", details: { job_id: job.id, exit_code: exitCode } });
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      await apiCall("POST", `/jobs/${job.id}/fail`, { error: errMsg });
      console.error(`[job ${job.id}] Error: ${errMsg}`);
    }

    completed++;
    if (maxJobs > 0 && completed >= maxJobs) {
      console.log(`Reached max jobs (${maxJobs}). Exiting.`);
      break;
    }
  }

  if (streaming) emitStatus({ status: "completed", timestamp: ts(), machine: name, details: { jobs_completed: completed, mode: "worker" } });

  if (!keep && !reuse) {
    console.log(`Cleaning up machine: ${name}`);
    try { await apiCall("POST", `/machines/${name}/stop`); } catch { /* ok */ }
    try { await apiCall("DELETE", `/machines/${name}?force=true`); } catch { /* ok */ }
  } else {
    console.log(`Machine kept alive: ${name}`);
  }
}

// ---------------------------------------------------------------------------
// Fleet commands
// ---------------------------------------------------------------------------

/** Build create-machine request body from parsed flags. Reused by fleet up. */
function buildCreateOpts(name: string, flags: Record<string, string[]>): Record<string, unknown> {
  const resources: Record<string, unknown> = {
    cpus: parseInt(flag(flags, "cpus") ?? "2"),
    memoryMb: parseInt(flag(flags, "memory") ?? "1024"),
    network: !hasFlag(flags, "no-network"),
  };
  const allowedCidrs = flagAll(flags, "allow-cidr").flatMap((c: string) => c.split(",").map((s: string) => s.trim()).filter(Boolean));
  if (allowedCidrs.length > 0) {
    resources.allowedCidrs = allowedCidrs;
    resources.network = true;
  }
  const opts: Record<string, unknown> = { name, resources };
  const initCmds = flagAll(flags, "init");
  if (initCmds.length > 0) opts.init_commands = initCmds;
  if (flag(flags, "user")) opts.default_user = flag(flags, "user");
  if (flag(flags, "starter")) opts.from_starter = flag(flags, "starter");
  const secrets = flagAll(flags, "secret");
  if (secrets.length > 0) opts.secrets = secrets;
  return opts;
}

async function cmdFleetUp(prefix: string, count: number, args: string[]) {
  const { flags } = parseFlags(args, ["cpus", "memory", "no-network", "init", "user", "starter", "secret"]);

  // Create all machines
  console.log(`Creating fleet: ${prefix}-0..${count - 1}`);
  const names: string[] = [];
  for (let i = 0; i < count; i++) {
    const name = `${prefix}-${i}`;
    names.push(name);
    const opts = buildCreateOpts(name, flags);
    const resp = await apiCall("POST", "/machines", opts, LONG_TIMEOUT_MS);
    await jsonResult<Record<string, unknown>>(resp);
    console.log(`  created: ${name}`);
  }

  // Start all in parallel
  console.log("Starting all...");
  const startResults = await Promise.allSettled(
    names.map(async (name) => {
      const resp = await apiCall("POST", `/machines/${name}/start`);
      await jsonResult<Record<string, unknown>>(resp);
      return name;
    }),
  );
  for (const r of startResults) {
    if (r.status === "fulfilled") console.log(`  started: ${r.value}`);
    else console.error(`  failed: ${r.reason}`);
  }
  console.log(`Fleet ${prefix} is up (${count} machines).`);
}

async function cmdFleetDown(prefix: string) {
  const resp = await apiCall("GET", "/machines");
  const data = await jsonResult<{ machines: { name: string; state: string }[] }>(resp);
  const matches = data.machines.filter((s) => s.name.startsWith(`${prefix}-`));
  if (matches.length === 0) {
    console.log(`No machines matching prefix "${prefix}".`);
    return;
  }

  console.log(`Tearing down ${matches.length} machine(es) in fleet "${prefix}"...`);
  await Promise.allSettled(
    matches.map(async (s) => {
      try {
        if (s.state === "running") {
          const resp = await apiCall("POST", `/machines/${s.name}/stop`);
          await resp.text();
        }
      } catch { /* ignore */ }
      try {
        const resp = await apiCall("DELETE", `/machines/${s.name}?force=true`);
        await resp.text();
        console.log(`  removed: ${s.name}`);
      } catch (e) {
        console.error(`  failed: ${s.name} — ${e}`);
      }
    }),
  );
  console.log(`Fleet ${prefix} is down.`);
}

async function cmdFleetLs(prefix?: string) {
  const resp = await apiCall("GET", "/machines");
  const data = await jsonResult<{ machines: Record<string, unknown>[] }>(resp);
  const matches = prefix
    ? data.machines.filter((s) => String(s.name).startsWith(`${prefix}-`))
    : data.machines;
  const rows = matches.map((s) => ({
    name: s.name,
    state: s.state,
    pid: s.pid ?? "-",
    network: s.network ?? "-",
  }));
  table(rows, ["name", "state", "pid", "network"]);
}

async function cmdFleetExec(prefix: string, cmd: string, args: string[]) {
  const { flags } = parseFlags(args, ["env", "workdir", "user", "timeout"]);

  // Find fleet machines
  const resp = await apiCall("GET", "/machines");
  const data = await jsonResult<{ machines: { name: string; state: string }[] }>(resp);
  const matches = data.machines
    .filter((s) => s.name.startsWith(`${prefix}-`) && s.state === "running")
    .sort((a, b) => a.name.localeCompare(b.name));

  if (matches.length === 0) {
    die(`No running machines matching prefix "${prefix}".`);
  }

  // Build exec body
  const body: Record<string, unknown> = {
    command: ["sh", "-c", cmd],
    timeoutSecs: parseInt(flag(flags, "timeout") ?? "30"),
  };
  const envPairs = flagAll(flags, "env").map((e) => {
    const [n, ...v] = e.split("=");
    return { name: n, value: v.join("=") };
  });
  if (envPairs.length > 0) body.env = envPairs;
  if (flag(flags, "workdir")) body.workdir = flag(flags, "workdir");
  if (flag(flags, "user")) body.user = flag(flags, "user");

  const clientTimeout = (parseInt(flag(flags, "timeout") ?? "30") + 5) * 1000;

  console.log(`Executing on ${matches.length} machine(es)...`);
  const results = await Promise.allSettled(
    matches.map(async (s) => {
      const r = await apiCall("POST", `/machines/${s.name}/exec`, body, clientTimeout);
      const d = await jsonResult<{ exit_code?: number; exitCode?: number; stdout: string; stderr: string }>(r);
      return { name: s.name, ...d, exit_code: d.exit_code ?? d.exitCode ?? -1 };
    }),
  );

  for (const r of results) {
    if (r.status === "fulfilled") {
      const { name, exit_code, stdout, stderr } = r.value;
      console.log(`\n── ${name} (exit: ${exit_code}) ──`);
      if (stdout) Deno.stdout.writeSync(new TextEncoder().encode(stdout));
      if (stderr) Deno.stderr.writeSync(new TextEncoder().encode(stderr));
    } else {
      console.error(`\n── ERROR ──\n${r.reason}`);
    }
  }
}

// ---------------------------------------------------------------------------
// TUI Dashboard
// ---------------------------------------------------------------------------

const ANSI = {
  clear: "\x1b[2J\x1b[H",
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
};

function boxLine(content: string, width: number): string {
  const visible = content.replace(/\x1b\[[0-9;]*m/g, "");
  const pad = Math.max(0, width - 2 - visible.length);
  return `\u2502 ${content}${" ".repeat(pad)}\u2502`;
}

function fmtUptime(createdAt: string): string {
  const ms = Date.now() - new Date(createdAt).getTime();
  if (ms < 0) return "-";
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  const rm = mins % 60;
  if (hrs < 24) return `${hrs}h ${rm}m`;
  const days = Math.floor(hrs / 24);
  return `${days}d ${hrs % 24}h`;
}

function statusIcon(state: string): string {
  switch (state) {
    case "Running": return `${ANSI.green}\u25CFrunning${ANSI.reset}`;
    case "Stopped": return `${ANSI.dim}\u25CBstopped${ANSI.reset}`;
    case "Creating": return `${ANSI.yellow}\u25CCcreating${ANSI.reset}`;
    default: return `${ANSI.dim}\u25CB${state}${ANSI.reset}`;
  }
}

function statusVisLen(state: string): number {
  switch (state) {
    case "Running": return 8;
    case "Stopped": return 8;
    case "Creating": return 9;
    default: return 1 + state.length;
  }
}

async function cmdDashboard() {
  const W = Math.min(Deno.consoleSize?.().columns ?? 72, 80);
  const hr = "\u2500".repeat(W - 2);
  const topBorder = `\u250C${hr}\u2510`;
  const midBorder = `\u251C${hr}\u2524`;
  const botBorder = `\u2514${hr}\u2518`;
  const startTime = Date.now();

  Deno.stdin.setRaw(true);

  const refresh = async () => {
    let machines: Record<string, unknown>[] = [];
    let serverUp = false;
    let healthData: Record<string, unknown> = {};
    try {
      const resp = await apiCall("GET", "/machines");
      const data = await resp.json();
      machines = data.machines ?? [];
      serverUp = true;
    } catch { /* server may be down */ }

    try {
      const resp = await fetch(`${BASE_URL}/health`, {
        headers: authHeaders(),
        signal: AbortSignal.timeout(3000),
      });
      healthData = await resp.json();
      serverUp = true;
    } catch { /* ok */ }

    let jobs: Record<string, unknown>[] = [];
    try {
      const resp = await apiCall("GET", "/jobs?limit=5");
      const data = await resp.json();
      jobs = data.jobs ?? [];
    } catch { /* no job queue */ }

    let events: EventLogEntry[] = [];
    try {
      const text = await Deno.readTextFile(`${SMOLVM_HOME}/events.ndjson`);
      const rawLines = text.trim().split("\n").filter(Boolean).slice(-8);
      events = rawLines.map(l => JSON.parse(l) as EventLogEntry);
    } catch { /* no events yet */ }

    const metas = await listMeta();
    const metaMap = new Map(metas.map(m => [m.name, m]));

    const lines: string[] = [];
    const running = machines.filter(s => s.state === "Running").length;
    const stopped = machines.length - running;
    const sessionUp = fmtUptime(new Date(startTime).toISOString());
    const provider = String(healthData.provider ?? "local");

    lines.push(topBorder);
    const titleText = "smolvm dashboard";
    const titlePad = Math.max(0, Math.floor((W - 2 - titleText.length) / 2));
    lines.push(`\u2502${" ".repeat(titlePad)}${ANSI.bold}${ANSI.cyan}${titleText}${ANSI.reset}${" ".repeat(W - 2 - titlePad - titleText.length)}\u2502`);
    lines.push(midBorder);

    const serverStatus = serverUp
      ? `${ANSI.green}connected${ANSI.reset}`
      : `${ANSI.red}unreachable${ANSI.reset}`;
    lines.push(boxLine(`Provider: ${ANSI.bold}${provider}${ANSI.reset} | Machinees: ${ANSI.green}${running} running${ANSI.reset}, ${stopped} stopped`, W));
    lines.push(boxLine(`Server: ${ANSI.cyan}${BASE_URL}${ANSI.reset} | ${serverStatus} | Session: ${sessionUp}`, W));
    lines.push(midBorder);

    lines.push(boxLine(`${ANSI.bold}SANDBOXES${ANSI.reset}`, W));
    if (machines.length === 0) {
      lines.push(boxLine(`${ANSI.dim}(no machines)${ANSI.reset}`, W));
    } else {
      const hdr = "NAME".padEnd(16) + "STATUS".padEnd(14) + "STARTER".padEnd(14) + "UPTIME".padEnd(10) + "PID";
      lines.push(boxLine(`${ANSI.dim}${hdr}${ANSI.reset}`, W));
      for (const s of machines.slice(0, 10)) {
        const name = String(s.name ?? "").slice(0, 15).padEnd(16);
        const icon = statusIcon(String(s.state ?? "unknown"));
        const iconPad = " ".repeat(Math.max(0, 14 - statusVisLen(String(s.state ?? "unknown"))));
        const meta = metaMap.get(String(s.name));
        const starter = (meta?.starter ?? "-").slice(0, 13).padEnd(14);
        const ut = s.state === "Running" && meta?.created_at
          ? fmtUptime(meta.created_at).padEnd(10)
          : "-".padEnd(10);
        const pid = String(s.pid ?? "-");
        lines.push(boxLine(`${name}${icon}${iconPad}${starter}${ut}${pid}`, W));
      }
    }
    lines.push(midBorder);

    lines.push(boxLine(`${ANSI.bold}RECENT EVENTS${ANSI.reset}`, W));
    if (events.length === 0) {
      lines.push(boxLine(`${ANSI.dim}(no events)${ANSI.reset}`, W));
    } else {
      for (const ev of events.slice(-6)) {
        const ts = ev.timestamp
          ? new Date(ev.timestamp).toLocaleTimeString("en-GB", { hour12: false })
          : "??:??:??";
        const evType = (ev.event ?? "").padEnd(18);
        const sb = (ev.machine ?? "").padEnd(16);
        const detail = ev.details
          ? Object.entries(ev.details).map(([k, v]) => `${k}=${v}`).join(" ").slice(0, 20)
          : "";
        lines.push(boxLine(`${ANSI.dim}${ts}${ANSI.reset} ${ANSI.yellow}${evType}${ANSI.reset}${sb}${detail}`, W));
      }
    }
    lines.push(midBorder);

    lines.push(boxLine(`${ANSI.bold}JOBS (queue)${ANSI.reset}`, W));
    if (jobs.length === 0) {
      lines.push(boxLine(`${ANSI.dim}(no jobs)${ANSI.reset}`, W));
    } else {
      const jhdr = "ID".padEnd(12) + "STATUS".padEnd(12) + "SANDBOX".padEnd(16) + "COMMAND";
      lines.push(boxLine(`${ANSI.dim}${jhdr}${ANSI.reset}`, W));
      for (const j of jobs.slice(0, 5)) {
        const id = String(j.id ?? "").slice(0, 11).padEnd(12);
        const jstatus = String(j.status ?? "").padEnd(12);
        const jsb = String(j.machine ?? "-").slice(0, 15).padEnd(16);
        const jcmd = String(j.command ?? "").slice(0, W - 48);
        lines.push(boxLine(`${id}${jstatus}${jsb}${jcmd}`, W));
      }
    }
    lines.push(midBorder);

    lines.push(boxLine(`${ANSI.dim}Press ${ANSI.bold}q${ANSI.reset}${ANSI.dim} to quit, ${ANSI.bold}r${ANSI.reset}${ANSI.dim} to refresh${ANSI.reset}`, W));
    lines.push(botBorder);

    const output = ANSI.clear + lines.join("\n") + "\n";
    await Deno.stdout.write(new TextEncoder().encode(output));
  };

  await refresh();
  const interval = setInterval(refresh, 2000);

  const buf = new Uint8Array(1);
  try {
    while (true) {
      const n = await Deno.stdin.read(buf);
      if (n === null) break;
      const key = String.fromCharCode(buf[0]);
      if (key === "q" || key === "Q" || buf[0] === 3) break;
      if (key === "r" || key === "R") await refresh();
    }
  } finally {
    clearInterval(interval);
    Deno.stdin.setRaw(false);
    await Deno.stdout.write(new TextEncoder().encode(ANSI.clear));
  }
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

function usage(): never {
  console.log(`smolctl — manage smolvm machines

USAGE:
  smolctl <command> [args...]

AUTH:
  auth login                     Authenticate with Claude (opens browser, PKCE OAuth)
  auth status                    Show current auth state (token, expiry)
  auth logout                    Clear stored tokens from .env

SANDBOX LIFECYCLE:
  ls                             List all machines
  create <name> [flags]          Create a machine
    --cpus <n>                     CPU count (default: 2)
    --memory <mb>                  Memory in MB (default: 1024)
    --no-network                   Disable networking
    --init <cmd>                   Init command (repeatable)
    --user <name>                  Default non-root user
    --starter <name>               Use starter template
    --secret <name>                Inject secret via proxy (repeatable)
                                   e.g., --secret anthropic --secret openai
                                   Requires server started with --secret NAME=KEY
    --with-mcp                     Auto-configure built-in MCP servers
                                   (filesystem, exec, git) — requires Deno in image
    --mcp "name=X,cmd=Y"          Add custom MCP server (repeatable)
  start <name>                   Start a machine
  stop <name>                    Stop a machine
  rm <name> [--force]            Delete a machine
  info <name>                    Show machine details (JSON)
  up <name> [create flags]       Create + start (one shot)
    --setup <cmd>                  Post-start command (repeatable)
    --label key=value              Set metadata label (repeatable)
    --owner <name>                 Set machine owner
  down <name> [--force]          Stop + delete (checks for uncommitted work)
  prune                          Stop + delete ALL machines

EXECUTION:
  exec <name> <cmd...> [flags]   Run a command (no shell)
  sh <name> <cmd> [flags]        Run a shell command
  run <name> <image> <cmd...>    Run command in OCI image overlay
    --env KEY=VALUE                Set env var (repeatable)
    --workdir /path                Working directory
    --user <name>                  Run as user
    --timeout <secs>               Timeout (default: 30)
    --signed-only                  Require verified signature before exec

FILE OPERATIONS:
  files ls <name> [dir]          List files
  files cat <name> <path>        Read a file
  files write <name> <path>      Write file (--data or stdin)
  files rm <name> <path>         Delete a file
  cp <src> <dst> [--exclude p]   Copy files/dirs in or out
                                   Local to machine:  cp ./src vm:/workspace/src
                                   Machine to local:  cp vm:/workspace/out ./out
  git clone <name> <url> [dir]   Git clone repo into machine

FILE SYNC:
  sync push <machine> [dir] [flags]  Push local dir to machine
    --to /remote                       Remote path (default: /workspace)
    --exclude <pattern>                Exclude pattern (repeatable)
    --dry-run                          Show what would be synced
    --verify                           Require valid signature before push
  sync pull <machine> [dir] [flags]  Pull machine dir to local
    --from /remote                     Remote path (default: /workspace)
    --exclude <pattern>                Exclude pattern (repeatable)
    --dry-run                          Show what would be synced
  sync watch <machine> [dir] [flags] Watch local dir, auto-push on change
    --to /remote                       Remote path (default: /workspace)
    --exclude <pattern>                Exclude pattern (repeatable)
    --debounce <ms>                    Debounce delay (default: 500)

CLONING & SNAPSHOTS:
  clone <name> <new-name>        Clone machine (APFS COW)
  diff <name> <other>            Compare two machines
  merge <source> <target>        Merge files between machines
  snapshot push <name>           Export machine as snapshot
  snapshot ls                    List snapshots
  snapshot pull <snap> <name>    Restore snapshot to new machine
  snapshot rm <name>             Delete snapshot

IMAGES:
  image pull <machine> <img>     Pull OCI image into machine
  image ls <machine>             List pulled images

CONTAINERS (inside a machine):
  container ls <machine>                     List containers
  container create <machine> <image> [flags] Create container
    --cmd <arg>                                Command arg (repeatable)
    --env KEY=VALUE                            Set env var (repeatable)
    --workdir /path                            Working directory
  container start <machine> <id>             Start container
  container stop <machine> <id>              Stop container
  container rm <machine> <id> [--force]      Delete container
  container exec <machine> <id> <cmd...>     Exec in container
    --env KEY=VALUE                            Set env var (repeatable)
    --workdir /path                            Working directory
    --timeout <secs>                           Timeout (default: 30)

AGENT (AI agent orchestration):
  agent run "<prompt>" [flags]   Run Claude Code in an isolated machine
    --machine <preset>             Permission machine: permissive|research|developer|'{json}'
                                   (default: permissive — auto-approve all non-destructive tools)
    --name <name>                  Machine name (default: agent-<random>)
    --starter <name>               Starter template (default: claude-code)
    --secret <name>                Secret to inject (default: anthropic, repeatable)
    --oauth-token <token>          Use Claude subscription auth (or set CLAUDE_CODE_OAUTH_TOKEN
                                     in env or ~/.smolvm/.env, or pipe with --oauth-token -)
    --cpus <n>                     CPU count (default: 4)
    --memory <mb>                  Memory in MB (default: 2048)
    --timeout <secs>               Agent timeout (default: 300)
    --workdir /path                Working directory for agent
    --user <name>                  Run as user
    --keep                         Don't cleanup machine after run
    --json                         Output results as JSON
    --status                       Emit NDJSON status events to stderr
    --setup <cmd>                  Run command after start (repeatable)
    --label key=value              Set metadata label (repeatable)
    --owner <name>                 Set machine owner (default: $USER)
  agent fleet <prefix> <prompts-file> [flags]
                                 Dispatch multiple agents in parallel
                                   Prompts file: one prompt per line (# = comment)
                                   Same flags as 'agent run'
  agent merge <source> <target>  Merge agent workspace into another
    --strategy <theirs|ours>       Merge strategy (default: theirs)
  agent collect <prefix> [flags] Download all agent workspaces to local dirs
    --to <dir>                     Output directory (default: .)
    --dir <path>                   Remote dir to collect (default: /workspace)

SANDBOX PRESETS (permission profiles for agents):
  machine ls                     List available presets
  machine show <preset>          Show allow/deny rules for a preset
  machine test <preset> <tool>   Check if a tool would be allowed by a preset

METADATA & IDENTITY:
  meta                           List all machine metadata
  meta <name>                    Show metadata for a machine
  meta set <name> [flags]        Update metadata
    --label key=value              Set label (repeatable)
    --owner <name>                 Set owner
    --description "text"           Set description
  whoami <name>                  Show machine identity

SESSION RECORDING:
  session ls                     List recorded sessions
  session show <name>            Print session audit log
  session rm <name>              Delete session recording

FLEET (batch orchestration):
  fleet up <prefix> <N> [flags]  Create + start N machines (prefix-0..N-1)
                                   Accepts same flags as 'create'
  fleet down <prefix>            Stop + delete all machines with prefix
  fleet ls [prefix]              List fleet machines (or all if no prefix)
  fleet exec <prefix> <cmd>      Exec shell cmd across all running fleet members
    --env KEY=VALUE                Set env var (repeatable)
    --workdir /path                Working directory
    --user <name>                  Run as user
    --timeout <secs>               Timeout (default: 30)

DEBUG:
  debug mounts <machine>         Diagnose mount issues (virtiofs)
  debug network <machine>        Diagnose network/port issues

TUNNEL:
  tunnel start [--port 9090]     Start cloudflared tunnel to server
  tunnel start --ngrok           Start ngrok tunnel (alternative to cloudflared)
  tunnel start --ngrok --auth    Start ngrok with NGROK_AUTH_TOKEN env
  tunnel status                  Show tunnel URL + status
  tunnel stop                    Kill tunnel process
  tunnel share                   Output connection one-liner for sharing

SECRETS:
  secret ls                      List configured secret names
  secret update --secret K=V     Update secrets at runtime (repeatable)

PERMISSIONS (RBAC):
  permission grant <name>        Grant a role to a token on a machine
    --token <token>                Bearer token to grant access to
    --role <role>                  Role: owner, operator, readonly
  permission ls <name>           List permissions on a machine
  permission revoke <name> <hash>  Revoke permission by token hash

CODE SIGNING:
  sign generate                  Generate HMAC-SHA256 signing key
                                   Saves to ~/.smolvm/keys/signing.key
  sign file <path>               Sign a file or directory
                                   Creates <path>.sig with hash + HMAC signature
  sign verify <path>             Verify a signature
                                   Exit code 0 = pass, 1 = fail
  sign trust <key-or-path>       Add a trusted key to ~/.smolvm/keys/trusted/

  Verification flags:
    sync push ... --verify         Require valid signature before pushing
    exec ... --signed-only         Require signed content before executing

POOL (multi-node management):
  pool add <name> <url> [flags]  Add a node to the pool
    --token <token>                Bearer token for auth
    --max <n>                      Max machines on this node
  pool rm <name>                 Remove a node from the pool
  pool ls                        List nodes with status, machine count
  pool status                    Show aggregate pool stats
  pool route <machine>           Show which node a machine is on
  pool strategy <name>           Set routing strategy (round-robin, least-loaded)

  Pool-aware machine creation:
    create <name> --pool           Route to a node using pool strategy
    create <name> --node <name>    Route to a specific node
    up <name> --pool               Same as create, with --pool

PROVIDERS:
  provider info                  Show current provider info (from server)
  provider list                  List configured providers (~/.smolvm/providers.json)
  provider add <name> <url>      Add a provider
    --token <token>                Bearer token for auth
  provider use <name>            Set default provider
  provider rm <name>             Remove a provider

MONITORING:
  dashboard                      Live TUI with machines, events, jobs
  stats <name>                   Resource stats (CPU, memory, disk)
  logs <name> [--no-follow]      Stream machine logs
  metrics                        Prometheus metrics (raw)
  health                         Server health check
  starters                       List available starter templates (from API)

STARTER AUTHORING:
  starter init <name> [flags]    Scaffold a new starter template
    --base-image <image>           Base Docker image (default: ubuntu:22.04)
    --description "text"           Starter description
    --tag <tag>                    Tag (repeatable)
    --author <name>                Author name (default: $USER)
  starter ls                     List all starters (built-in + custom)
  starter build <name>           Build starter Docker image
  starter validate <name>        Validate starter template
  starter export <name> [path]   Export starter as .tar.gz
  starter import <path>          Import starter from .tar.gz

MCP SERVERS:
  mcp tools <machine>            List tools from all MCP servers
  mcp call <sb> <srv> <tool> [j] Call an MCP tool (args as JSON)
  mcp servers <machine>          List configured MCP servers
  mcp install <machine>          Push built-in MCP servers to a running machine
                                   (filesystem.ts, exec.ts, git.ts)
ENVIRONMENT:
  SMOLVM_URL          Server URL (default: http://127.0.0.1:9090)
  SMOLVM_API_TOKEN    Bearer token for authentication
`);
  Deno.exit(0);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const rawArgs = [...Deno.args];

// Extract global --provider flag before command dispatch
let _providerOverride: string | undefined;
{
  const idx = rawArgs.indexOf("--provider");
  if (idx !== -1) {
    if (idx + 1 >= rawArgs.length) {
      console.error("error: --provider requires a provider name");
      Deno.exit(1);
    }
    _providerOverride = rawArgs[idx + 1];
    rawArgs.splice(idx, 2); // remove --provider <name> from args
  }
}

// Apply provider override: load ~/.smolvm/providers.json and set BASE_URL/API/TOKEN
if (_providerOverride) {
  const cfgPath = `${Deno.env.get("HOME") ?? "~"}/.smolvm/providers.json`;
  try {
    const cfgText = Deno.readTextFileSync(cfgPath);
    const cfg = JSON.parse(cfgText) as { providers: { name: string; url: string; token?: string; default?: boolean }[] };
    const prov = cfg.providers.find((p) => p.name === _providerOverride);
    if (!prov) {
      console.error(`error: provider '${_providerOverride}' not found in ${cfgPath}`);
      console.error(`  available: ${cfg.providers.map((p) => p.name).join(", ")}`);
      Deno.exit(1);
    }
    BASE_URL = prov.url.replace(/\/$/, "");
    API = `${BASE_URL}/api/v1`;
    if (prov.token) TOKEN = prov.token;
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) {
      console.error(`error: provider config not found at ${cfgPath}. Run 'smolctl provider add' first.`);
      Deno.exit(1);
    }
    throw e;
  }
}

const args = rawArgs;
if (args.length === 0 || args[0] === "--help" || args[0] === "-h") usage();

const cmd = args[0];
const rest = args.slice(1);

// Auto-refresh OAuth token before dispatching commands (skip for auth commands themselves)
if (cmd !== "auth") {
  try { await autoRefreshToken(); } catch { /* non-blocking */ }
}

try {
  switch (cmd) {
    // Auth
    case "auth": {
      const sub = rest[0];
      switch (sub) {
        case "login": await cmdAuthLogin(); break;
        case "status": await cmdAuthStatus(); break;
        case "logout": cmdAuthLogout(); break;
        default: die(`unknown auth subcommand: ${sub ?? "(none)"}. Try: login, status, logout`);
      }
      break;
    }

    // Lifecycle
    case "health":
      await cmdHealth();
      break;
    case "dashboard":
      await cmdDashboard();
      break;
    case "ls":
    case "list":
      await cmdList();
      break;
    case "create":
      if (!rest[0]) die("usage: smolctl create <name> [flags]");
      await cmdCreate(rest[0], rest.slice(1));
      break;
    case "start":
      if (!rest[0]) die("usage: smolctl start <name>");
      await cmdStart(rest[0]);
      break;
    case "stop":
      if (!rest[0]) die("usage: smolctl stop <name>");
      await cmdStop(rest[0]);
      break;
    case "rm":
    case "delete":
      if (!rest[0]) die("usage: smolctl rm <name> [--force]");
      await cmdDelete(rest[0], rest.includes("--force"));
      break;
    case "info":
      if (!rest[0]) die("usage: smolctl info <name>");
      await cmdInfo(rest[0]);
      break;
    case "up":
      if (!rest[0]) die("usage: smolctl up <name> [flags]");
      await cmdUp(rest[0], rest.slice(1));
      break;
    case "down": {
      if (!rest[0]) die("usage: smolctl down <name> [--force]");
      const { flags: downFlags } = parseFlags(rest.slice(1), ["force"]);
      await cmdDown(rest[0], hasFlag(downFlags, "force"));
      break;
    }
    case "prune":
      await cmdPrune();
      break;
    case "resume":
      if (!rest[0]) die("usage: smolctl resume <name> [--setup 'cmd']");
      await cmdResume(rest[0], rest.slice(1));
      break;

    // Execution
    case "exec": {
      if (rest.length < 2) die("usage: smolctl exec <name> [--] <cmd...> [--env K=V] [--workdir /p] [--user u] [--signed-only]");
      const name = rest[0];
      const cmdParts: string[] = [];
      const flagParts: string[] = [];
      // Handle -- separator: everything after bare -- is the command
      const ddIdx = rest.indexOf("--");
      if (ddIdx > 0) {
        // Flags are between name and --, command is after --
        for (const r of rest.slice(1, ddIdx)) {
          flagParts.push(r);
        }
        cmdParts.push(...rest.slice(ddIdx + 1));
      } else {
        // No -- separator: flags start at first --option, rest is command
        let inFlags = false;
        for (const r of rest.slice(1)) {
          if (r.startsWith("--")) inFlags = true;
          if (inFlags) flagParts.push(r);
          else cmdParts.push(r);
        }
      }
      await cmdExec(name, cmdParts, flagParts);
      break;
    }
    case "sh":
      if (rest.length < 2) die("usage: smolctl sh <name> <cmd> [--env K=V] [--workdir /p] [--user u]");
      // Collect flags vs command
      {
        const name = rest[0];
        const shParts: string[] = [];
        const shFlags: string[] = [];
        let inF = false;
        for (const r of rest.slice(1)) {
          if (r.startsWith("--")) inF = true;
          if (inF) shFlags.push(r);
          else shParts.push(r);
        }
        await cmdSh(name, shParts.join(" "), shFlags);
      }
      break;
    case "run":
      if (rest.length < 3) die("usage: smolctl run <machine> <image> <cmd...>");
      {
        const machine = rest[0];
        const image = rest[1];
        const runParts: string[] = [];
        const runFlags: string[] = [];
        let inF = false;
        for (const r of rest.slice(2)) {
          if (r.startsWith("--")) inF = true;
          if (inF) runFlags.push(r);
          else runParts.push(r);
        }
        await cmdRun(machine, image, runParts, runFlags);
      }
      break;

    // Files
    case "files":
    case "file": {
      const subcmd = rest[0];
      const fArgs = rest.slice(1);
      switch (subcmd) {
        case "ls":
        case "list":
          if (!fArgs[0]) die("usage: smolctl files ls <name> [dir]");
          await cmdFilesLs(fArgs[0], fArgs[1]);
          break;
        case "cat":
        case "read":
          if (fArgs.length < 2) die("usage: smolctl files cat <name> <path>");
          await cmdFilesCat(fArgs[0], fArgs[1]);
          break;
        case "write":
          if (fArgs.length < 2) die("usage: smolctl files write <name> <path> [--data <content>]");
          await cmdFilesWrite(fArgs[0], fArgs[1], fArgs.slice(2));
          break;
        case "rm":
        case "delete":
          if (fArgs.length < 2) die("usage: smolctl files rm <name> <path>");
          await cmdFilesRm(fArgs[0], fArgs[1]);
          break;
        default:
          die(`unknown files subcommand: ${subcmd}. Try: ls, cat, write, rm`);
      }
      break;
    }
    case "cp":
      if (rest.length < 2) die("usage: smolctl cp <src> <dst> [--exclude pattern]");
      await cmdCp(rest[0], rest[1], rest.slice(2));
      break;

    // Sync
    case "sync": {
      const sub = rest[0];
      switch (sub) {
        case "push":
          if (!rest[1]) die("usage: smolctl sync push <machine> [dir] [--to /remote] [--exclude pattern] [--dry-run] [--verify]");
          await cmdSyncPush(rest[1], rest.slice(2));
          break;
        case "pull":
          if (!rest[1]) die("usage: smolctl sync pull <machine> [dir] [--from /remote] [--exclude pattern] [--dry-run]");
          await cmdSyncPull(rest[1], rest.slice(2));
          break;
        case "watch":
          if (!rest[1]) die("usage: smolctl sync watch <machine> [dir] [--to /remote] [--exclude pattern] [--debounce ms]");
          await cmdSyncWatch(rest[1], rest.slice(2));
          break;
        default:
          die(`unknown sync subcommand: ${sub}. Try: push, pull, watch`);
      }
      break;
    }

    // Tunnel
    case "tunnel": {
      const sub = rest[0];
      switch (sub) {
        case "start":
          await cmdTunnelStart(rest.slice(1));
          break;
        case "status":
          await cmdTunnelStatus();
          break;
        case "stop":
          await cmdTunnelStop();
          break;
        case "share":
          await cmdTunnelShare();
          break;
        default:
          die(`unknown tunnel subcommand: ${sub}. Try: start, status, stop, share`);
      }
      break;
    }

    // Machine presets
    case "machine": {
      const sub = rest[0];
      switch (sub) {
        case "ls": case "list": cmdMachineLs(); break;
        case "show":
          if (!rest[1]) die("usage: smolctl machine show <preset>");
          cmdMachineShow(rest[1]); break;
        case "test":
          if (!rest[1] || !rest[2]) die("usage: smolctl machine test <preset> <tool>");
          cmdMachineTest(rest[1], rest[2]); break;
        default:
          die(`unknown machine subcommand: ${sub}. Try: ls, show, test`);
      }
      break;
    }

    // Fleet
    case "fleet": {
      const sub = rest[0];
      switch (sub) {
        case "up": {
          if (!rest[1] || !rest[2]) die("usage: smolctl fleet up <prefix> <count> [create flags]");
          const count = parseInt(rest[2]);
          if (isNaN(count) || count < 1) die("count must be a positive integer");
          await cmdFleetUp(rest[1], count, rest.slice(3));
          break;
        }
        case "down":
          if (!rest[1]) die("usage: smolctl fleet down <prefix>");
          await cmdFleetDown(rest[1]);
          break;
        case "ls":
        case "list":
          await cmdFleetLs(rest[1]);
          break;
        case "exec": {
          if (rest.length < 3) die("usage: smolctl fleet exec <prefix> <cmd> [--env K=V] [--workdir /p] [--user u] [--timeout s]");
          const prefix = rest[1];
          const cmdStr = rest[2];
          await cmdFleetExec(prefix, cmdStr, rest.slice(3));
          break;
        }
        case "fanout": {
          if (!rest[1] || !rest[2]) die("usage: smolctl fleet fanout <source> <count>");
          const n = parseInt(rest[2]);
          if (isNaN(n) || n < 1) die("count must be a positive integer");
          await cmdFleetFanout(rest[1], n, rest.slice(3));
          break;
        }
        case "gather": {
          const { flags: gFlags, positional: gPos } = parseFlags(rest.slice(1), ["into"]);
          const gPrefix = gPos[0];
          const gTarget = flag(gFlags, "into");
          if (!gPrefix || !gTarget) die("usage: smolctl fleet gather <prefix> --into <target>");
          await cmdFleetGather(gPrefix, gTarget);
          break;
        }
        default:
          die(`unknown fleet subcommand: ${sub}. Try: up, down, ls, exec, fanout, gather`);
      }
      break;
    }

    // Agent
    case "agent": {
      const sub = rest[0];
      switch (sub) {
        case "run":
          if (!rest[1]) die("usage: smolctl agent run \"<prompt>\" [flags]");
          await cmdAgentRun(rest[1], rest.slice(2));
          break;
        case "fleet":
          if (!rest[1] || !rest[2]) die("usage: smolctl agent fleet <prefix> <prompts-file> [flags]");
          await cmdAgentFleet(rest[1], rest[2], rest.slice(3));
          break;
        case "merge":
          if (rest.length < 3) die("usage: smolctl agent merge <source> <target> [--strategy theirs|ours]");
          await cmdAgentMerge(rest[1], rest[2], rest.slice(3));
          break;
        case "collect":
          if (!rest[1]) die("usage: smolctl agent collect <prefix> [--to dir] [--dir /workspace]");
          await cmdAgentCollect(rest[1], rest.slice(2));
          break;
        case "worker":
          await cmdAgentWorker(rest.slice(1));
          break;
        default:
          die(`unknown agent subcommand: ${sub}. Try: run, fleet, merge, collect, worker`);
      }
      break;
    }

    // Metadata
    case "meta": {
      const sub = rest[0];
      if (!sub) {
        // List all metadata
        const metas = await listMeta();
        if (metas.length === 0) { console.log("No metadata stored."); break; }
        table(metas.map((m) => ({
          name: m.name, owner: m.owner ?? "-", labels: m.labels ? Object.entries(m.labels).map(([k, v]) => `${k}=${v}`).join(",") : "-", created_at: m.created_at,
        })), ["name", "owner", "labels", "created_at"]);
      } else if (sub === "set") {
        if (!rest[1]) die("usage: smolctl meta set <name> [--label k=v] [--owner x] [--description text]");
        const { flags: mf } = parseFlags(rest.slice(2), ["label", "owner", "description"]);
        const existing = await loadMeta(rest[1]) ?? { name: rest[1], created_at: new Date().toISOString() };
        if (flag(mf, "owner")) existing.owner = flag(mf, "owner");
        if (flag(mf, "description")) existing.description = flag(mf, "description");
        const newLabels = parseLabels(mf);
        if (newLabels) existing.labels = { ...(existing.labels ?? {}), ...newLabels };
        await saveMeta(existing);
        console.log(`Updated metadata for: ${rest[1]}`);
      } else {
        // Show metadata for a specific machine
        const meta = await loadMeta(sub);
        if (!meta) die(`No metadata for: ${sub}`);
        console.log(JSON.stringify(meta, null, 2));
      }
      break;
    }

    // Session recording
    case "session": {
      const sub = rest[0];
      switch (sub) {
        case "ls":
        case "list":
          await cmdSessionLs();
          break;
        case "show":
          if (!rest[1]) die("usage: smolctl session show <name>");
          await cmdSessionShow(rest[1]);
          break;
        case "rm":
          if (!rest[1]) die("usage: smolctl session rm <name>");
          await cmdSessionRm(rest[1]);
          break;
        default:
          die(`unknown session subcommand: ${sub}. Try: ls, show, rm`);
      }
      break;
    }

    case "audit":
      if (!rest[0]) die("usage: smolctl audit <name>");
      await cmdAudit(rest[0]);
      break;

    case "events":
      await cmdEvents(rest);
      break;

    // Whoami
    case "whoami":
      if (!rest[0]) die("usage: smolctl whoami <name>");
      {
        const meta = await loadMeta(rest[0]);
        if (meta) {
          // Write identity to machine
          const identResp = await apiCall("POST", `/machines/${rest[0]}/exec`, {
            command: ["sh", "-c", `cat /etc/smolvm.json 2>/dev/null || echo '${JSON.stringify(meta).replace(/'/g, "'\\''")}'`],
            timeoutSecs: 5,
          }, 10_000);
          const data = await jsonResult<{ stdout: string }>(identResp);
          console.log(data.stdout.trim());
        } else {
          // Fallback: just show server info
          const infoResp = await apiCall("GET", `/machines/${rest[0]}`);
          const data = await jsonResult<Record<string, unknown>>(infoResp);
          console.log(JSON.stringify({ name: data.name, state: data.state }, null, 2));
        }
      }
      break;

    // Git
    case "git":
      switch (rest[0]) {
        case "clone":
          if (rest.length < 3) die("usage: smolctl git clone <machine> <repo-url> [dir]");
          await cmdGitClone(rest[1], rest[2], rest[3]);
          break;
        case "init":
          if (!rest[1]) die("usage: smolctl git init <machine>");
          await cmdGitInit(rest[1]);
          break;
        case "status":
          if (!rest[1]) die("usage: smolctl git status <machine>");
          await cmdGitStatus(rest[1]);
          break;
        case "log":
          if (!rest[1]) die("usage: smolctl git log <machine> [-n 20]");
          await cmdGitLog(rest[1], rest.slice(2));
          break;
        case "commit":
          if (!rest[1]) die("usage: smolctl git commit <machine> -m 'message'");
          await cmdGitCommit(rest[1], rest.slice(2));
          break;
        case "diff":
          if (rest.length < 3) die("usage: smolctl git diff <source> <target>");
          await cmdGitDiff(rest[1], rest[2]);
          break;
        case "merge":
          if (rest.length < 3) die("usage: smolctl git merge <source> <target> [--strategy theirs|ours]");
          await cmdGitMerge(rest[1], rest[2], rest.slice(3));
          break;
        default:
          die(`unknown git subcommand: ${rest[0]}. Try: init, status, log, commit, diff, merge, clone`);
      }
      break;

    // Clone / Diff / Merge
    case "clone":
      if (rest.length < 2) die("usage: smolctl clone <name> <new-name> [--no-branch]");
      await cmdClone(rest[0], rest[1], rest.slice(2));
      break;
    case "diff":
      if (rest.length < 2) die("usage: smolctl diff <name> <other>");
      await cmdDiff(rest[0], rest[1]);
      break;
    case "merge":
      if (rest.length < 2) die("usage: smolctl merge <source> <target>");
      await cmdMerge(rest[0], rest[1]);
      break;

    // Snapshots
    case "snapshot":
    case "snap": {
      const sub = rest[0];
      switch (sub) {
        case "push":
          if (!rest[1]) die("usage: smolctl snapshot push <name> [--desc '...'] [--parent <snap>]");
          await cmdSnapshotPush(rest[1], rest.slice(2));
          break;
        case "ls":
        case "list":
          await cmdSnapshotLs(rest.slice(1));
          break;
        case "pull":
          if (rest.length < 3) die("usage: smolctl snapshot pull <snap-name> <machine-name>");
          await cmdSnapshotPull(rest[1], rest[2]);
          break;
        case "rm":
        case "delete":
          if (!rest[1]) die("usage: smolctl snapshot rm <name>");
          await cmdSnapshotRm(rest[1]);
          break;
        case "export":
          if (!rest[1]) die("usage: smolctl snapshot export <name> [path]");
          await cmdSnapshotExport(rest[1], rest[2]);
          break;
        case "import":
          if (!rest[1]) die("usage: smolctl snapshot import <path> [name]");
          await cmdSnapshotImport(rest[1], rest[2]);
          break;
        case "describe":
        case "info":
          if (!rest[1]) die("usage: smolctl snapshot describe <name>");
          await cmdSnapshotDescribe(rest[1]);
          break;
        case "merge":
          if (rest.length < 3) die("usage: smolctl snapshot merge <snap-name> <target-vm> [--strategy theirs|ours]");
          await cmdSnapshotMerge(rest[1], rest[2], rest.slice(3));
          break;
        case "lineage":
          if (!rest[1]) die("usage: smolctl snapshot lineage <name>");
          await cmdSnapshotLineage(rest[1]);
          break;
        case "history":
          if (!rest[1]) die("usage: smolctl snapshot history <name>");
          await cmdSnapshotHistory(rest[1]);
          break;
        case "rollback":
          if (!rest[1] || !rest[2]) die("usage: smolctl snapshot rollback <snap-name> <machine-name> [--version N]");
          await cmdSnapshotRollback(rest[1], rest[2], rest.slice(3));
          break;
        case "squash":
          if (!rest[1]) die("usage: smolctl snapshot squash <name> [--keep]");
          await cmdSnapshotSquash(rest[1], rest.slice(2));
          break;
        case "upload":
          if (!rest[1]) die("usage: smolctl [--provider <name>] snapshot upload <name>");
          await cmdSnapshotUpload(rest[1]);
          break;
        case "download":
          if (!rest[1]) die("usage: smolctl [--provider <name>] snapshot download <name>");
          await cmdSnapshotDownload(rest[1]);
          break;
        case "export-workspace":
        case "export-ws":
          if (!rest[1]) die("usage: smolctl snapshot export-workspace <machine> [path]");
          await cmdWorkspaceExport(rest[1], rest[2]);
          break;
        case "import-workspace":
        case "import-ws":
          if (!rest[1] || !rest[2]) die("usage: smolctl snapshot import-workspace <path> <machine>");
          await cmdWorkspaceImport(rest[1], rest[2]);
          break;
        case "to-docker":
          if (!rest[1]) die("usage: smolctl snapshot to-docker <machine> [--tag image:tag] [--output dir]");
          await cmdToDocker(rest[1], rest.slice(2));
          break;
        case "cp":
        case "copy":
          if (rest.length < 3) die("usage: smolctl snapshot cp <src> <dst> [--exclude pattern]\n  e.g.  smolctl snapshot cp my-snap:/workspace/file.txt ./file.txt\n        smolctl snapshot cp ./file.txt my-snap:/workspace/file.txt");
          await cmdSnapshotCp(rest[1], rest[2], rest.slice(3));
          break;
        case "ls-files":
        case "files":
          if (!rest[1]) die("usage: smolctl snapshot ls-files <snap-name> [path] [--recursive]");
          await cmdSnapshotLsFiles(rest[1], rest[2], rest.slice(2));
          break;
        default:
          die(`unknown snapshot subcommand: ${sub}. Try: push, ls, pull, rm, export, import, describe, merge, lineage, history, rollback, squash, upload, download, export-workspace, import-workspace, to-docker, cp, ls-files`);
      }
      break;
    }

    // Images
    case "image":
    case "img": {
      const sub = rest[0];
      switch (sub) {
        case "pull":
          if (rest.length < 3) die("usage: smolctl image pull <machine> <image>");
          await cmdImagePull(rest[1], rest[2]);
          break;
        case "ls":
        case "list":
          if (!rest[1]) die("usage: smolctl image ls <machine>");
          await cmdImageLs(rest[1]);
          break;
        default:
          die(`unknown image subcommand: ${sub}. Try: pull, ls`);
      }
      break;
    }

    // Containers
    case "container":
    case "ctr": {
      const sub = rest[0];
      const cArgs = rest.slice(1);
      switch (sub) {
        case "ls":
        case "list":
          if (!cArgs[0]) die("usage: smolctl container ls <machine>");
          await cmdContainerLs(cArgs[0]);
          break;
        case "create":
          if (cArgs.length < 2) die("usage: smolctl container create <machine> <image> [--cmd arg] [--env K=V] [--workdir /p]");
          await cmdContainerCreate(cArgs[0], cArgs[1], cArgs.slice(2));
          break;
        case "start":
          if (cArgs.length < 2) die("usage: smolctl container start <machine> <id>");
          await cmdContainerStart(cArgs[0], cArgs[1]);
          break;
        case "stop":
          if (cArgs.length < 2) die("usage: smolctl container stop <machine> <id>");
          await cmdContainerStop(cArgs[0], cArgs[1]);
          break;
        case "rm":
        case "delete":
          if (cArgs.length < 2) die("usage: smolctl container rm <machine> <id> [--force]");
          await cmdContainerRm(cArgs[0], cArgs[1], cArgs.includes("--force"));
          break;
        case "exec": {
          if (cArgs.length < 3) die("usage: smolctl container exec <machine> <id> <cmd...> [--env K=V] [--workdir /p] [--timeout s]");
          const machine = cArgs[0];
          const cid = cArgs[1];
          const cmdParts: string[] = [];
          const flagParts: string[] = [];
          let inFlags = false;
          for (const r of cArgs.slice(2)) {
            if (r.startsWith("--")) inFlags = true;
            if (inFlags) flagParts.push(r);
            else cmdParts.push(r);
          }
          await cmdContainerExec(machine, cid, cmdParts, flagParts);
          break;
        }
        default:
          die(`unknown container subcommand: ${sub}. Try: ls, create, start, stop, rm, exec`);
      }
      break;
    }

    // MCP
    case "mcp": {
      const sub = rest[0];
      if (!sub) die("usage: smolctl mcp <tools|call|servers|install> <machine> [args]");
      switch (sub) {
        case "tools":
        case "tool": {
          if (!rest[1]) die("usage: smolctl mcp tools <machine>");
          await cmdMcpTools(rest[1]);
          break;
        }
        case "call": {
          if (!rest[1] || !rest[2] || !rest[3]) die("usage: smolctl mcp call <machine> <server> <tool> [args-json]");
          const argsJson = rest[4] ?? "{}";
          await cmdMcpCall(rest[1], rest[2], rest[3], argsJson);
          break;
        }
        case "servers":
        case "server": {
          if (!rest[1]) die("usage: smolctl mcp servers <machine>");
          await cmdMcpServers(rest[1]);
          break;
        }
        case "install": {
          if (!rest[1]) die("usage: smolctl mcp install <machine>");
          await cmdMcpInstall(rest[1]);
          break;
        }
        default:
          die(`unknown mcp subcommand: ${sub}. Try: tools, call, servers, install`);
      }
      break;
    }

    // Debug
    case "debug": {
      const sub = rest[0];
      switch (sub) {
        case "mounts":
        case "mount":
          if (!rest[1]) die("usage: smolctl debug mounts <machine>");
          await cmdDebugMounts(rest[1]);
          break;
        case "network":
        case "net":
          if (!rest[1]) die("usage: smolctl debug network <machine>");
          await cmdDebugNetwork(rest[1]);
          break;
        default:
          die(`unknown debug subcommand: ${sub}. Try: mounts, network`);
      }
      break;
    }

    // DNS filter status
    case "dns": {
      const dnsSub = rest[0];
      if (dnsSub === "status" || dnsSub === "check") {
        if (!rest[1]) die("usage: smolctl dns status <machine>");
        await cmdDnsStatus(rest[1]);
      } else if (dnsSub && !rest[1]) {
        // Allow shorthand: smolctl dns <machine>
        await cmdDnsStatus(dnsSub);
      } else {
        die("usage: smolctl dns [status|check] <machine>");
      }
      break;
    }

    // Stats
    case "stats":
      if (!rest[0]) die("usage: smolctl stats <name>");
      await cmdStats(rest[0]);
      break;

    // Starter authoring
    case "starter": {
      const sub = rest[0];
      if (!sub) die("usage: smolctl starter <init|ls|build|validate|export|import>");
      switch (sub) {
        case "init":
          if (!rest[1]) die("usage: smolctl starter init <name> [flags]");
          await cmdStarterInit(rest[1], rest.slice(2));
          break;
        case "ls":
        case "list":
          await cmdStarterLs();
          break;
        case "build":
          if (!rest[1]) die("usage: smolctl starter build <name>");
          await cmdStarterBuild(rest[1]);
          break;
        case "validate":
          if (!rest[1]) die("usage: smolctl starter validate <name>");
          await cmdStarterValidate(rest[1]);
          break;
        case "export":
          if (!rest[1]) die("usage: smolctl starter export <name> [path]");
          await cmdStarterExport(rest[1], rest[2]);
          break;
        case "import":
          if (!rest[1]) die("usage: smolctl starter import <path>");
          await cmdStarterImport(rest[1]);
          break;
        default:
          die(`unknown starter subcommand: ${sub}. Try: init, ls, build, validate, export, import`);
      }
      break;
    }

    // Starters (API query)
    case "starters":
      await cmdStarters();
      break;

    // Metrics
    case "metrics":
      await cmdMetrics();
      break;

    // Logs
    case "logs":
      if (!rest[0]) die("usage: smolctl logs <name>");
      await cmdLogs(rest[0], rest.slice(1));
      break;

    // Secrets (hot-reload)
    case "secret":
    case "secrets": {
      const sub = rest[1];
      if (!sub) die("usage: smolctl secret <ls|update>");
      switch (sub) {
        case "ls":
        case "list": {
          const resp = await apiCall("GET", "/secrets");
          const data = await jsonResult<{ secrets: string[]; services: string[] }>(resp);
          console.log("Secrets:", data.secrets.length ? data.secrets.join(", ") : "(none)");
          console.log("Services:", data.services.length ? data.services.join(", ") : "(none)");
          break;
        }
        case "update":
        case "set": {
          const { flags: sFlags } = parseFlags(rest.slice(2), ["secret"]);
          const secretPairs = flagAll(sFlags, "secret");
          if (secretPairs.length === 0) die("usage: smolctl secret update --secret NAME=VALUE [--secret NAME2=VALUE2]");
          const secrets: Record<string, string> = {};
          for (const pair of secretPairs) {
            const eq = pair.indexOf("=");
            if (eq < 1) die(`invalid secret format '${pair}': expected NAME=VALUE`);
            secrets[pair.slice(0, eq)] = pair.slice(eq + 1);
          }
          const resp = await apiCall("PUT", "/secrets", { secrets });
          const data = await jsonResult<{ updated: string[] }>(resp);
          console.log(`Updated secrets: ${data.updated.join(", ")}`);
          break;
        }
        default:
          die(`unknown secret subcommand: ${sub}. Try: ls, update`);
      }
      break;
    }

    // Permissions (RBAC)
    case "permission":
    case "permissions":
    case "perm": {
      const sub = rest[0];
      if (!sub) die("usage: smolctl permission <grant|ls|revoke> <machine> [flags]");
      switch (sub) {
        case "grant": {
          const name = rest[1];
          if (!name) die("usage: smolctl permission grant <machine> --token <token> --role <owner|operator|readonly>");
          const { flags: pf } = parseFlags(rest.slice(2), ["token", "role"]);
          const grantToken = flag(pf, "token");
          const role = flag(pf, "role");
          if (!grantToken || !role) die("usage: smolctl permission grant <machine> --token <token> --role <owner|operator|readonly>");
          const resp = await apiCall("POST", `/machines/${name}/permissions`, { token: grantToken, role });
          const data = await jsonResult<{ message: string }>(resp);
          console.log(data.message);
          break;
        }
        case "ls":
        case "list": {
          const name = rest[1];
          if (!name) die("usage: smolctl permission ls <machine>");
          const resp = await apiCall("GET", `/machines/${name}/permissions`);
          const data = await jsonResult<{ machine: string; permissions: Array<{ token_hash: string; role: string }> }>(resp);
          if (data.permissions.length === 0) {
            console.log(`No permissions set on machine '${name}' (RBAC not active)`);
          } else {
            table(data.permissions.map(p => ({ token_hash: p.token_hash, role: p.role })), ["token_hash", "role"]);
          }
          break;
        }
        case "revoke": {
          const name = rest[1];
          const tokenHash = rest[2];
          if (!name || !tokenHash) die("usage: smolctl permission revoke <machine> <token-hash>");
          const resp = await apiCall("DELETE", `/machines/${name}/permissions/${tokenHash}`);
          const data = await jsonResult<{ message: string }>(resp);
          console.log(data.message);
          break;
        }
        default:
          die(`unknown permission subcommand: ${sub}. Try: grant, ls, revoke`);
      }
      break;
    }

    // Jobs (work queue)
    case "job":
    case "jobs": {
      const { flags: jFlags, positional: jPos } = parseFlags(rest.slice(1), [
        "priority", "max-retries", "timeout", "label", "status", "machine", "limit",
        "exit-code", "stdout", "stderr", "error", "interval",
      ]);
      const sub = rest[0];
      switch (sub) {
        case "submit": {
          if (!jPos[0] || !jPos[1]) die("usage: smolctl job submit <machine> <command...>");
          const machine = jPos[0];
          const command = jPos.slice(1);
          const priority = Number(flag(jFlags, "priority") || "0");
          const maxRetries = Number(flag(jFlags, "max-retries") || "0");
          const timeoutSecs = Number(flag(jFlags, "timeout") || "300");
          const labels: Record<string, string> = {};
          for (const lbl of flagAll(jFlags, "label")) {
            const [k, ...v] = lbl.split("=");
            if (k && v.length) labels[k] = v.join("=");
          }
          const resp = await apiCall("POST", "/jobs", {
            machine,
            command,
            env: [],
            timeoutSecs: timeoutSecs,
            max_retries: maxRetries,
            priority,
            labels,
          });
          const data = await jsonResult<{ id: string; status: string }>(resp);
          console.log(`Job ${data.id} submitted (status: ${data.status})`);
          break;
        }
        case "ls":
        case "list": {
          const jStatus = flag(jFlags, "status") || undefined;
          const jMachine = flag(jFlags, "machine") || undefined;
          const jLimit = flag(jFlags, "limit") || undefined;
          const params = new URLSearchParams();
          if (jStatus) params.set("status", jStatus);
          if (jMachine) params.set("machine", jMachine);
          if (jLimit) params.set("limit", jLimit);
          const qs = params.toString() ? `?${params.toString()}` : "";
          const resp = await apiCall("GET", `/jobs${qs}`);
          const data = await jsonResult<{ jobs: Array<Record<string, unknown>> }>(resp);
          if (data.jobs.length === 0) {
            console.log("No jobs.");
          } else {
            for (const j of data.jobs) {
              console.log(`${j.id}  ${j.status}  machine=${j.machine}  priority=${j.priority}  attempts=${j.attempts}`);
            }
          }
          break;
        }
        case "get":
        case "show": {
          if (!jPos[0]) die("usage: smolctl job get <id>");
          const resp = await apiCall("GET", `/jobs/${jPos[0]}`);
          const data = await jsonResult<Record<string, unknown>>(resp);
          console.log(JSON.stringify(data, null, 2));
          break;
        }
        case "poll": {
          const resp = await apiCall("POST", "/jobs/poll");
          if (resp.status === 204) {
            console.log("No jobs available.");
          } else {
            const data = await jsonResult<Record<string, unknown>>(resp);
            console.log(JSON.stringify(data, null, 2));
          }
          break;
        }
        case "complete": {
          if (!jPos[0]) die("usage: smolctl job complete <id> [--exit-code N] [--stdout text] [--stderr text]");
          const exitCode = Number(flag(jFlags, "exit-code") || "0");
          const jStdout = flag(jFlags, "stdout") || "";
          const jStderr = flag(jFlags, "stderr") || "";
          const resp = await apiCall("POST", `/jobs/${jPos[0]}/complete`, {
            exit_code: exitCode,
            stdout: jStdout,
            stderr: jStderr,
          });
          const data = await jsonResult<{ id: string; status: string }>(resp);
          console.log(`Job ${data.id} completed (status: ${data.status})`);
          break;
        }
        case "fail": {
          if (!jPos[0]) die("usage: smolctl job fail <id> --error 'reason'");
          const error = flag(jFlags, "error") || "unknown error";
          const resp = await apiCall("POST", `/jobs/${jPos[0]}/fail`, { error });
          const data = await jsonResult<{ id: string; status: string }>(resp);
          console.log(`Job ${data.id} failed (status: ${data.status})`);
          break;
        }
        case "rm":
        case "delete": {
          if (!jPos[0]) die("usage: smolctl job rm <id>");
          const resp = await apiCall("DELETE", `/jobs/${jPos[0]}`);
          if (resp.ok) {
            console.log(`Job ${jPos[0]} deleted.`);
          } else {
            const err = await resp.text();
            die(`Failed to delete job: ${err}`);
          }
          break;
        }
        case "watch": {
          if (!jPos[0]) die("usage: smolctl job watch <id> [--interval 2]");
          const jobId = jPos[0];
          const interval = Number(flag(jFlags, "interval") || "2") * 1000;
          let lastStatus = "";
          console.log(`Watching job ${jobId}...`);
          // deno-lint-ignore no-explicit-any
          let job: any;
          while (true) {
            const resp = await apiCall("GET", `/jobs/${jobId}`);
            job = await jsonResult<Record<string, unknown>>(resp);
            if (job.status !== lastStatus) {
              const event = { status: job.status, timestamp: new Date().toISOString(), job_id: job.id, machine: job.machine };
              Deno.stderr.writeSync(new TextEncoder().encode(JSON.stringify(event) + "\n"));
              lastStatus = job.status as string;
              if (job.status === "completed" || job.status === "failed" || job.status === "dead") break;
            }
            await new Promise((r) => setTimeout(r, interval));
          }
          console.log(JSON.stringify(job, null, 2));
          break;
        }
        default:
          die(`unknown job subcommand: ${sub}. Try: submit, ls, get, poll, complete, fail, rm, watch`);
      }
      break;
    }

    // Service definitions
    case "service":
    case "services": {
      const sub = rest[0];
      const sArgs = rest.slice(1);
      switch (sub) {
        case "ls":
        case "list": {
          const resp = await apiCall("GET", "/services");
          const data = await jsonResult<{ services: Array<Record<string, string>> }>(resp);
          if (data.services.length === 0) {
            console.log("No services registered.");
          } else {
            table(data.services, ["name", "base_url", "auth_header", "auth_prefix", "env_key_name", "env_url_name"]);
          }
          break;
        }
        case "add": {
          const { flags: sFlags } = parseFlags(sArgs, [
            "name", "url", "header", "prefix", "env-key", "env-url",
          ]);
          const name = flag(sFlags, "name");
          const baseUrl = flag(sFlags, "url");
          const authHeader = flag(sFlags, "header");
          const authPrefix = flag(sFlags, "prefix") ?? "";
          const envKey = flag(sFlags, "env-key");
          const envUrl = flag(sFlags, "env-url");
          if (!name || !baseUrl || !authHeader || !envKey || !envUrl) {
            die("usage: smolctl service add --name <name> --url <base_url> --header <auth_header> --prefix <prefix> --env-key <env_key_name> --env-url <env_url_name>");
          }
          const resp = await apiCall("POST", "/services", {
            name,
            base_url: baseUrl,
            auth_header: authHeader,
            auth_prefix: authPrefix,
            env_key_name: envKey,
            env_url_name: envUrl,
          });
          const data = await jsonResult<Record<string, string>>(resp);
          console.log(`Service '${data.name}' registered.`);
          console.log(`  Base URL:    ${data.base_url}`);
          console.log(`  Auth header: ${data.auth_header}`);
          console.log(`  Env key:     ${data.env_key_name}`);
          console.log(`  Env URL:     ${data.env_url_name}`);
          break;
        }
        default:
          die(`unknown service subcommand: ${sub}. Try: ls, add`);
      }
      break;
    }

    // Code signing
    case "sign": {
      const sub = rest[0];
      switch (sub) {
        case "generate":
          await cmdSignGenerate();
          break;
        case "file":
          if (!rest[1]) die("usage: smolctl sign file <path>");
          await cmdSignFile(rest[1]);
          break;
        case "verify": {
          if (!rest[1]) die("usage: smolctl sign verify <path>");
          const ok = await cmdSignVerify(rest[1]);
          if (!ok) Deno.exit(1);
          break;
        }
        case "trust":
          if (!rest[1]) die("usage: smolctl sign trust <key-path-or-value>");
          await cmdSignTrust(rest[1]);
          break;
        default:
          die(`unknown sign subcommand: ${sub}. Try: generate, file, verify, trust`);
      }
      break;
    }

    // Pool management
    case "pool": {
      const sub = rest[0];
      if (!sub) die("usage: smolctl pool <add|rm|ls|status|route|strategy>");
      switch (sub) {
        case "add": {
          if (!rest[1] || !rest[2]) die("usage: smolctl pool add <name> <url> [--token TOKEN] [--max N]");
          await cmdPoolAdd(rest[1], rest[2], rest.slice(3));
          break;
        }
        case "rm":
        case "remove":
          if (!rest[1]) die("usage: smolctl pool rm <name>");
          await cmdPoolRm(rest[1]);
          break;
        case "ls":
        case "list":
          await cmdPoolLs();
          break;
        case "status":
          await cmdPoolStatus();
          break;
        case "route":
          if (!rest[1]) die("usage: smolctl pool route <machine-name>");
          await cmdPoolRoute(rest[1]);
          break;
        case "strategy":
          if (!rest[1]) die("usage: smolctl pool strategy <round-robin|least-loaded>");
          await cmdPoolStrategy(rest[1]);
          break;
        default:
          die(`unknown pool subcommand: ${sub}. Try: add, rm, ls, status, route, strategy`);
      }
      break;
    }

    case "provider":
    case "providers": {
      const sub = rest[0];
      if (!sub) die("usage: smolctl provider <info|list|add|use|rm>");
      switch (sub) {
        case "info":
          await cmdProviderInfo();
          break;
        case "ls":
        case "list":
          await cmdProviderList();
          break;
        case "add": {
          const pName = rest[1];
          const pUrl = rest[2];
          // Parse --token flag
          let pToken: string | undefined;
          for (let i = 3; i < rest.length; i++) {
            if (rest[i] === "--token" && rest[i + 1]) {
              pToken = rest[++i];
            }
          }
          await cmdProviderAdd(pName, pUrl, pToken);
          break;
        }
        case "use":
          await cmdProviderUse(rest[1]);
          break;
        case "rm":
        case "remove":
          await cmdProviderRemove(rest[1]);
          break;
        default:
          die(`unknown provider subcommand: ${sub}. Try: info, list, add, use, rm`);
      }
      break;
    }

    default:
      die(`unknown command: ${cmd}. Run 'smolctl --help' for usage.`);
  }
} catch (e) {
  if (e instanceof TypeError && e.message.includes("fetch")) {
    die(`cannot reach server at ${BASE_URL} — is smolvm serve running?`);
  }
  throw e;
}
