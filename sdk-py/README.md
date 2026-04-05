# smolvm Python SDK

Async Python client for [smolvm](https://smolmachines.com) — OCI-native microVM runtime.

Mirrors the TypeScript SDK's API surface for cross-language consistency.

## Install

```sh
# Local SDK — not published to PyPI
# Copy sdk-py/ into your project, or add to PYTHONPATH
```

Requires Python 3.10+ and `aiohttp`.

## Quick Start

```python
import asyncio
from smolvm import SmolvmClient

async def main():
    client = SmolvmClient()
    sandbox = await client.create_and_start("my-vm", network=True)

    result = await sandbox.sh("echo hello")
    print(result.stdout)  # "hello\n"

    await sandbox.write_file("/app/main.py", "print('hi')")
    content = await sandbox.read_file("/app/main.py")

    await sandbox.cleanup()

asyncio.run(main())
```

## Usage

### Sandbox Lifecycle

```python
client = SmolvmClient()  # defaults to http://127.0.0.1:8080

# Create + start
sandbox = await client.create_and_start("my-vm", cpus=2, memory_mb=2048, network=True)

# Or create then start separately
sandbox = await client.create("my-vm", network=True)
await sandbox.start()

# Execute commands
result = await sandbox.exec(["echo", "hello"])     # raw exec
result = await sandbox.sh("echo hello && ls -la")   # shell convenience
result = await sandbox.run_command("cat /etc/os-release")  # just-bash compat

# Env vars
from smolvm.types import ExecOptions, EnvVar
result = await sandbox.sh("echo $KEY", ExecOptions(env=[EnvVar("KEY", "val")]))

# Info & cleanup
info = await sandbox.info()
await sandbox.stop()
await sandbox.delete()
# Or just:
await sandbox.cleanup()
```

### File I/O

```python
await sandbox.write_file("/app/main.py", code)
content = await sandbox.read_file("/app/main.py")

await sandbox.write_files({"/app/a.py": "...", "/app/b.py": "..."})

files = await sandbox.list_files("/app")
if await sandbox.exists("/app/main.py"):
    print("found it")
```

### Fleet Operations

```python
fleet = await client.create_fleet("worker", 3, network=True)

results = await fleet.exec_all("echo hello")  # parallel across VMs
each = await fleet.exec_each(["cmd-0", "cmd-1", "cmd-2"])

first = fleet.at(0)
await fleet.cleanup()
```

### MicroVMs

```python
vm = await client.create_microvm("persistent-vm", cpus=2, network=True)
await vm.start()
await vm.sh("echo hello")
await vm.write_file("/data/state.json", '{"count": 0}')
await vm.cleanup()
```

## Configuration

The SDK reads `SMOLVM_URL` from the environment, defaulting to `http://127.0.0.1:8080`.

```python
client = SmolvmClient("http://my-server:9000")
```

## Testing

Requires `smolvm serve start` running on localhost:8080.

```sh
python test_sdk.py
```
