/**
 * smolvm TypeScript SDK — Machine
 *
 * High-level stateful wrapper around a single smolvm machine.
 * Provides exec, shell, file I/O, and just-bash-compatible API.
 */

import { SmolvmHttpClient } from "./client.ts";
import type {
  ContainerInfo,
  CreateCheckpointResponse,
  CreateContainerOptions,
  CreateMachineOptions,
  DiffResult,
  ExecOptions,
  ExecResult,
  FileInfo,
  FileListResponse,
  FileReadResponse,
  ImageInfo,
  MergeResponse,
  MergeMachineRequest,
  ResourceStats,
  MachineInfo,
} from "./types.ts";

export class Machine {
  private _info: MachineInfo | null = null;

  constructor(
    public readonly name: string,
    private readonly http: SmolvmHttpClient,
  ) {}

  /** Current cached state. Call info() for fresh data. */
  get state(): string {
    return this._info?.state ?? "unknown";
  }

  // --------------------------------------------------------------------------
  // Lifecycle
  // --------------------------------------------------------------------------

  async start(): Promise<void> {
    this._info = await this.http.startMachine(this.name);
  }

  async stop(): Promise<void> {
    this._info = await this.http.stopMachine(this.name);
  }

  async delete(force = false): Promise<void> {
    await this.http.deleteMachine(this.name, force);
    this._info = null;
  }

  async info(): Promise<MachineInfo> {
    this._info = await this.http.getMachine(this.name);
    return this._info;
  }

  /** Get resource statistics (CPU, memory, disk usage). */
  async stats(): Promise<ResourceStats> {
    return this.http.machineStats(this.name);
  }

  /**
   * Create a cold checkpoint of this machine.
   * The machine must be stopped first.
   */
  async checkpoint(): Promise<CreateCheckpointResponse> {
    return this.http.createCheckpoint(this.name);
  }

  /**
   * Clone this machine into a new machine.
   * On macOS with APFS, cloning is instant (copy-on-write).
   * The source machine does not need to be stopped.
   */
  async clone(cloneName: string): Promise<Machine> {
    await this.http.cloneMachine(this.name, cloneName);
    return new Machine(cloneName, this.http);
  }

  /**
   * Compare this machine with another.
   * Lists files that differ between the two machines.
   * Both machines must be running (will be auto-started).
   */
  async diff(other: string): Promise<DiffResult> {
    return this.http.diffMachinees(this.name, other);
  }

  /**
   * Merge files from this machine into another.
   * Uses the diff to identify changed files and transfers them
   * via the exec channel.
   */
  async merge(target: string, opts?: MergeMachineRequest): Promise<MergeResponse> {
    return this.http.mergeMachinees(this.name, target, opts);
  }

  /** Stop + delete. Ignores errors (safe for cleanup). */
  async cleanup(): Promise<void> {
    try { await this.stop(); } catch { /* ignore */ }
    try { await this.delete(); } catch { /* ignore */ }
  }

  // --------------------------------------------------------------------------
  // Execution
  // --------------------------------------------------------------------------

  /**
   * Execute a command array in the machine.
   * Command is NOT processed through a shell.
   *
   * @example
   * await machine.exec(["echo", "hello"]);
   * await machine.exec(["node", "--version"]);
   */
  async exec(command: string[], opts?: ExecOptions): Promise<ExecResult> {
    return this.http.execMachine(this.name, command, opts);
  }

  /**
   * Execute a shell command string.
   * Wraps the command in `sh -c "..."` for full shell syntax support
   * (pipes, redirects, &&, ||, variable expansion).
   *
   * @example
   * await machine.sh("echo hello && ls -la");
   * await machine.sh("cat /etc/os-release | grep NAME");
   */
  async sh(cmd: string, opts?: ExecOptions): Promise<ExecResult> {
    return this.exec(["sh", "-c", cmd], opts);
  }

  /**
   * Execute a shell command. Alias for sh() — just-bash compatible.
   *
   * @example
   * await machine.runCommand("echo hello");
   */
  async runCommand(cmd: string, opts?: ExecOptions): Promise<ExecResult> {
    return this.sh(cmd, opts);
  }

  // --------------------------------------------------------------------------
  // File I/O (via HTTP file API)
  // --------------------------------------------------------------------------

  /**
   * Write a file to the machine filesystem via the file API.
   * Content is base64-encoded for transport.
   *
   * @param path - Absolute path in the machine filesystem
   * @param content - File content (will be base64-encoded)
   * @param permissions - Optional Unix permissions string (e.g. "0644")
   */
  async writeFile(path: string, content: string, permissions?: string): Promise<void> {
    const encoded = btoa(content);
    await this.http.writeFile(this.name, path, encoded, permissions);
  }

  /**
   * Read a file from the machine filesystem via the file API.
   * Returns decoded content (base64 decoded from API response).
   */
  async readFile(path: string): Promise<string> {
    const response = await this.http.readFile(this.name, path);
    return atob(response.content);
  }

  /**
   * Delete a file from the machine filesystem via the file API.
   */
  async deleteFile(path: string): Promise<void> {
    await this.http.deleteFile(this.name, path);
  }

  /**
   * Write multiple files at once. just-bash compatible.
   *
   * @example
   * await machine.writeFiles({
   *   "/app/main.ts": "console.log('hello');",
   *   "/app/package.json": '{"name": "test"}',
   * });
   */
  async writeFiles(files: Record<string, string>): Promise<void> {
    for (const [path, content] of Object.entries(files)) {
      await this.writeFile(path, content);
    }
  }

  /**
   * List files in a directory via the file API.
   * Returns detailed FileInfo objects.
   */
  async listFiles(dir?: string): Promise<FileInfo[]> {
    const response = await this.http.listFiles(this.name, dir);
    return response.files;
  }

  /**
   * Check if a file or directory exists.
   */
  async exists(path: string): Promise<boolean> {
    const result = await this.sh(`test -e '${path}' && echo yes || echo no`);
    return result.stdout.trim() === "yes";
  }

  /**
   * Upload a binary file via multipart/form-data.
   * No base64 encoding needed — suitable for large files.
   *
   * @param path - Absolute path in the machine filesystem
   * @param data - Raw file data
   * @param permissions - Optional Unix permissions string (e.g. "0755")
   */
  async uploadFile(
    path: string,
    data: Uint8Array | Blob,
    permissions?: string,
  ): Promise<{ uploaded: string; size: number }> {
    return this.http.uploadFile(this.name, path, data, permissions);
  }

  /**
   * Upload a tar.gz archive and extract it into a directory.
   *
   * @param archive - Raw tar.gz bytes
   * @param dir - Directory to extract to (default: /)
   */
  async uploadArchive(
    archive: Uint8Array | Blob,
    dir?: string,
  ): Promise<{ extracted_to: string; archive_size: number }> {
    return this.http.uploadArchive(this.name, archive, dir);
  }

  /**
   * Download a directory as a tar.gz archive.
   *
   * @param dir - Directory to archive (default: /)
   * @returns Raw tar.gz bytes
   */
  async downloadArchive(dir?: string): Promise<Uint8Array> {
    return this.http.downloadArchive(this.name, dir);
  }

  /**
   * Push this machine as a snapshot for later retrieval.
   */
  async push(): Promise<void> {
    await this.http.pushMachine(this.name);
  }

  // --------------------------------------------------------------------------
  // Images & Containers
  // --------------------------------------------------------------------------

  async pullImage(image: string): Promise<ImageInfo> {
    const result = await this.http.pullImage(this.name, image);
    return result.image;
  }

  async listImages(): Promise<ImageInfo[]> {
    return this.http.listImages(this.name);
  }

  /**
   * Run a command using an OCI image (ephemeral overlay).
   * The machine must have the image pulled first.
   */
  async runInImage(
    image: string,
    command: string[],
    opts?: ExecOptions,
  ): Promise<ExecResult> {
    return this.http.runInImage(this.name, image, command, opts);
  }

  async createContainer(opts: CreateContainerOptions): Promise<ContainerInfo> {
    return this.http.createContainer(this.name, opts);
  }

  async startContainer(containerId: string): Promise<void> {
    return this.http.startContainer(this.name, containerId);
  }

  async execContainer(
    containerId: string,
    command: string[],
    opts?: ExecOptions,
  ): Promise<ExecResult> {
    return this.http.execContainer(this.name, containerId, command, opts);
  }

  async stopContainer(containerId: string): Promise<void> {
    return this.http.stopContainer(this.name, containerId);
  }

  async deleteContainer(containerId: string, force = false): Promise<void> {
    return this.http.deleteContainer(this.name, containerId, force);
  }
}
