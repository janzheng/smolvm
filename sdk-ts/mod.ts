/**
 * @smolvm/sdk — TypeScript SDK for smolvm
 *
 * Thin wrapper around smolvm's REST API. Matches the just-bash/Vercel
 * Sandbox API shape for swappability.
 *
 * @example Basic usage
 * ```typescript
 * import { SmolvmClient } from "@smolvm/sdk";
 *
 * const client = new SmolvmClient();
 * const sandbox = await client.create("my-vm", { network: true });
 * await sandbox.start();
 *
 * const result = await sandbox.sh("echo hello");
 * console.log(result.stdout); // "hello\n"
 *
 * await sandbox.writeFile("/app/main.ts", "console.log('hi');");
 * const content = await sandbox.readFile("/app/main.ts");
 *
 * await sandbox.cleanup();
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
export { Sandbox } from "./sandbox.ts";
export { MicroVM } from "./microvm.ts";
export { SandboxFleet } from "./fleet.ts";
export type {
  CheckpointMetadata,
  CloneSandboxRequest,
  ContainerInfo,
  CreateCheckpointResponse,
  CreateContainerOptions,
  CreateMicroVMOptions,
  CreateSandboxOptions,
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
  MergeSandboxRequest,
  MergeStrategy,
  MicroVMInfo,
  MountSpec,
  PortSpec,
  ResourceStats,
  RestoreCheckpointResponse,
  SandboxInfo,
  SnapshotInfo,
  SnapshotListResponse,
  StarterInfo,
  StarterListResponse,
} from "./types.ts";
