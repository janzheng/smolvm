# Playtest 06: Disaster Recovery

**Mission**: Test the snapshot system under realistic conditions. Can you
actually recover from disaster? What survives, what doesn't?

**Time**: ~15 min

## Entry point

Create a sandbox, do real work in it (install packages, create files, start
services), then snapshot → destroy → restore. See what survives.

## Scenario: the full cycle

1. Create a sandbox, install some packages, create a project with multiple
   files and directories
2. Start a background process (e.g., a web server)
3. Verify everything is working
4. Snapshot it (push)
5. Destroy the sandbox completely (delete)
6. Restore from snapshot (pull into a new sandbox)
7. Check: are all files there? Are installed packages still installed?
   Is the background process running? (probably not — but is the binary
   still there?)

## Things to explore

- Snapshot a sandbox with a lot of state (installed packages, node_modules,
  venv, compiled binaries). How big is the snapshot? How long does push take?
- Snapshot, modify the sandbox, snapshot again (same name). What happens?
  Does it overwrite? Version?
- Pull the same snapshot into 3 different sandboxes. Are they independent?
- Snapshot a sandbox, modify it, then try to "revert" by pulling the old
  snapshot back. Does that work or do you need a new sandbox?
- What's in the snapshot? Can you inspect it? Is it just a tar?
- Delete a snapshot. Is it really gone? Can you pull a deleted snapshot?
- Snapshot with a running process. Restore it. What state is the process in?
- How big can a snapshot get before things break? Fill a sandbox with 1GB of
  data, then try to push it

## What we're really testing

- Snapshot fidelity — everything important survives the round-trip
- Performance with realistic payload sizes
- Edge cases: overwrite, multiple restores, deleted originals
- Whether this is reliable enough to trust with real work
