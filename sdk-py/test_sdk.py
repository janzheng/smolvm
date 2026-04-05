"""smolvm Python SDK — Integration Test.

Requires `smolvm serve` running on localhost:8080.
Run: python test_sdk.py
  or: python -m pytest test_sdk.py -v
"""

import asyncio
import time

passed = 0
failed = 0
failures: list[str] = []


def test(name: str, ok: bool, detail: str = "") -> None:
    global passed, failed
    if ok:
        print(f"  OK  {name}")
        passed += 1
    else:
        print(f"  FAIL  {name}{f' - {detail}' if detail else ''}")
        failed += 1
        failures.append(name)


async def main() -> None:
    from smolvm import SmolvmClient, SmolvmError

    print()
    print("=" * 42)
    print("  smolvm Python SDK - Integration Test")
    print("=" * 42)
    print()

    client = SmolvmClient()

    # --- Health ---
    print("Health:")
    h = await client.health()
    test("Server responds", h.status == "ok")
    test("Has version", bool(h.version))
    print(f"     smolvm {h.version}")

    # --- Sandbox lifecycle ---
    print("\nSandbox Lifecycle:")
    sandbox = await client.create_and_start("py-sdk-test", network=True)
    test("Create + start", True)

    info = await sandbox.info()
    test("Info returns data", info.state == "running")

    result = await sandbox.exec(["echo", "hello-py-sdk"])
    test("exec() works", result.exit_code == 0 and result.stdout.strip() == "hello-py-sdk")

    sh_result = await sandbox.sh("echo hello && echo world")
    test("sh() works", sh_result.exit_code == 0 and "hello" in sh_result.stdout and "world" in sh_result.stdout)

    run_result = await sandbox.run_command("echo just-bash-compat")
    test("run_command() works", run_result.stdout.strip() == "just-bash-compat")

    from smolvm.types import EnvVar, ExecOptions

    env_result = await sandbox.sh(
        "echo $MY_VAR",
        ExecOptions(env=[EnvVar(name="MY_VAR", value="py-sdk-value")]),
    )
    test("Env vars via exec", env_result.stdout.strip() == "py-sdk-value")

    await sandbox.cleanup()
    test("Cleanup succeeds", True)

    # --- File I/O ---
    print("\nFile I/O:")
    sandbox = await client.create_and_start("py-sdk-file-test", network=True)

    await sandbox.write_file("/tmp/test.txt", "hello from Python SDK")
    content = await sandbox.read_file("/tmp/test.txt")
    test("write_file + read_file", content == "hello from Python SDK")

    await sandbox.write_files({"/tmp/a.txt": "file-a", "/tmp/b.txt": "file-b"})
    a = await sandbox.read_file("/tmp/a.txt")
    b = await sandbox.read_file("/tmp/b.txt")
    test("write_files (batch)", a == "file-a" and b == "file-b")

    await sandbox.write_file("/workspace/deep/nested/file.txt", "deep content")
    deep = await sandbox.read_file("/workspace/deep/nested/file.txt")
    test("Nested directory auto-creation", deep == "deep content")

    files = await sandbox.list_files("/tmp")
    test("list_files", "a.txt" in files and "b.txt" in files)

    yes = await sandbox.exists("/tmp/a.txt")
    no = await sandbox.exists("/tmp/nonexistent")
    test("exists()", yes is True and no is False)

    await sandbox.write_file("/tmp/special.txt", 'quotes "and" \'stuff\' & newlines\nline2')
    special = await sandbox.read_file("/tmp/special.txt")
    test("Special chars in file content", "quotes" in special and "line2" in special)

    await sandbox.cleanup()

    # --- Fleet ---
    print("\nFleet Operations:")
    fleet = await client.create_fleet("py-sdk-fleet", 3, network=True)
    test("Fleet created", fleet.size == 3)

    results = await fleet.exec_all("echo hello")
    all_ok = all(r.exit_code == 0 and r.stdout.strip() == "hello" for r in results)
    test("exec_all (same command)", all_ok)

    each_results = await fleet.exec_each(
        ["echo sandbox-0", "echo sandbox-1", "echo sandbox-2"]
    )
    each_ok = all(r.stdout.strip() == f"sandbox-{i}" for i, r in enumerate(each_results))
    test("exec_each (different commands)", each_ok)

    t0 = time.monotonic()
    await fleet.exec_all("sleep 1 && echo done")
    parallel_ms = round((time.monotonic() - t0) * 1000)
    test(f"Cross-VM parallel ({parallel_ms}ms for 3x1s)", parallel_ms < 2500)

    first = fleet.at(0)
    test("fleet.at(0) returns sandbox", first.name == "py-sdk-fleet-0")

    await fleet.cleanup()
    test("Fleet cleanup", True)

    # --- MicroVM ---
    print("\nMicroVM:")
    vm = await client.create_microvm("py-sdk-microvm", network=True)
    await vm.start()

    result = await vm.sh("echo microvm-works")
    test("MicroVM exec", result.stdout.strip() == "microvm-works")

    await vm.write_file("/tmp/vm-file.txt", "persistent")
    content = await vm.read_file("/tmp/vm-file.txt")
    test("MicroVM file I/O", content == "persistent")

    await vm.cleanup()
    test("MicroVM cleanup", True)

    # --- List ---
    print("\nList Operations:")
    sandboxes = await client.list()
    test("list() returns list", isinstance(sandboxes, list))

    vms = await client.list_microvms()
    test("list_microvms() returns list", isinstance(vms, list))

    # --- Error handling ---
    print("\nError Handling:")
    try:
        await client.get("nonexistent-py-sdk-test-xyz")
        test("404 raises SmolvmError", False, "should have raised")
    except SmolvmError as e:
        test("404 raises SmolvmError", "404" in str(e))

    await client.close()

    # --- Summary ---
    print()
    print("=" * 42)
    print(f"  Results: {passed} passed, {failed} failed")
    if failures:
        print(f"  Failed: {', '.join(failures)}")
    print("=" * 42)
    print()


if __name__ == "__main__":
    asyncio.run(main())
