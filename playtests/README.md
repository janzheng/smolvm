# Playtests

Operational exploration scenarios for smolvm. Each playtest is a mission brief
for a human or sub-agent to pick up, run against a live server, and report back
what works, what breaks, and what feels wrong.

These are NOT scripted tests. The tester should improvise, explore edge cases,
and try to break things. The goal is to discover what we missed.

## Automated E2E Playtest

Run the full automated suite against a live server:

```bash
# Start server first (use cargo-make for correct env vars)
cd smolvm-plus && cargo make smolvm serve start

# Run all e2e playtests (in a separate terminal)
bash playtests/e2e-playtest.sh
```

Latest results (2026-03-29): 80 pass, 0 fail, 1 skip (dashboard — needs interactive terminal).
Results get appended to `PLAYTEST-LOG.md` in this directory.

## Prerequisites

- smolvm-plus built and running:
  - Preferred: `cd smolvm-plus && cargo make smolvm serve start`
  - Manual: `cd smolvm-plus && DYLD_LIBRARY_PATH=./lib ./target/release/smolvm serve start`
- `smolctl` available: `deno run -A cli/smolctl.ts` (or alias it, or set `SMOLCTL` env var)
- Deno installed (for CLI + SDK)
- For agent tests (PT-7): run `smolctl auth login` first (Claude subscription OAuth — opens browser, saves token to `.env`). Alternatively, set `ANTHROPIC_API_KEY` in env or `.env`.
- For tunnel tests (PT-10): `cloudflared` installed (`brew install cloudflared`). The test starts a quick tunnel, checks status, and stops it — takes ~30s. If another cloudflared instance is running, the health check may return HTTP 530 (noted, not a failure).

## Playtest Index

| # | File | Mission | Time |
|---|------|---------|------|
| 01 | `01-first-contact.md` | Cold start: can you get a sandbox running from zero? | 15 min |
| 02 | `02-build-something.md` | Actually build and run a web app inside a sandbox | 20 min |
| 03 | `03-break-it.md` | Adversarial: try to crash, leak, or confuse the server | 20 min |
| 04 | `04-agent-autonomy.md` | Give Claude Code a real task inside a sandbox | 30 min |
| 05 | `05-fork-and-compare.md` | Use clone/diff/merge as a real branching workflow | 20 min |
| 06 | `06-disaster-recovery.md` | Snapshot, destroy, restore — does state actually survive? | 15 min |
| 07 | `07-sdk-ergonomics.md` | Use the TS SDK to build something real. What's clunky? | 20 min |
| 08 | `08-web-ui-walkthrough.md` | Use the web UI like a real user. What's confusing? | 15 min |
| 09 | `09-tunnel-to-the-world.md` | Expose a sandbox service publicly via cloudflared | 20 min |
| 10 | `10-stress-and-limits.md` | Many sandboxes, big files, long processes — find the limits | 30 min |

## How to run a playtest

1. Read the mission brief
2. Start with the suggested entry point
3. Improvise from there — follow curiosity, try to break things
4. Record everything you do and what happens
5. Write up results at the bottom of the file

## Reporting

After each playtest, append a `## Results` section to the file with:
- **Worked**: what went smoothly
- **Broken**: what failed or errored
- **Awkward**: what technically worked but felt wrong
- **Suggestions**: ideas for improvement
- **Bugs filed**: any issues worth tracking
