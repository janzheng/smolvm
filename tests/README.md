# smolvm Tests

Integration tests and performance benchmarks for smolvm.

## Test Suites

| File | Description | Requires VM |
|------|-------------|-------------|
| `test_cli.sh` | Basic CLI tests (--version, --help, flags) | No |
| `test_machine.sh` | Machine run tests (exec, env, volumes, TSI) | Yes |
| `test_microvm.sh` | MicroVM lifecycle tests (start, stop, exec, DB) | Yes |
| `test_container.sh` | Container lifecycle tests (create, exec, stop) | Yes |
| `test_api.sh` | HTTP API tests (`smolvm serve start`) | Yes |
| `test_pack.sh` | Pack command tests (pack, run, daemon mode) | Yes |
| `test_smolfile.sh` | Smolfile configuration tests | Yes |
| `test_resize.sh` | VM resize tests (CPU, memory, disk) | Yes |

## Benchmarks

| File | Description |
|------|-------------|
| `bench_vm_startup.sh` | Measures VM cold start time |
| `bench_container.sh` | Measures container execution time (cold/warm) |

## Running Tests

### Run All Tests

```bash
./tests/run_all.sh
```

### Run Specific Test Suite

```bash
./tests/run_all.sh cli        # CLI tests only
./tests/run_all.sh machine    # Machine tests only
./tests/run_all.sh microvm    # MicroVM tests only
./tests/run_all.sh container  # Container tests only
./tests/run_all.sh api        # HTTP API tests only
./tests/run_all.sh pack       # Pack tests only
./tests/run_all.sh pack-quick # Pack tests (skip large images)
```

### Run Benchmarks

```bash
./tests/run_all.sh bench           # All benchmarks
./tests/run_all.sh bench-vm        # VM startup benchmark
./tests/run_all.sh bench-container # Container benchmark
```

### Run Individual Test Files

```bash
./tests/test_cli.sh
./tests/test_machine.sh
```

### Use Specific Binary

```bash
SMOLVM=/path/to/smolvm ./tests/run_all.sh
```

## Unit Tests

Unit tests are run via cargo (no VM required):

```bash
cargo test --lib
```

## Test Requirements

- **CLI tests**: Only require the smolvm binary
- **All other tests**: Require VM environment (macOS Hypervisor.framework or Linux KVM)
- **Benchmarks**: Require VM environment, best run on a quiet system

These are shell integration tests that run the actual smolvm binary against real micro VMs.

## Binary Discovery

Tests automatically look for the smolvm binary in:

1. `$SMOLVM` environment variable
2. `target/release/smolvm`
3. `dist/smolvm-*-darwin-*/smolvm` or `dist/smolvm-*-linux-*/smolvm`

## Common Utilities

The `common.sh` file provides shared test utilities:

- `find_smolvm` - Locate the smolvm binary
- `init_smolvm` - Initialize and validate the binary
- `run_test` - Run a test function with pass/fail tracking
- `print_summary` - Print test results summary
- `ensure_microvm_running` - Start the default microvm
- `cleanup_microvm` - Stop the default microvm
- `extract_container_id` - Parse container ID from command output
- `cleanup_container` - Force remove a container
- `wait_for_agent_ready` - Wait for VM agent to accept exec commands (up to N attempts, fixes boot race conditions)
- `run_with_timeout` - Run a command with configurable timeout
- `kill_orphan_smolvm_processes` - Pre-flight cleanup of stale processes
- `vm_data_dir` - Get the data directory for a named microvm
- `ensure_data_dir_deleted` - Verify VM data dir was cleaned up

## Test Count

| Suite | Tests |
|-------|-------|
| CLI | 13 |
| Machine | 31 |
| MicroVM | 24 |
| Container | 10 |
| API | 13 |
| Pack | 34 |
| **Total** | **125** |

_Last updated: 2026-03-28_
