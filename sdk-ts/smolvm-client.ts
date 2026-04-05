/**
 * smolvm TypeScript SDK — SmolvmClient
 *
 * Top-level client. The main entry point for the SDK.
 * Creates machines, microvms, and fleets.
 */

import { SmolvmHttpClient } from "./client.ts";
import { Machine } from "./machine.ts";
import { MicroVM } from "./microvm.ts";
import { MachineFleet, createFleet } from "./fleet.ts";
import type {
  CheckpointMetadata,
  CreateMicroVMOptions,
  CreateMachineOptions,
  HealthResponse,
  RestoreCheckpointResponse,
  MachineInfo,
  MicroVMInfo,
  SnapshotInfo,
  StarterInfo,
} from "./types.ts";

export class SmolvmClient {
  private readonly http: SmolvmHttpClient;

  /**
   * Create a new smolvm client.
   *
   * @param baseUrl - smolvm server URL. Defaults to SMOLVM_URL env var or http://127.0.0.1:8080
   */
  constructor(baseUrl?: string) {
    this.http = new SmolvmHttpClient(baseUrl);
  }

  // --------------------------------------------------------------------------
  // Health
  // --------------------------------------------------------------------------

  async health(): Promise<HealthResponse> {
    return this.http.health();
  }

  // --------------------------------------------------------------------------
  // Machinees
  // --------------------------------------------------------------------------

  /**
   * Create a new machine (ephemeral VM).
   * Does NOT start it — call machine.start() after.
   *
   * @example
   * const machine = await client.create("my-vm", { cpus: 2, network: true });
   * await machine.start();
   * await machine.sh("echo hello");
   * await machine.cleanup();
   */
  async create(name: string, opts?: CreateMachineOptions): Promise<Machine> {
    await this.http.createMachine({
      name,
      mounts: opts?.mounts,
      ports: opts?.ports,
      resources: {
        cpus: opts?.cpus ?? 2,
        memory_mb: opts?.memoryMb ?? 1024,
        network: opts?.network ?? false,
        overlay_gb: opts?.overlay_gb,
        storage_gb: opts?.storage_gb,
        allowed_domains: opts?.allowed_domains,
        allowed_cidrs: opts?.allowed_cidrs,
      },
      init_commands: opts?.init_commands,
      default_user: opts?.default_user,
      from_starter: opts?.fromStarter,
      secrets: opts?.secrets,
    });
    return new Machine(name, this.http);
  }

  /**
   * Create and immediately start a machine. Convenience method.
   *
   * @example
   * const machine = await client.createAndStart("my-vm", { network: true });
   * await machine.sh("echo hello");
   * await machine.cleanup();
   */
  async createAndStart(name: string, opts?: CreateMachineOptions): Promise<Machine> {
    const machine = await this.create(name, opts);
    await machine.start();
    return machine;
  }

  /**
   * Get an existing machine by name.
   * Does NOT create it — use create() for that.
   */
  async get(name: string): Promise<Machine> {
    // Verify it exists
    await this.http.getMachine(name);
    return new Machine(name, this.http);
  }

  async list(): Promise<MachineInfo[]> {
    return this.http.listMachines();
  }

  // --------------------------------------------------------------------------
  // MicroVMs
  // --------------------------------------------------------------------------

  /**
   * Create a new MicroVM (persistent VM).
   * MicroVMs use a different REST schema than machines.
   */
  async createMicroVM(name: string, opts?: CreateMicroVMOptions): Promise<MicroVM> {
    await this.http.createMicroVM({
      name,
      cpus: opts?.cpus ?? 2,
      memoryMb: opts?.memoryMb ?? 1024,
      network: opts?.network ?? false,
      overlay_gb: opts?.overlay_gb,
      storage_gb: opts?.storage_gb,
      mounts: opts?.mounts,
      ports: opts?.ports,
    });
    return new MicroVM(name, this.http);
  }

  async getMicroVM(name: string): Promise<MicroVM> {
    await this.http.getMicroVM(name);
    return new MicroVM(name, this.http);
  }

  async listMicroVMs(): Promise<MicroVMInfo[]> {
    return this.http.listMicroVMs();
  }

  // --------------------------------------------------------------------------
  // Checkpoints
  // --------------------------------------------------------------------------

  async listCheckpoints(): Promise<CheckpointMetadata[]> {
    return this.http.listCheckpoints();
  }

  async restoreCheckpoint(checkpointId: string, name: string): Promise<Machine> {
    await this.http.restoreCheckpoint(checkpointId, name);
    return new Machine(name, this.http);
  }

  async deleteCheckpoint(checkpointId: string): Promise<void> {
    return this.http.deleteCheckpoint(checkpointId);
  }

  // --------------------------------------------------------------------------
  // Starters
  // --------------------------------------------------------------------------

  async listStarters(): Promise<StarterInfo[]> {
    return this.http.listStarters();
  }

  // --------------------------------------------------------------------------
  // Snapshots
  // --------------------------------------------------------------------------

  async listSnapshots(): Promise<SnapshotInfo[]> {
    return this.http.listSnapshots();
  }

  async pullSnapshot(snapshotName: string, machineName: string): Promise<Machine> {
    await this.http.pullSnapshot(snapshotName, machineName);
    return new Machine(machineName, this.http);
  }

  async deleteSnapshot(name: string): Promise<void> {
    return this.http.deleteSnapshot(name);
  }

  // --------------------------------------------------------------------------
  // Fleet
  // --------------------------------------------------------------------------

  /**
   * Create a fleet of machines. All are created and started.
   * Names: `{prefix}-0`, `{prefix}-1`, ...
   *
   * @example
   * const fleet = await client.createFleet("worker", 3, { network: true });
   * const results = await fleet.execAll("echo hello");
   * await fleet.cleanup();
   */
  async createFleet(
    prefix: string,
    count: number,
    opts?: CreateMachineOptions,
  ): Promise<MachineFleet> {
    return createFleet(this.http, prefix, count, opts);
  }
}
