/**
 * smolvm TypeScript SDK — SmolvmClient
 *
 * Top-level client. The main entry point for the SDK.
 * Creates sandboxes, microvms, and fleets.
 */

import { SmolvmHttpClient } from "./client.ts";
import { Sandbox } from "./sandbox.ts";
import { MicroVM } from "./microvm.ts";
import { SandboxFleet, createFleet } from "./fleet.ts";
import type {
  CheckpointMetadata,
  CreateMicroVMOptions,
  CreateSandboxOptions,
  HealthResponse,
  RestoreCheckpointResponse,
  SandboxInfo,
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
  // Sandboxes
  // --------------------------------------------------------------------------

  /**
   * Create a new sandbox (ephemeral VM).
   * Does NOT start it — call sandbox.start() after.
   *
   * @example
   * const sandbox = await client.create("my-vm", { cpus: 2, network: true });
   * await sandbox.start();
   * await sandbox.sh("echo hello");
   * await sandbox.cleanup();
   */
  async create(name: string, opts?: CreateSandboxOptions): Promise<Sandbox> {
    await this.http.createSandbox({
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
      },
      init_commands: opts?.init_commands,
      default_user: opts?.default_user,
      from_starter: opts?.fromStarter,
      secrets: opts?.secrets,
    });
    return new Sandbox(name, this.http);
  }

  /**
   * Create and immediately start a sandbox. Convenience method.
   *
   * @example
   * const sandbox = await client.createAndStart("my-vm", { network: true });
   * await sandbox.sh("echo hello");
   * await sandbox.cleanup();
   */
  async createAndStart(name: string, opts?: CreateSandboxOptions): Promise<Sandbox> {
    const sandbox = await this.create(name, opts);
    await sandbox.start();
    return sandbox;
  }

  /**
   * Get an existing sandbox by name.
   * Does NOT create it — use create() for that.
   */
  async get(name: string): Promise<Sandbox> {
    // Verify it exists
    await this.http.getSandbox(name);
    return new Sandbox(name, this.http);
  }

  async list(): Promise<SandboxInfo[]> {
    return this.http.listSandboxes();
  }

  // --------------------------------------------------------------------------
  // MicroVMs
  // --------------------------------------------------------------------------

  /**
   * Create a new MicroVM (persistent VM).
   * MicroVMs use a different REST schema than sandboxes.
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

  async restoreCheckpoint(checkpointId: string, name: string): Promise<Sandbox> {
    await this.http.restoreCheckpoint(checkpointId, name);
    return new Sandbox(name, this.http);
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

  async pullSnapshot(snapshotName: string, sandboxName: string): Promise<Sandbox> {
    await this.http.pullSnapshot(snapshotName, sandboxName);
    return new Sandbox(sandboxName, this.http);
  }

  async deleteSnapshot(name: string): Promise<void> {
    return this.http.deleteSnapshot(name);
  }

  // --------------------------------------------------------------------------
  // Fleet
  // --------------------------------------------------------------------------

  /**
   * Create a fleet of sandboxes. All are created and started.
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
    opts?: CreateSandboxOptions,
  ): Promise<SandboxFleet> {
    return createFleet(this.http, prefix, count, opts);
  }
}
