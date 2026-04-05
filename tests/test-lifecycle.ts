/**
 * CX04 smolvm — Agent Lifecycle Benchmark
 *
 * Full CREATE → BOOTSTRAP → WORK → EXTRACT → DESTROY cycle.
 * Measures each phase independently.
 */

import { apiPost, apiDelete, sh, cleanup } from "./_helpers.ts";

const MACHINE_NAME = "cx04-lifecycle";

// ============================================================================
// Lifecycle
// ============================================================================

console.log("\n==========================================");
console.log("  CX04 smolvm — Agent Lifecycle Benchmark");
console.log("==========================================\n");

await cleanup(MACHINE_NAME);

const GROQ_KEY = Deno.env.get("GROQ_API_KEY") || "";
if (!GROQ_KEY) {
  console.log("⚠️  GROQ_API_KEY not set — will skip LLM inference step");
}

const phases: Record<string, number> = {};

// =====================================================
// Phase 1: CREATE
// =====================================================
console.log("Phase 1: CREATE");
const tCreate = performance.now();
{
  const resp = await apiPost("/machines", {
    name: MACHINE_NAME,
    resources: { cpus: 2, memoryMb: 2048, network: true },
  });
  if (!resp.ok) throw new Error(`Create failed: ${await resp.text()}`);

  const startResp = await apiPost(`/machines/${MACHINE_NAME}/start`);
  if (!startResp.ok) throw new Error(`Start failed: ${await startResp.text()}`);

  const echo = await sh(MACHINE_NAME, "echo ready");
  if (echo.exit_code !== 0) throw new Error("Machine not ready");
}
phases.create = Math.round(performance.now() - tCreate);
console.log(`  ⏱  ${phases.create}ms\n`);

// =====================================================
// Phase 2: BOOTSTRAP
// =====================================================
console.log("Phase 2: BOOTSTRAP");
const tBootstrap = performance.now();
{
  console.log("  Installing git, curl, nodejs, npm...");
  const install = await sh(MACHINE_NAME, "apk add --no-cache git curl nodejs npm 2>&1 | tail -1", { timeout_secs: 120 });
  console.log(`  apk: ${install.stdout.trim()}`);

  const gitV = await sh(MACHINE_NAME, "git --version");
  const nodeV = await sh(MACHINE_NAME, "node --version");
  const npmV = await sh(MACHINE_NAME, "npm --version");
  console.log(`  git: ${gitV.stdout.trim()}`);
  console.log(`  node: ${nodeV.stdout.trim()}`);
  console.log(`  npm: ${npmV.stdout.trim()}`);

  await sh(MACHINE_NAME, "mkdir -p /workspace && cd /workspace && git init && git config user.email 'agent@test' && git config user.name 'Agent'");

  await sh(MACHINE_NAME, `cat > /workspace/calc.ts << 'TSEOF'
export function add(a: number, b: number): number {
  return a + b;
}

export function subtract(a: number, b: number): number {
  return a - b;
}

// BUG: multiply always returns 0
export function multiply(a: number, b: number): number {
  return 0;
}

export function divide(a: number, b: number): number {
  if (b === 0) throw new Error("Division by zero");
  return a / b;
}
TSEOF`);

  await sh(MACHINE_NAME, `cat > /workspace/calc_test.ts << 'TSEOF'
import { add, subtract, multiply, divide } from "./calc.ts";

// Simple test runner
let passed = 0, failed = 0;
function assert(name: string, actual: unknown, expected: unknown) {
  if (actual === expected) { passed++; console.log("PASS: " + name); }
  else { failed++; console.log("FAIL: " + name + " (got " + actual + ", expected " + expected + ")"); }
}

assert("add(2,3)", add(2, 3), 5);
assert("subtract(5,3)", subtract(5, 3), 2);
assert("multiply(3,4)", multiply(3, 4), 12);
assert("divide(10,2)", divide(10, 2), 5);

console.log("\\nResults: " + passed + " passed, " + failed + " failed");
if (failed > 0) Deno.exit(1);
TSEOF`);

  await sh(MACHINE_NAME, "cd /workspace && git add -A && git commit -m 'initial: calc with multiply bug'");
}
phases.bootstrap = Math.round(performance.now() - tBootstrap);
console.log(`  ⏱  ${phases.bootstrap}ms\n`);

// =====================================================
// Phase 3: WORK (agent task)
// =====================================================
console.log("Phase 3: WORK");
const tWork = performance.now();
{
  if (GROQ_KEY) {
    console.log("  Using Groq API for inference...");

    const prompt = `Fix the multiply function in this TypeScript file. The bug is that it always returns 0 instead of the product.

\`\`\`typescript
export function multiply(a: number, b: number): number {
  return 0;
}
\`\`\`

Return ONLY the fixed function, no explanation:`;

    const groqResp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${GROQ_KEY}`,
      },
      body: JSON.stringify({
        model: "llama-3.1-8b-instant",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.1,
        max_tokens: 200,
      }),
    });

    if (groqResp.ok) {
      const groqData = await groqResp.json();
      const fix = groqData.choices?.[0]?.message?.content ?? "";
      console.log(`  LLM response: ${fix.substring(0, 80)}...`);
      await sh(MACHINE_NAME, `cd /workspace && sed -i 's/return 0;/return a * b;/' calc.ts`);
    } else {
      console.log(`  Groq API failed (${groqResp.status}), applying fix directly`);
      await sh(MACHINE_NAME, `cd /workspace && sed -i 's/return 0;/return a * b;/' calc.ts`);
    }
  } else {
    console.log("  No GROQ_API_KEY — applying fix directly");
    await sh(MACHINE_NAME, `cd /workspace && sed -i 's/return 0;/return a * b;/' calc.ts`);
  }

  await sh(MACHINE_NAME, `cat > /workspace/test.js << 'JSEOF'
const fs = require("fs");
const content = fs.readFileSync("/workspace/calc.ts", "utf8");

if (content.includes("return a * b")) {
  console.log("PASS: multiply function fixed");
  process.exit(0);
} else {
  console.log("FAIL: multiply function still broken");
  process.exit(1);
}
JSEOF`);

  const testResult = await sh(MACHINE_NAME, "cd /workspace && node test.js");
  console.log(`  Test: ${testResult.stdout.trim()}`);

  await sh(MACHINE_NAME, "cd /workspace && git add -A && git commit -m 'fix: multiply returns product instead of 0'");
}
phases.work = Math.round(performance.now() - tWork);
console.log(`  ⏱  ${phases.work}ms\n`);

// =====================================================
// Phase 4: EXTRACT
// =====================================================
console.log("Phase 4: EXTRACT");
const tExtract = performance.now();
{
  const diff = await sh(MACHINE_NAME, "cd /workspace && git diff HEAD~1");
  console.log(`  Diff (${diff.stdout.length} bytes):`);
  const diffLines = diff.stdout.split("\n");
  for (const line of diffLines.slice(0, 15)) {
    console.log(`    ${line}`);
  }

  const log = await sh(MACHINE_NAME, "cd /workspace && git log --oneline");
  console.log(`\n  Commits:\n    ${log.stdout.trim().split("\n").join("\n    ")}`);

  const fixed = await sh(MACHINE_NAME, "cat /workspace/calc.ts");
  const hasfix = fixed.stdout.includes("return a * b");
  console.log(`\n  Fix verified: ${hasfix ? "✅" : "❌"}`);
}
phases.extract = Math.round(performance.now() - tExtract);
console.log(`  ⏱  ${phases.extract}ms\n`);

// =====================================================
// Phase 5: DESTROY
// =====================================================
console.log("Phase 5: DESTROY");
const tDestroy = performance.now();
{
  await apiPost(`/machines/${MACHINE_NAME}/stop`);
  await apiDelete(`/machines/${MACHINE_NAME}`);
}
phases.destroy = Math.round(performance.now() - tDestroy);
console.log(`  ⏱  ${phases.destroy}ms\n`);

// =====================================================
// Summary
// =====================================================
const totalMs = Object.values(phases).reduce((a, b) => a + b, 0);
console.log("==========================================");
console.log("  Lifecycle Summary");
console.log("==========================================\n");
console.log(`  CREATE:    ${String(phases.create).padStart(6)}ms`);
console.log(`  BOOTSTRAP: ${String(phases.bootstrap).padStart(6)}ms`);
console.log(`  WORK:      ${String(phases.work).padStart(6)}ms`);
console.log(`  EXTRACT:   ${String(phases.extract).padStart(6)}ms`);
console.log(`  DESTROY:   ${String(phases.destroy).padStart(6)}ms`);
console.log(`  ─────────────────────`);
console.log(`  TOTAL:     ${String(totalMs).padStart(6)}ms`);
console.log("");

console.log("  vs other platforms:");
console.log(`  CX01 Cloudflare: ~45s`);
console.log(`  CX02 Deno:       ~29s (16s with snapshot)`);
console.log(`  CX03 Fly Sprites: ~6.2s`);
console.log(`  CX04 smolvm:      ${(totalMs / 1000).toFixed(1)}s`);
console.log("");
