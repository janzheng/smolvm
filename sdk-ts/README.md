# @smolvm/sdk

TypeScript SDK for [smolvm](https://smolmachines.com). Thin wrapper around
the REST API with a just-bash-compatible interface.

## Install

```bash
# Import directly (local SDK — not published to JSR)
import { SmolvmClient } from "./mod.ts";
```

## Prerequisites

smolvm must be running:

```bash
smolvm serve start
```

## Quick Start

```typescript
import { SmolvmClient } from "./mod.ts";

const client = new SmolvmClient(); // defaults to http://127.0.0.1:8080

const sandbox = await client.createAndStart("my-vm", { network: true });

const result = await sandbox.sh("echo hello");
console.log(result.stdout); // "hello\n"

await sandbox.cleanup();
```

## Execute Commands

```typescript
// Raw exec (no shell processing)
await sandbox.exec(["echo", "hello"]);
await sandbox.exec(["node", "--version"]);

// Shell convenience (pipes, redirects, &&, ||)
await sandbox.sh("echo hello && ls -la | wc -l");

// just-bash compatible alias
await sandbox.runCommand("cat /etc/os-release");

// With env vars (per-exec, not persisted)
await sandbox.sh("echo $API_KEY", {
  env: [{ name: "API_KEY", value: "sk-..." }],
});

// With timeout
await sandbox.sh("sleep 30", { timeout_secs: 5 });
```

## File I/O

Files are read/written via the exec channel using base64 encoding.
No smolvm core changes needed.

```typescript
// Write a file
await sandbox.writeFile("/app/main.ts", 'console.log("hello");');

// Read a file
const content = await sandbox.readFile("/app/main.ts");

// Write multiple files at once
await sandbox.writeFiles({
  "/app/index.ts": "export * from './main.ts';",
  "/app/package.json": '{"name": "test"}',
});

// List files in a directory
const files = await sandbox.listFiles("/app");

// Check if a file exists
const exists = await sandbox.exists("/app/main.ts");
```

## Fleet Operations

Create and manage multiple sandboxes in parallel.

```typescript
// Create 3 sandboxes, all started
const fleet = await client.createFleet("worker", 3, { network: true });

// Same command on all
const results = await fleet.execAll("echo hello");

// Different command per sandbox
const each = await fleet.execEach([
  "echo task-a",
  "echo task-b",
  "echo task-c",
]);

// Access individual sandboxes
const first = fleet.at(0);
await first.writeFile("/tmp/data.json", "{}");

// Cleanup all
await fleet.cleanup();
```

## MicroVMs

Persistent VMs (different REST schema from sandboxes).

```typescript
const vm = await client.createMicroVM("my-microvm", {
  cpus: 4,
  memoryMb: 4096,
  network: true,
});
await vm.start();

await vm.sh("echo hello");
await vm.writeFile("/data/config.json", "{}");

await vm.cleanup();
```

## OCI Images

Pull and run commands in OCI images (ephemeral overlay).

```typescript
await sandbox.pullImage("node:22-alpine");
const result = await sandbox.runInImage("node:22-alpine", ["node", "--version"]);
```

## Configuration

```typescript
// Custom URL
const client = new SmolvmClient("http://my-server:8080");

// Or via environment variable
// export SMOLVM_URL=http://my-server:8080
const client = new SmolvmClient(); // reads SMOLVM_URL
```

## API Compatibility

The SDK matches the [just-bash](https://github.com/vercel-labs/just-bash)
Sandbox API shape. This means you can swap between just-bash (instant,
in-browser, simulated) and smolvm (real VMs, real binaries) with minimal
code changes.

| Method | just-bash | smolvm SDK |
|--------|-----------|------------|
| Create | `Sandbox.create()` | `client.createAndStart()` |
| Execute | `sandbox.runCommand()` | `sandbox.runCommand()` |
| Write files | `sandbox.writeFiles()` | `sandbox.writeFiles()` |
| Cleanup | `sandbox.stop()` | `sandbox.cleanup()` |

## Testing

Requires `smolvm serve start` running:

```bash
deno task test
```
