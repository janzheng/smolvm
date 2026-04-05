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

const machine = await client.createAndStart("my-vm", { network: true });

const result = await machine.sh("echo hello");
console.log(result.stdout); // "hello\n"

await machine.cleanup();
```

## Execute Commands

```typescript
// Raw exec (no shell processing)
await machine.exec(["echo", "hello"]);
await machine.exec(["node", "--version"]);

// Shell convenience (pipes, redirects, &&, ||)
await machine.sh("echo hello && ls -la | wc -l");

// just-bash compatible alias
await machine.runCommand("cat /etc/os-release");

// With env vars (per-exec, not persisted)
await machine.sh("echo $API_KEY", {
  env: [{ name: "API_KEY", value: "sk-..." }],
});

// With timeout
await machine.sh("sleep 30", { timeout_secs: 5 });
```

## File I/O

Files are read/written via the exec channel using base64 encoding.
No smolvm core changes needed.

```typescript
// Write a file
await machine.writeFile("/app/main.ts", 'console.log("hello");');

// Read a file
const content = await machine.readFile("/app/main.ts");

// Write multiple files at once
await machine.writeFiles({
  "/app/index.ts": "export * from './main.ts';",
  "/app/package.json": '{"name": "test"}',
});

// List files in a directory
const files = await machine.listFiles("/app");

// Check if a file exists
const exists = await machine.exists("/app/main.ts");
```

## Fleet Operations

Create and manage multiple machines in parallel.

```typescript
// Create 3 machines, all started
const fleet = await client.createFleet("worker", 3, { network: true });

// Same command on all
const results = await fleet.execAll("echo hello");

// Different command per machine
const each = await fleet.execEach([
  "echo task-a",
  "echo task-b",
  "echo task-c",
]);

// Access individual machines
const first = fleet.at(0);
await first.writeFile("/tmp/data.json", "{}");

// Cleanup all
await fleet.cleanup();
```

## MicroVMs

Persistent VMs (different REST schema from machines).

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
await machine.pullImage("node:22-alpine");
const result = await machine.runInImage("node:22-alpine", ["node", "--version"]);
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
Machine API shape. This means you can swap between just-bash (instant,
in-browser, simulated) and smolvm (real VMs, real binaries) with minimal
code changes.

| Method | just-bash | smolvm SDK |
|--------|-----------|------------|
| Create | `Machine.create()` | `client.createAndStart()` |
| Execute | `machine.runCommand()` | `machine.runCommand()` |
| Write files | `machine.writeFiles()` | `machine.writeFiles()` |
| Cleanup | `machine.stop()` | `machine.cleanup()` |

## Testing

Requires `smolvm serve start` running:

```bash
deno task test
```
