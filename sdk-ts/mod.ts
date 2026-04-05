/**
 * @smolvm/sdk — TypeScript SDK for smolvm
 *
 * Thin wrapper around smolvm's REST API. Matches the just-bash/Vercel
 * Machine API shape for swappability.
 *
 * @example Basic usage
 * ```typescript
 * import { SmolvmClient } from "@smolvm/sdk";
 *
 * const client = new SmolvmClient();
 * const machine = await client.create("my-vm", { network: true });
 * await machine.start();
 *
 * const result = await machine.sh("echo hello");
 * console.log(result.stdout); // "hello\n"
 *
 * await machine.writeFile("/app/main.ts", "console.log('hi');");
 * const content = await machine.readFile("/app/main.ts");
 *
 * await machine.cleanup();
 * ```
 *
 * @example Fleet operations
 * ```typescript
 * const fleet = await client.createFleet("worker", 3, { network: true });
 * const results = await fleet.execAll("echo hello");
 * await fleet.cleanup();
 * ```
 *
 * @module
 */

export { SmolvmClient } from "./smolvm-client.ts";
export { SmolvmHttpClient, SmolvmError } from "./client.ts";
export { Machine } from "./machine.ts";
export { MicroVM } from "./microvm.ts";
export { MachineFleet } from "./fleet.ts";
export type {
  CheckpointMetadata,
  CloneMachineRequest,
  ContainerInfo,
  CreateCheckpointResponse,
  CreateContainerOptions,
  CreateMicroVMOptions,
  CreateMachineOptions,
  DiffResult,
  DiskStats,
  EnvVar,
  ExecOptions,
  ExecResult,
  FileInfo,
  FileListResponse,
  FileReadResponse,
  HealthResponse,
  ImageInfo,
  MergeResponse,
  MergeMachineRequest,
  MergeStrategy,
  MicroVMInfo,
  MountSpec,
  PortSpec,
  ResourceStats,
  RestoreCheckpointResponse,
  MachineInfo,
  SnapshotInfo,
  SnapshotListResponse,
  StarterInfo,
  StarterListResponse,
} from "./types.ts";
