/**
 * smolvm TypeScript SDK — Fleet
 *
 * Multi-sandbox orchestration. Creates N sandboxes, executes commands
 * across all of them in parallel, and cleans up.
 */

import { SmolvmHttpClient } from "./client.ts";
import { Sandbox } from "./sandbox.ts";
import type { CreateSandboxOptions, ExecOptions, ExecResult } from "./types.ts";

export class SandboxFleet {
  public readonly sandboxes: Sandbox[];

  constructor(
    sandboxes: Sandbox[],
    private readonly http: SmolvmHttpClient,
  ) {
    this.sandboxes = sandboxes;
  }

  /** Number of sandboxes in the fleet. */
  get size(): number {
    return this.sandboxes.length;
  }

  /** All sandbox names. */
  get names(): string[] {
    return this.sandboxes.map((s) => s.name);
  }

  /**
   * Execute a shell command across all sandboxes in parallel.
   * Returns results in the same order as sandboxes.
   */
  async execAll(cmd: string, opts?: ExecOptions): Promise<ExecResult[]> {
    return Promise.all(this.sandboxes.map((s) => s.sh(cmd, opts)));
  }

  /**
   * Execute different commands on each sandbox in parallel.
   * Commands array must match fleet size.
   */
  async execEach(cmds: string[], opts?: ExecOptions): Promise<ExecResult[]> {
    if (cmds.length !== this.sandboxes.length) {
      throw new Error(
        `Expected ${this.sandboxes.length} commands, got ${cmds.length}`,
      );
    }
    return Promise.all(
      this.sandboxes.map((s, i) => s.sh(cmds[i], opts)),
    );
  }

  /**
   * Execute a raw command array across all sandboxes in parallel.
   */
  async execAllRaw(
    command: string[],
    opts?: ExecOptions,
  ): Promise<ExecResult[]> {
    return Promise.all(this.sandboxes.map((s) => s.exec(command, opts)));
  }

  /** Get a specific sandbox by index. */
  at(index: number): Sandbox {
    const s = this.sandboxes[index];
    if (!s) throw new Error(`Fleet index ${index} out of range (size: ${this.size})`);
    return s;
  }

  /** Stop and delete all sandboxes. Ignores errors. */
  async cleanup(): Promise<void> {
    await Promise.all(this.sandboxes.map((s) => s.cleanup()));
  }
}

/**
 * Create a fleet of sandboxes.
 * Names are auto-generated as `{prefix}-0`, `{prefix}-1`, etc.
 */
export async function createFleet(
  http: SmolvmHttpClient,
  prefix: string,
  count: number,
  opts?: CreateSandboxOptions,
): Promise<SandboxFleet> {
  const sandboxes: Sandbox[] = [];

  for (let i = 0; i < count; i++) {
    const name = `${prefix}-${i}`;

    // Cleanup any leftover from previous runs
    try {
      await http.stopSandbox(name);
    } catch { /* ignore */ }
    try {
      await http.deleteSandbox(name);
    } catch { /* ignore */ }

    // Create
    await http.createSandbox({
      name,
      mounts: opts?.mounts,
      ports: opts?.ports,
      resources: {
        cpus: opts?.cpus ?? 1,
        memory_mb: opts?.memoryMb ?? 512,
        network: opts?.network ?? true,
        overlay_gb: opts?.overlay_gb,
        storage_gb: opts?.storage_gb,
        allowed_domains: opts?.allowed_domains,
      },
      init_commands: opts?.init_commands,
      default_user: opts?.default_user,
      from_starter: opts?.fromStarter,
    });

    sandboxes.push(new Sandbox(name, http));
  }

  // Start all in parallel
  await Promise.all(sandboxes.map((s) => s.start()));

  return new SandboxFleet(sandboxes, http);
}
