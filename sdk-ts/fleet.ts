/**
 * smolvm TypeScript SDK — Fleet
 *
 * Multi-machine orchestration. Creates N machines, executes commands
 * across all of them in parallel, and cleans up.
 */

import { SmolvmHttpClient } from "./client.ts";
import { Machine } from "./machine.ts";
import type { CreateMachineOptions, ExecOptions, ExecResult } from "./types.ts";

export class MachineFleet {
  public readonly machines: Machine[];

  constructor(
    machines: Machine[],
    private readonly http: SmolvmHttpClient,
  ) {
    this.machines = machines;
  }

  /** Number of machines in the fleet. */
  get size(): number {
    return this.machines.length;
  }

  /** All machine names. */
  get names(): string[] {
    return this.machines.map((s) => s.name);
  }

  /**
   * Execute a shell command across all machines in parallel.
   * Returns results in the same order as machines.
   */
  async execAll(cmd: string, opts?: ExecOptions): Promise<ExecResult[]> {
    return Promise.all(this.machines.map((s) => s.sh(cmd, opts)));
  }

  /**
   * Execute different commands on each machine in parallel.
   * Commands array must match fleet size.
   */
  async execEach(cmds: string[], opts?: ExecOptions): Promise<ExecResult[]> {
    if (cmds.length !== this.machines.length) {
      throw new Error(
        `Expected ${this.machines.length} commands, got ${cmds.length}`,
      );
    }
    return Promise.all(
      this.machines.map((s, i) => s.sh(cmds[i], opts)),
    );
  }

  /**
   * Execute a raw command array across all machines in parallel.
   */
  async execAllRaw(
    command: string[],
    opts?: ExecOptions,
  ): Promise<ExecResult[]> {
    return Promise.all(this.machines.map((s) => s.exec(command, opts)));
  }

  /** Get a specific machine by index. */
  at(index: number): Machine {
    const s = this.machines[index];
    if (!s) throw new Error(`Fleet index ${index} out of range (size: ${this.size})`);
    return s;
  }

  /** Stop and delete all machines. Ignores errors. */
  async cleanup(): Promise<void> {
    await Promise.all(this.machines.map((s) => s.cleanup()));
  }
}

/**
 * Create a fleet of machines.
 * Names are auto-generated as `{prefix}-0`, `{prefix}-1`, etc.
 */
export async function createFleet(
  http: SmolvmHttpClient,
  prefix: string,
  count: number,
  opts?: CreateMachineOptions,
): Promise<MachineFleet> {
  const machines: Machine[] = [];

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
        memoryMb: opts?.memoryMb ?? 512,
        network: opts?.network ?? true,
        overlayGb: opts?.overlay_gb,
        storageGb: opts?.storage_gb,
        allowedDomains: opts?.allowed_domains,
        allowedCidrs: opts?.allowed_cidrs,
      },
      init_commands: opts?.init_commands,
      default_user: opts?.default_user,
      from_starter: opts?.fromStarter,
    });

    machines.push(new Machine(name, http));
  }

  // Start all in parallel
  await Promise.all(machines.map((s) => s.start()));

  return new MachineFleet(machines, http);
}
