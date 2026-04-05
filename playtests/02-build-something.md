# Playtest 02: Build Something Real

**Mission**: Use a sandbox to actually build and run a web application from
scratch. This isn't about testing endpoints — it's about whether smolvm is
useful for real dev work.

**Time**: ~20 min

## Entry point

Create a sandbox from the `claude-code` or `node` starter. Your job is
to build a small web server inside it and prove it works.

## Things to try

- Create the sandbox. How long does it take? Does the starter image work?
- Write a simple Express/Hono/Deno server — either by exec'ing shell commands
  or by using the file write API to push files in
- Install dependencies (`npm install`, `deno cache`, etc). Does it work? How
  fast?
- Start the server. Can you curl it from inside the sandbox?
  (`curl localhost:3000` via exec)
- Try writing a multi-file project: server.js, package.json, a static HTML
  file. Is the file API ergonomic or would you rather just exec
  `cat > file << EOF`?
- Try the archive endpoint — download the whole project as a tar. Extract it
  locally. Does it look right?
- Upload a tar back into a fresh sandbox. Does the project still work?
- How does it compare to just `docker run -it node:20 bash`? What's better,
  what's worse?

## What we're really testing

- Starter images actually have the tools they claim
- File I/O API is practical for real workflows (not just toy examples)
- Networking works for package installs
- The dev inner loop (edit → run → see output) works through the API
- Archive round-trip preserves project structure
