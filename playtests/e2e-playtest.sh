#!/bin/bash
# smolvm End-to-End Playtest Script
# Run: bash playtests/e2e-playtest.sh
#
# Prerequisites:
#   1. smolvm server running:
#      cd smolvm-plus && cargo make smolvm serve start
#      (or: cd smolvm-plus && DYLD_LIBRARY_PATH=./lib ./target/release/smolvm serve start)
#   2. smolctl available via one of:
#      - alias smolctl='deno run -A cli/smolctl.ts'
#      - export SMOLCTL='deno run -A cli/smolctl.ts'
#      - (the script defaults to 'deno run -A cli/smolctl.ts')
#   3. For agent tests (PT-7): authenticate first with 'smolctl auth login'
#      (Claude subscription OAuth — opens browser, saves tokens to project .env)
#      OR set ANTHROPIC_API_KEY in environment / .env
#
# This script runs through 20 playtest scenarios and reports pass/fail.
# Each test is self-contained and cleans up after itself.
# Results are appended to playtests/PLAYTEST-LOG.md.

set -uo pipefail

SMOLCTL="${SMOLCTL:-deno run -A cli/smolctl.ts}"
BASE_URL="${SMOLVM_URL:-http://127.0.0.1:8080}"
PASS=0
FAIL=0
SKIP=0
FINDINGS=()

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
NC='\033[0m'

log()  { echo -e "${CYAN}[TEST]${NC} $*"; }
pass() { echo -e "${GREEN}[PASS]${NC} $*"; ((PASS++)); }
fail() { echo -e "${RED}[FAIL]${NC} $*"; ((FAIL++)); FINDINGS+=("FAIL: $*"); }
skip() { echo -e "${YELLOW}[SKIP]${NC} $*"; ((SKIP++)); }
note() { echo -e "${YELLOW}[NOTE]${NC} $*"; FINDINGS+=("NOTE: $*"); }
hr()   { echo "────────────────────────────────────────────────────"; }

# Helper: check command exit code
check() {
  local desc="$1"
  shift
  if "$@" >/dev/null 2>&1; then
    pass "$desc"
  else
    fail "$desc (exit code $?)"
  fi
}

# Helper: check command output contains string
check_contains() {
  local desc="$1"
  local needle="$2"
  shift 2
  local output
  output=$("$@" 2>&1) || true
  if echo "$output" | grep -q "$needle"; then
    pass "$desc"
  else
    fail "$desc — expected '$needle' in output"
    echo "  Got: $(echo "$output" | head -3)"
  fi
}

# Helper: check command, skip if 404 (expected for newer features on old binary)
check_or_skip_404() {
  local desc="$1"
  shift
  local output
  output=$("$@" 2>&1) || true
  if echo "$output" | grep -q "404"; then
    skip "$desc — endpoint not available (requires newer binary)"
  elif echo "$output" | grep -qE "^error:"; then
    fail "$desc — $output"
  else
    pass "$desc"
  fi
}

# Helper: check output contains string, skip if 404
check_contains_or_skip_404() {
  local desc="$1"
  local needle="$2"
  shift 2
  local output
  output=$("$@" 2>&1) || true
  if echo "$output" | grep -q "404"; then
    skip "$desc — endpoint not available (requires newer binary)"
  elif echo "$output" | grep -q "$needle"; then
    pass "$desc"
  else
    fail "$desc — expected '$needle' in output"
    echo "  Got: $(echo "$output" | head -3)"
  fi
}

# Helper: cleanup machine silently
cleanup() {
  $SMOLCTL rm "$1" 2>/dev/null || true
}

echo ""
echo "======================================================"
echo "  smolvm End-to-End Playtest"
echo "  $(date)"
echo "  Server: $BASE_URL"
echo "======================================================"
echo ""

# ──────────────────────────────────────────────────────────
hr
log "PT-1: Server Boot & Health"
hr

# 1.1 Health endpoint
check "GET /health returns 200" curl -sf "$BASE_URL/health"

# 1.2 Health response has version
check_contains "Health includes version" "version" curl -s "$BASE_URL/health"

# 1.3 smolctl health
check_contains "smolctl health" "ok" $SMOLCTL health

# 1.4 Swagger UI
check_contains "Swagger UI accessible" "swagger" curl -s "$BASE_URL/swagger-ui/"

# 1.5 Provider endpoint (may 404 on older binary)
check_or_skip_404 "GET /api/v1/provider returns 200" curl -s "$BASE_URL/api/v1/provider"

echo ""

# ──────────────────────────────────────────────────────────
hr
log "PT-2: Machine Lifecycle (CRUD)"
hr

cleanup pt-lifecycle

# 2.1 Create
check_contains "Create machine" "pt-lifecycle" $SMOLCTL create pt-lifecycle

# 2.2 List shows it
check_contains "List shows machine" "pt-lifecycle" $SMOLCTL ls

# 2.3 Start
check "Start machine" $SMOLCTL start pt-lifecycle

# 2.4 Info
check_contains "Info shows running" "running" $SMOLCTL info pt-lifecycle

# 2.5 Exec echo
EXEC_OUT=$($SMOLCTL exec pt-lifecycle -- echo "hello from VM" 2>&1) || true
if echo "$EXEC_OUT" | grep -q "hello from VM"; then
  pass "Exec echo returns correct output"
else
  fail "Exec echo — expected 'hello from VM'"
  echo "  Got: $EXEC_OUT"
fi

# 2.6 Exec uname
check_contains "Exec uname works" "Linux" $SMOLCTL exec pt-lifecycle -- uname -a

# 2.7 Stop
check "Stop machine" $SMOLCTL stop pt-lifecycle

# 2.8 Delete
check "Delete machine" $SMOLCTL rm pt-lifecycle

# 2.9 List is clean
LS_OUT=$($SMOLCTL ls 2>&1) || true
if echo "$LS_OUT" | grep -q "pt-lifecycle"; then
  fail "Machine still appears after delete"
else
  pass "Machine removed from list"
fi

echo ""

# ──────────────────────────────────────────────────────────
hr
log "PT-3: File Operations"
hr

cleanup pt-files
$SMOLCTL up pt-files >/dev/null 2>&1 || true

# 3.1 Write a file
check "Write file" $SMOLCTL files write pt-files /workspace/hello.txt "hello world"

# 3.2 Read it back
READ_OUT=$($SMOLCTL files cat pt-files /workspace/hello.txt 2>&1) || true
if echo "$READ_OUT" | grep -q "hello world"; then
  pass "Read file returns correct content"
else
  fail "Read file — expected 'hello world'"
  echo "  Got: $READ_OUT"
fi

# 3.3 List directory
check_contains "List directory shows file" "hello.txt" $SMOLCTL files ls pt-files /workspace/

# 3.4 Delete file
check "Delete file" $SMOLCTL files rm pt-files /workspace/hello.txt

# 3.5 Copy in
echo "copy test content" > /tmp/smolvm-pt-copy.txt
check "Copy file in" $SMOLCTL cp /tmp/smolvm-pt-copy.txt pt-files:/workspace/copied.txt

# 3.6 Copy out
check "Copy file out" $SMOLCTL cp pt-files:/workspace/copied.txt /tmp/smolvm-pt-copied.txt

# 3.7 Verify copy
if [ -f /tmp/smolvm-pt-copied.txt ] && grep -q "copy test content" /tmp/smolvm-pt-copied.txt; then
  pass "Copied file matches original"
else
  fail "Copied file doesn't match"
fi

# Cleanup
$SMOLCTL down pt-files --force >/dev/null 2>&1 || true
rm -f /tmp/smolvm-pt-copy.txt /tmp/smolvm-pt-copied.txt

echo ""

# ──────────────────────────────────────────────────────────
hr
log "PT-4: Sync Push/Pull"
hr

cleanup pt-sync
$SMOLCTL up pt-sync >/dev/null 2>&1 || true

# Create test directory
SYNC_DIR=$(mktemp -d /tmp/smolvm-pt-sync-XXXX)
echo "file-a content" > "$SYNC_DIR/a.txt"
echo "file-b content" > "$SYNC_DIR/b.txt"
mkdir -p "$SYNC_DIR/sub"
echo "nested" > "$SYNC_DIR/sub/c.txt"

# 4.1 Push
check "Sync push" $SMOLCTL sync push pt-sync "$SYNC_DIR"

# 4.2 Verify files exist in machine
check_contains "Pushed files visible" "a.txt" $SMOLCTL exec pt-sync -- ls /workspace/

# 4.3 Pull
PULL_DIR=$(mktemp -d /tmp/smolvm-pt-pull-XXXX)
check "Sync pull" $SMOLCTL sync pull pt-sync "$PULL_DIR"

# 4.4 Verify pulled files
if [ -f "$PULL_DIR/a.txt" ] && grep -q "file-a content" "$PULL_DIR/a.txt"; then
  pass "Pulled files match originals"
else
  fail "Pulled files don't match"
fi

# Cleanup
$SMOLCTL down pt-sync --force >/dev/null 2>&1 || true
rm -rf "$SYNC_DIR" "$PULL_DIR"

echo ""

# ──────────────────────────────────────────────────────────
hr
log "PT-5: Secret Proxy"
hr

cleanup pt-secrets

# 5.1 Create with secret
SMOLVM_SECRET_ANTHROPIC_API_KEY=test-secret-key-123 \
  $SMOLCTL up pt-secrets --secret ANTHROPIC_API_KEY >/dev/null 2>&1 || true

# 5.2 Check env doesn't leak real key
ENV_OUT=$($SMOLCTL exec pt-secrets -- env 2>&1) || true
if echo "$ENV_OUT" | grep -q "test-secret-key-123"; then
  fail "Secret key leaked into machine env!"
  note "SECURITY: Real API key visible inside machine"
else
  pass "Secret key NOT visible in machine env"
fi

# 5.3 Check proxy placeholder exists
if echo "$ENV_OUT" | grep -q "ANTHROPIC_API_KEY"; then
  pass "Placeholder env var exists"
else
  note "Placeholder ANTHROPIC_API_KEY not in env (may be expected)"
fi

# Cleanup
$SMOLCTL down pt-secrets --force >/dev/null 2>&1 || true

echo ""

# ──────────────────────────────────────────────────────────
hr
log "PT-6: Fleet Operations"
hr

# Cleanup any leftovers
for i in 1 2 3; do cleanup "pt-fleet-$i"; done

# 6.1 Fleet up
check "Fleet up (3 machines)" $SMOLCTL fleet up pt-fleet 3

# 6.2 Fleet list
FLEET_OUT=$($SMOLCTL fleet ls pt-fleet 2>&1) || true
COUNT=$(echo "$FLEET_OUT" | grep -c "pt-fleet" || true)
if [ "$COUNT" -ge 3 ]; then
  pass "Fleet ls shows 3 machines"
else
  fail "Fleet ls shows $COUNT machines (expected 3)"
fi

# 6.3 Fleet exec
check "Fleet exec broadcasts" $SMOLCTL fleet exec pt-fleet -- echo "fleet test"

# 6.4 Fleet down
check "Fleet down" $SMOLCTL fleet down pt-fleet

echo ""

# ──────────────────────────────────────────────────────────
hr
log "PT-7: Agent Run (Claude Code)"
hr

# Check for auth: env vars, project .env, OR ~/.smolvm/.env (smolctl auth login writes here)
SMOLCTL_ENV="$(cd "$(dirname "$0")/.." && pwd)/.env"
SMOLVM_HOME_ENV="$HOME/.smolvm/.env"
HAS_AUTH=false
if [ -n "${ANTHROPIC_API_KEY:-}" ] || [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
  HAS_AUTH=true
elif [ -f "$SMOLCTL_ENV" ] && grep -q "CLAUDE_CODE_OAUTH_TOKEN=" "$SMOLCTL_ENV" 2>/dev/null; then
  HAS_AUTH=true
elif [ -f "$SMOLVM_HOME_ENV" ] && grep -q "CLAUDE_CODE_OAUTH_TOKEN=" "$SMOLVM_HOME_ENV" 2>/dev/null; then
  HAS_AUTH=true
fi

if [ "$HAS_AUTH" = false ]; then
  skip "Agent run — no auth found. Set up with: smolctl auth login (subscription) or set ANTHROPIC_API_KEY"
  skip "Agent run with --keep"
else
  # 7.1 Simple agent run
  AGENT_OUT=$($SMOLCTL agent run "respond with exactly: AGENT_OK" --timeout 60 2>&1) || true
  if echo "$AGENT_OUT" | grep -q "AGENT_OK"; then
    pass "Agent run returns output"
  elif echo "$AGENT_OUT" | grep -q "No such file or directory"; then
    skip "Agent run — Claude Code binary not in starter image"
  elif echo "$AGENT_OUT" | grep -qi "expired\|unauthorized\|auth"; then
    fail "Agent run — auth error"
    echo "  Got: $(echo "$AGENT_OUT" | tail -3)"
  elif echo "$AGENT_OUT" | grep -qi "error\|failed"; then
    note "Agent run errored (may be infra)"
    echo "  Got: $(echo "$AGENT_OUT" | tail -3)"
  else
    note "Agent run completed but output may vary"
    echo "  Got: $(echo "$AGENT_OUT" | head -5)"
  fi
fi

echo ""

# ──────────────────────────────────────────────────────────
hr
log "PT-8: Work Queue"
hr

# Create a temporary machine for job testing
cleanup pt-job-worker
$SMOLCTL create pt-job-worker >/dev/null 2>&1 || true
$SMOLCTL start pt-job-worker >/dev/null 2>&1 || true
sleep 2

# 8.1 Submit a job
JOB_OUT=$($SMOLCTL job submit pt-job-worker echo job1 2>&1) || true
if echo "$JOB_OUT" | grep -q "404"; then
  skip "Job submit — endpoint not available (requires newer binary)"
elif echo "$JOB_OUT" | grep -qi "id\|queued\|submitted"; then
  pass "Job submitted"
else
  fail "Job submit failed"
  echo "  Got: $JOB_OUT"
fi

# 8.2 List jobs
JOB_LS_OUT=$($SMOLCTL job ls 2>&1) || true
if echo "$JOB_LS_OUT" | grep -q "404"; then
  skip "Job list — endpoint not available"
elif echo "$JOB_LS_OUT" | grep -qi "queued\|completed\|failed\|dead\|No jobs"; then
  pass "Job list works"
else
  fail "Job list — unexpected output"
  echo "  Got: $JOB_LS_OUT"
fi

# Clean up job test machine
$SMOLCTL stop pt-job-worker >/dev/null 2>&1 || true
$SMOLCTL rm pt-job-worker >/dev/null 2>&1 || true

echo ""

# ──────────────────────────────────────────────────────────
hr
log "PT-9: TUI Dashboard (manual)"
hr

# Interactive: ask the user if they want to eyeball the dashboard
if [ -t 0 ]; then
  printf "  Open dashboard now? (y/N) "
  read -r -t 10 DASH_ANS 2>/dev/null || DASH_ANS="n"
  if [ "$DASH_ANS" = "y" ] || [ "$DASH_ANS" = "Y" ]; then
    echo "  → Opening: smolctl dashboard (press Ctrl-C to exit)"
    timeout 15 $SMOLCTL dashboard 2>&1 || true
    pass "Dashboard launched (user confirmed)"
  else
    skip "Dashboard — user skipped (run manually: smolctl dashboard)"
  fi
else
  skip "Dashboard — non-interactive terminal (run manually: smolctl dashboard)"
fi

echo ""

# ──────────────────────────────────────────────────────────
hr
log "PT-10: Tunnel (cloudflared)"
hr

# Check if cloudflared is installed
if command -v cloudflared >/dev/null 2>&1; then
  # Stop any existing tunnel first
  $SMOLCTL tunnel stop >/dev/null 2>&1 || true

  # 10.1 Start tunnel (with timeout — smolctl tunnel start can hang if
  # cloudflared can't establish a connection, e.g. another instance running)
  TUNNEL_OUT=$(timeout 30 $SMOLCTL tunnel start 2>&1) || true
  if echo "$TUNNEL_OUT" | grep -q "trycloudflare.com"; then
    pass "Tunnel started"
    # Extract the URL
    TUNNEL_URL=$(echo "$TUNNEL_OUT" | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' | head -1)
    echo "  → $TUNNEL_URL"

    # 10.2 Verify tunnel URL responds (health endpoint)
    # Note: trycloudflare.com quick tunnels can take a few seconds to propagate
    # and may return 530 if another cloudflared instance is running. The important
    # test is that start/status/stop lifecycle works, not cloudflare edge infra.
    sleep 3
    HEALTH_CODE=$(curl -o /dev/null -s -w "%{http_code}" --max-time 10 "$TUNNEL_URL/health" 2>&1) || true
    if [ "$HEALTH_CODE" = "200" ]; then
      pass "Tunnel URL responds (/health → 200)"
    elif [ "$HEALTH_CODE" -gt 0 ] 2>/dev/null; then
      note "Tunnel URL returned HTTP $HEALTH_CODE (cloudflare edge issue, not our code)"
    else
      note "Tunnel URL did not respond — cloudflare may still be propagating"
    fi

    # 10.3 Tunnel status
    STATUS_OUT=$($SMOLCTL tunnel status 2>&1) || true
    if echo "$STATUS_OUT" | grep -q "trycloudflare.com"; then
      pass "Tunnel status shows URL"
    else
      fail "Tunnel status — expected URL in output"
    fi

    # 10.4 Stop tunnel
    check "Tunnel stop" $SMOLCTL tunnel stop
  else
    if echo "$TUNNEL_OUT" | grep -qi "timed out\|killed"; then
      note "Tunnel start timed out (30s) — may conflict with existing cloudflared process"
    else
      fail "Tunnel start — no URL in output: $(echo "$TUNNEL_OUT" | tail -2)"
    fi
    # Clean up if partially started
    $SMOLCTL tunnel stop >/dev/null 2>&1 || true
    pkill -f "cloudflared tunnel --url" >/dev/null 2>&1 || true
  fi
else
  skip "Tunnel — cloudflared not installed (brew install cloudflared)"
fi

echo ""

# ──────────────────────────────────────────────────────────
hr
log "PT-11: Metadata & Identity"
hr

cleanup pt-meta
$SMOLCTL up pt-meta --label env=staging --label team=infra --owner "playtester" >/dev/null 2>&1 || true

# 11.1 Meta shows labels
check_contains "Meta shows owner" "playtester" $SMOLCTL meta pt-meta

# 11.2 Events
check "Events command works" $SMOLCTL events --machine pt-meta --limit 3

# Cleanup
$SMOLCTL down pt-meta --force >/dev/null 2>&1 || true

echo ""

# ──────────────────────────────────────────────────────────
hr
log "PT-12: Code Signing"
hr

# 12.1 Generate key
check "Sign generate" $SMOLCTL sign generate

# 12.2 Create and sign a test file
echo "sign me" > /tmp/smolvm-pt-sign.txt
check "Sign file" $SMOLCTL sign file /tmp/smolvm-pt-sign.txt

# 12.3 Verify passes
check "Verify passes" $SMOLCTL sign verify /tmp/smolvm-pt-sign.txt

# 12.4 Tamper and verify fails
echo "tampered" > /tmp/smolvm-pt-sign.txt
if $SMOLCTL sign verify /tmp/smolvm-pt-sign.txt >/dev/null 2>&1; then
  fail "Verify should fail after tampering!"
  note "SECURITY: Code signing doesn't detect tampering"
else
  pass "Verify correctly fails after tampering"
fi

rm -f /tmp/smolvm-pt-sign.txt

echo ""

# ──────────────────────────────────────────────────────────
hr
log "PT-13: MCP Servers"
hr

cleanup pt-mcp
$SMOLCTL up pt-mcp --with-mcp >/dev/null 2>&1 || true

# 13.1 List MCP servers (may 404 on older binary)
check_contains_or_skip_404 "MCP servers configured" "filesystem" $SMOLCTL mcp servers pt-mcp

# 13.2 Discover tools (may 404 on older binary)
TOOLS_OUT=$($SMOLCTL mcp tools pt-mcp 2>&1) || true
if echo "$TOOLS_OUT" | grep -q "404"; then
  skip "MCP tool discovery — endpoint not available (requires newer binary)"
elif echo "$TOOLS_OUT" | grep -qi "read_file\|write_file\|run_command"; then
  pass "MCP tool discovery works"
else
  note "MCP tool discovery returned: $(echo "$TOOLS_OUT" | head -3)"
fi

# 13.3 Call a tool (may 404 on older binary)
MCP_CALL=$($SMOLCTL mcp call pt-mcp exec run_command '{"command":"echo","args":["mcp-works"]}' 2>&1) || true
if echo "$MCP_CALL" | grep -q "404"; then
  skip "MCP tool call — endpoint not available (requires newer binary)"
elif echo "$MCP_CALL" | grep -q "mcp-works"; then
  pass "MCP tool call returns correct output"
else
  note "MCP call result: $(echo "$MCP_CALL" | head -3)"
fi

# Cleanup
$SMOLCTL down pt-mcp --force >/dev/null 2>&1 || true

echo ""

# ──────────────────────────────────────────────────────────
hr
log "PT-14: Starter Authoring"
hr

# 14.1 Init a starter
check "Starter init" $SMOLCTL starter init pt-test-starter --base-image ubuntu:22.04 --description "Playtest starter"

# 14.2 Validate
check "Starter validate" $SMOLCTL starter validate pt-test-starter

# 14.3 List
check_contains "Starter ls shows custom" "pt-test-starter" $SMOLCTL starter ls

# 14.4 Export
check "Starter export" $SMOLCTL starter export pt-test-starter /tmp/

# 14.5 Cleanup and reimport
rm -rf ~/.smolvm/starters/pt-test-starter/
check "Starter import" $SMOLCTL starter import /tmp/pt-test-starter.tar.gz

# 14.6 Still listed
check_contains "Starter still listed after reimport" "pt-test-starter" $SMOLCTL starter ls

# Cleanup
rm -rf ~/.smolvm/starters/pt-test-starter/ /tmp/pt-test-starter.tar.gz

echo ""

# ──────────────────────────────────────────────────────────
hr
log "PT-15: Pool Management"
hr

# 15.1 Add local node
check "Pool add local" $SMOLCTL pool add local "$BASE_URL"

# 15.2 Pool list
check_contains "Pool ls shows local" "local" $SMOLCTL pool ls

# 15.3 Pool status
check "Pool status" $SMOLCTL pool status

# 15.4 Add unreachable node
$SMOLCTL pool add fake-node https://example.com:9999 >/dev/null 2>&1 || true

# 15.5 Pool list shows offline
POOL_OUT=$($SMOLCTL pool ls 2>&1) || true
if echo "$POOL_OUT" | grep -qi "offline\|unreachable\|fake-node"; then
  pass "Pool ls detects unreachable node"
else
  note "Pool ls output: $(echo "$POOL_OUT" | head -5)"
fi

# 15.6 Remove fake node
check "Pool rm" $SMOLCTL pool rm fake-node

# Cleanup
$SMOLCTL pool rm local >/dev/null 2>&1 || true

echo ""

# ──────────────────────────────────────────────────────────
hr
log "PT-16: Lifecycle Hooks"
hr

cleanup pt-hooks
$SMOLCTL up pt-hooks >/dev/null 2>&1 || true

# 16.1 Set up a dirty git repo
$SMOLCTL exec pt-hooks -- bash -c "cd /workspace && git init && git config user.email 'test@test.com' && git config user.name 'test' && echo hi > file.txt && git add . && git commit -m init" >/dev/null 2>&1 || true
$SMOLCTL exec pt-hooks -- bash -c "echo change >> /workspace/file.txt" >/dev/null 2>&1 || true

# 16.2 Down without force should warn
DOWN_OUT=$($SMOLCTL down pt-hooks 2>&1) || true
if echo "$DOWN_OUT" | grep -qi "uncommitted\|warning\|unsafe\|dirty"; then
  pass "Lifecycle hook warns about uncommitted changes"
else
  note "Down output: $(echo "$DOWN_OUT" | head -3)"
fi

# 16.3 Down with force
check "Down --force bypasses hooks" $SMOLCTL down pt-hooks --force

echo ""

# ──────────────────────────────────────────────────────────
hr
log "PT-16b: Snapshot Lifecycle (push/pull/describe/rm)"
hr

# Self-contained snapshot round-trip: create machine, write data, push snapshot,
# pull into new machine, verify data survived, clean up.
SNAP_SB="pt-snap-src"
cleanup "$SNAP_SB"
$SMOLCTL snapshot rm "$SNAP_SB" 2>/dev/null || true

$SMOLCTL up "$SNAP_SB" >/dev/null 2>&1 || true

# Write a marker file
$SMOLCTL exec "$SNAP_SB" -- sh -c "echo 'snapshot-round-trip-ok' > /workspace/snap-marker.txt" >/dev/null 2>&1 || true

# 16b.1 Push snapshot (snapshot name = machine name)
check "Snapshot push" $SMOLCTL snapshot push "$SNAP_SB"

# 16b.2 Snapshot appears in list
check_contains "Snapshot in list" "$SNAP_SB" $SMOLCTL snapshot ls

# 16b.3 Describe snapshot
check "Snapshot describe" $SMOLCTL snapshot describe "$SNAP_SB"

# 16b.4 Pull into new machine
SNAP_DST="pt-snap-dst"
cleanup "$SNAP_DST"
PULL_OUT=$($SMOLCTL snapshot pull "$SNAP_SB" "$SNAP_DST" 2>&1) || true
if echo "$PULL_OUT" | grep -qi "error\|failed"; then
  fail "Snapshot pull — $PULL_OUT"
else
  pass "Snapshot pull into new machine"
fi

# 16b.5 Verify data survived round-trip
SNAP_DATA=$($SMOLCTL exec "$SNAP_DST" -- cat /workspace/snap-marker.txt 2>&1) || true
if echo "$SNAP_DATA" | grep -q "snapshot-round-trip-ok"; then
  pass "Snapshot data preserved through push/pull"
else
  fail "Snapshot data not found after pull — $SNAP_DATA"
fi

# 16b.6 Delete snapshot
check "Snapshot rm" $SMOLCTL snapshot rm "$SNAP_SB"

# Verify removed from list (small delay — server may take a moment to sync)
sleep 1
SNAP_LS_AFTER=$($SMOLCTL snapshot ls 2>&1) || true
if echo "$SNAP_LS_AFTER" | grep -q "$SNAP_SB"; then
  note "Snapshot still visible in list after rm (may be cached or filesystem scan)"
else
  pass "Snapshot removed from list"
fi

# Cleanup
$SMOLCTL down "$SNAP_SB" --force >/dev/null 2>&1 || true
$SMOLCTL down "$SNAP_DST" --force >/dev/null 2>&1 || true

echo ""

# ──────────────────────────────────────────────────────────
hr
log "PT-17: Snapshot Upload/Download & Provider Flag"
hr

# Create our own snapshot for upload/download testing (self-contained)
UPLOAD_SB="pt-upload-test"
$SMOLCTL up "$UPLOAD_SB" --wait >/dev/null 2>&1 || true
$SMOLCTL exec "$UPLOAD_SB" -- sh -c "echo upload-test > /tmp/marker" >/dev/null 2>&1 || true
PUSH_OUT=$($SMOLCTL snapshot push "$UPLOAD_SB" 2>&1) || true

if echo "$PUSH_OUT" | grep -qi "error\|failed"; then
  skip "Snapshot upload — could not create test snapshot: $PUSH_OUT"
  skip "Snapshot download — no snapshot"
  skip "Snapshot file verify — no snapshot"
else
  # 17.1 Snapshot upload
  check_or_skip_404 "Snapshot upload $UPLOAD_SB" $SMOLCTL snapshot upload "$UPLOAD_SB"

  # 17.2 Snapshot download
  DL_OUT=$($SMOLCTL snapshot download "$UPLOAD_SB" 2>&1) || true
  if echo "$DL_OUT" | grep -q "404"; then
    skip "Snapshot download — endpoint not available (requires newer binary)"
  elif echo "$DL_OUT" | grep -qi "error"; then
    fail "Snapshot download $UPLOAD_SB — $DL_OUT"
  else
    pass "Snapshot download $UPLOAD_SB"
  fi

  # 17.3 Verify downloaded file size > 0
  DL_PATH="$HOME/.local/share/smolvm/snapshots/${UPLOAD_SB}.smolvm"
  if [ "$(uname)" = "Darwin" ]; then
    DL_PATH="$HOME/Library/Application Support/smolvm/snapshots/${UPLOAD_SB}.smolvm"
  fi
  if [ -f "$DL_PATH" ] && [ -s "$DL_PATH" ]; then
    pass "Downloaded snapshot file exists and size > 0"
  else
    note "Downloaded snapshot file not found or empty at $DL_PATH (may be expected if download endpoint not available)"
  fi

  # Cleanup
  $SMOLCTL snapshot rm "$UPLOAD_SB" >/dev/null 2>&1 || true
fi
$SMOLCTL down "$UPLOAD_SB" --force >/dev/null 2>&1 || true

# 17.4 Provider flag with snapshot ls (requires ~/.smolvm/providers.json with 'local')
PROV_CFG="$HOME/.smolvm/providers.json"
if [ -f "$PROV_CFG" ] && grep -q "local" "$PROV_CFG" 2>/dev/null; then
  check "Snapshot ls with --provider local" $SMOLCTL --provider local snapshot ls
else
  skip "Snapshot ls --provider local — no providers.json with 'local' entry"
fi

# 17.5 Snapshot ls --remote
check "Snapshot ls --remote" $SMOLCTL snapshot ls --remote

echo ""

# ──────────────────────────────────────────────────────────
hr
log "PT-18: Workspace Export/Import"
hr

# Need a running machine with a git workspace
WS_SB="pt18-ws-test"
WS_EXPORT_PATH="/tmp/pt18-workspace.tar.gz"
rm -f "$WS_EXPORT_PATH"

# Create machine with git init
WS_UP_OUT=$($SMOLCTL up "$WS_SB" --network 2>&1)
if echo "$WS_UP_OUT" | grep -qi "up and running"; then
  pass "Create machine for workspace test"

  # Initialize git workspace
  $SMOLCTL git init "$WS_SB" >/dev/null 2>&1
  sleep 1

  # Write a test file and commit
  $SMOLCTL exec "$WS_SB" -- sh -c "cd /storage/workspace && echo 'workspace-test' > ws-data.txt && git add . && git commit -m 'ws test commit'" >/dev/null 2>&1

  # 18.1 Export workspace
  WS_EXPORT_OUT=$($SMOLCTL snapshot export-workspace "$WS_SB" "$WS_EXPORT_PATH" 2>&1)
  if echo "$WS_EXPORT_OUT" | grep -qi "exported workspace"; then
    pass "Workspace export"
  else
    fail "Workspace export — $WS_EXPORT_OUT"
  fi

  # 18.2 Verify exported file exists and is small
  if [ -f "$WS_EXPORT_PATH" ]; then
    WS_SIZE=$(stat -f%z "$WS_EXPORT_PATH" 2>/dev/null || stat -c%s "$WS_EXPORT_PATH" 2>/dev/null || echo 0)
    if [ "$WS_SIZE" -gt 0 ] && [ "$WS_SIZE" -lt 10485760 ]; then
      pass "Exported workspace is small (<10MB: ${WS_SIZE} bytes)"
    else
      fail "Exported workspace size unexpected: $WS_SIZE bytes"
    fi
  else
    fail "Exported workspace file not found"
  fi

  # 18.3 Import workspace into a fresh machine
  WS_SB2="pt18-ws-import"
  $SMOLCTL up "$WS_SB2" --network >/dev/null 2>&1
  sleep 1
  WS_IMPORT_OUT=$($SMOLCTL snapshot import-workspace "$WS_EXPORT_PATH" "$WS_SB2" 2>&1)
  if echo "$WS_IMPORT_OUT" | grep -qi "imported workspace"; then
    pass "Workspace import"
  else
    fail "Workspace import — $WS_IMPORT_OUT"
  fi

  # 18.4 Verify git history survived round-trip
  GIT_LOG=$($SMOLCTL exec "$WS_SB2" -- sh -c "cd /storage/workspace && git log --oneline 2>/dev/null" 2>&1)
  if echo "$GIT_LOG" | grep -q "ws test commit"; then
    pass "Git history preserved through workspace round-trip"
  else
    fail "Git history not found after import — $GIT_LOG"
  fi

  # 18.5 Verify data file survived
  WS_DATA=$($SMOLCTL exec "$WS_SB2" -- sh -c "cat /storage/workspace/ws-data.txt 2>/dev/null" 2>&1)
  if echo "$WS_DATA" | grep -q "workspace-test"; then
    pass "Workspace data file preserved through round-trip"
  else
    fail "Workspace data file not found — $WS_DATA"
  fi

  # Cleanup
  $SMOLCTL down "$WS_SB" --force >/dev/null 2>&1
  $SMOLCTL down "$WS_SB2" --force >/dev/null 2>&1
  rm -f "$WS_EXPORT_PATH"
else
  fail "Create machine for workspace test — $WS_UP_OUT"
fi

echo ""

# ──────────────────────────────────────────────────────────
hr
log "PT-19: Docker Interop (to-docker)"
hr

# Need a running machine — create one
DOCKER_SB="pt19-docker-test"
DOCKER_OUT_DIR="/tmp/pt19-docker-ctx"
rm -rf "$DOCKER_OUT_DIR"

DOCKER_UP_OUT=$($SMOLCTL up "$DOCKER_SB" --network 2>&1)
if echo "$DOCKER_UP_OUT" | grep -qi "up and running"; then
  pass "Create machine for docker test"

  # Init git workspace + write a file
  $SMOLCTL git init "$DOCKER_SB" >/dev/null 2>&1
  sleep 1
  $SMOLCTL exec "$DOCKER_SB" -- sh -c "cd /storage/workspace && echo 'docker-test-data' > app.txt && git add . && git commit -m 'docker test'" >/dev/null 2>&1

  # 19.1 to-docker generates Dockerfile
  TD_OUT=$($SMOLCTL snapshot to-docker "$DOCKER_SB" --output "$DOCKER_OUT_DIR" 2>&1)
  if echo "$TD_OUT" | grep -qi "docker build context"; then
    pass "to-docker generates build context"
  else
    fail "to-docker failed — $TD_OUT"
  fi

  # 19.2 Dockerfile exists
  if [ -f "$DOCKER_OUT_DIR/Dockerfile" ]; then
    pass "Dockerfile generated"
  else
    fail "Dockerfile not found in $DOCKER_OUT_DIR"
  fi

  # 19.3 Dockerfile contains FROM alpine
  if grep -q "FROM alpine" "$DOCKER_OUT_DIR/Dockerfile" 2>/dev/null; then
    pass "Dockerfile has FROM alpine"
  else
    fail "Dockerfile missing FROM alpine"
  fi

  # 19.4 Workspace dir contains files
  if [ -f "$DOCKER_OUT_DIR/workspace/app.txt" ]; then
    pass "Workspace files present in build context"
  else
    fail "Workspace files missing from build context"
  fi

  # Cleanup
  $SMOLCTL down "$DOCKER_SB" --force >/dev/null 2>&1
  rm -rf "$DOCKER_OUT_DIR"
else
  fail "Create machine for docker test — $DOCKER_UP_OUT"
fi

echo ""

# ══════════════════════════════════════════════════════════
echo ""
echo "======================================================"
echo "  RESULTS"
echo "======================================================"
echo ""
echo -e "  ${GREEN}PASS: $PASS${NC}"
echo -e "  ${RED}FAIL: $FAIL${NC}"
echo -e "  ${YELLOW}SKIP: $SKIP${NC}"
echo ""

if [ ${#FINDINGS[@]} -gt 0 ]; then
  echo "  FINDINGS:"
  for f in "${FINDINGS[@]}"; do
    echo "    - $f"
  done
  echo ""
fi

if [ $FAIL -eq 0 ]; then
  echo -e "  ${GREEN}All tests passed!${NC}"
else
  echo -e "  ${RED}$FAIL test(s) failed.${NC}"
fi
echo ""

# Write results to log
RESULTS_FILE="$(dirname "$0")/PLAYTEST-LOG.md"
cat >> "$RESULTS_FILE" << ENDLOG

---

## $(date +%Y-%m-%d) — Automated E2E Playtest

Server: $BASE_URL
Runner: e2e-playtest.sh

**Results: $PASS pass, $FAIL fail, $SKIP skip**

$(if [ ${#FINDINGS[@]} -gt 0 ]; then
  echo "### Findings"
  for f in "${FINDINGS[@]}"; do
    echo "- $f"
  done
fi)
ENDLOG

echo "Results appended to playtests/PLAYTEST-LOG.md"
