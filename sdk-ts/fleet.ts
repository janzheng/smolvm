/**
 * smolvm TypeScript SDK — Fleet
 *
 * Multi-machine orchestration. Creates N machinees, executes commands
 * across all of them in parallel, and cleans up.
 */

import { SmolvmHttpClient } from "./client.ts";
import { Machine } from "./machine.ts";
import type { CreateMachineOptions, ExecOptions, ExecResult } from "./types.ts";

export class MachineFleet {
  public readonly machinees: Machine[];

  constructor(
    machinees: Machine[],
    private readonly http: SmolvmHttpClient,
  ) {
    this.machinees = machinees;
  }

  /** Number of machinees in the fleet. */
  get size(): number {
    return this.machinees.length;
  }

  /** All machine names. */
  get names(): string[] {
    return this.machinees.map((s) => s.name);
  }

  /**
   * Execute a shell command across all machinees in parallel.
   * Returns results in the same order as machinees.
   */
  async execAll(cmd: string, opts?: ExecOptions): Promise<ExecResult[]> {
    return Promise.all(this.machinees.map((s) => s.sh(cmd, opts)));
  }

  /**
   * Execute different commands on each machine in parallel.
   * Commands array must match fleet size.
   */
  async execEach(cmds: string[], opts?: ExecOptions): Promise<ExecResult[]> {
    if (cmds.length !== this.machinees.length) {
      throw new Error(
        `Expected ${this.machinees.length} commands, got ${cmds.length}`,
      );
    }
    return Promise.all(
      this.machinees.map((s, i) => s.sh(cmds[i], opts)),
    );
  }

  /**
   * Execute a raw command array across all machinees in parallel.
   */
  async execAllRaw(
    command: string[],
    opts?: ExecOptions,
  ): Promise<ExecResult[]> {
    return Promise.all(this.machinees.map((s) => s.exec(command, opts)));
  }

  /** Get a specific machine by index. */
  at(index: number): Machine {
    const s = this.machinees[index];
    if (!s) throw new Error(`Fleet index ${index} out of range (size: ${this.size})`);
    return s;
  }

  /** Stop and delete all machinees. Ignores errors. */
  async cleanup(): Promise<void> {
    await Promise.all(this.machinees.map((s) => s.cleanup()));
  }
}

/**
 * Create a fleet of machinees.
 * Names are auto-generated as `{prefix}-0`, `{prefix}-1`, etc.
 */
export async function createFleet(
  http: SmolvmHttpClient,
  prefix: string,
  count: number,
  opts?: CreateMachineOptions,
): Promise<MachineFleet> {
  const machinees: Machine[] = [];

  for (let i = 0; i < count; i++) {
    const name = `${prefix}-${i}`;

    // Cleanup any leftover from previous runs
    try {
      await http.stopMachine(name);
    } catch { /* ignore */ }
    try {
      await http.deleteMachine(name);
    } catch { /* ignore */ }

    // Create
    await http.createMachine({
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

    machinees.push(new Machine(name, http));
  }

  // Start all in parallel
  await Promise.all(machinees.map((s) => s.start()));

  return new MachineFleet(machinees, http);
}
