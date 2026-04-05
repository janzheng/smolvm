# Playtest 03: Break It

**Mission**: Try to crash the server, leak data between sandboxes, exhaust
resources, or otherwise make smolvm do something it shouldn't.

**Time**: ~20 min

## Entry point

Server is running. Create a couple sandboxes. Now try to be adversarial.

## Attack surface: API abuse

- Send malformed JSON. Empty body. Wrong content type. Huge payloads (1MB+
  JSON body). What errors come back?
- Create a sandbox with special characters in the name: spaces, unicode,
  `../../../etc/passwd`, null bytes, empty string, 10000-char name
- Call endpoints that don't exist. Wrong HTTP methods. GET on POST-only routes
- Hit the same endpoint 100 times rapidly — does it handle concurrency?
- Create a sandbox, then create another with the same name. What happens?

## Attack surface: sandbox escape

- Try to access the host filesystem from inside: `cat /proc/1/environ`,
  `ls /host`, `mount`
- Fork bomb: `:(){ :|:& };:` — does the sandbox contain it? Does the host
  survive?
- Fill the disk: `dd if=/dev/zero of=/tmp/fill bs=1M count=10000`
- Exhaust memory: `python3 -c "x = 'a' * (1024**3)"`
- Try to access another sandbox's filesystem from inside one sandbox
- Network probing: `curl http://169.254.169.254/latest/meta-data/` (cloud
  metadata), `curl http://localhost:8080/health` (reach back to host API)

## Attack surface: file API

- Read files outside `/workspace`: `/etc/shadow`, `/root/.ssh/id_rsa`
- Path traversal: `GET /api/v1/sandboxes/test/files/workspace/../../etc/passwd`
- Write to protected paths: `/usr/bin/`, `/etc/`
- Upload a 1GB file. Upload a file with a null byte in the name
- Symlink attack: create a symlink to `/etc/passwd` inside workspace, then
  read it via the API

## Attack surface: resource exhaustion

- Create 50 sandboxes. Does the server slow down? Does it run out of
  something?
- Run a process that never exits (`sleep infinity`). What happens to the exec
  endpoint?
- Open many concurrent exec requests to the same sandbox

## What we're really testing

- Input validation completeness
- Sandbox isolation (VM boundary holds)
- Resource limits actually work
- Error handling under stress (5xx vs clean errors)
- No information leakage in error messages
