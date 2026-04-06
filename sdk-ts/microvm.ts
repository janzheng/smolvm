/**
 * smolvm TypeScript SDK — MicroVM
 *
 * High-level wrapper for persistent MicroVMs.
 * MicroVMs differ from Machinees: different REST schema, persistent by design,
 * no image/container management.
 */

import { SmolvmHttpClient } from "./client.ts";
import type {
  ExecOptions,
  ExecResult,
  MicroVMInfo,
} from "./types.ts";

export class MicroVM {
  private _info: MicroVMInfo | null = null;

  constructor(
    public readonly name: string,
    private readonly http: SmolvmHttpClient,
  ) {}

  get state(): string {
    return this._info?.state ?? "unknown";
  }

  // --------------------------------------------------------------------------
  // Lifecycle
  // --------------------------------------------------------------------------

  async start(): Promise<void> {
    this._info = await this.http.startMicroVM(this.name);
  }

  async stop(): Promise<void> {
    this._info = await this.http.stopMicroVM(this.name);
  }

  async delete(force = false): Promise<void> {
    await this.http.deleteMicroVM(this.name, force);
    this._info = null;
  }

  async info(): Promise<MicroVMInfo> {
    this._info = await this.http.getMicroVM(this.name);
    return this._info;
  }

  async cleanup(): Promise<void> {
    try { await this.stop(); } catch { /* ignore */ }
    try { await this.delete(); } catch { /* ignore */ }
  }

  // --------------------------------------------------------------------------
  // Execution
  // --------------------------------------------------------------------------

  async exec(command: string[], opts?: ExecOptions): Promise<ExecResult> {
    return this.http.execMicroVM(this.name, command, opts);
  }

  async sh(cmd: string, opts?: ExecOptions): Promise<ExecResult> {
    return this.exec(["sh", "-c", cmd], opts);
  }

  async runCommand(cmd: string, opts?: ExecOptions): Promise<ExecResult> {
    return this.sh(cmd, opts);
  }

  // --------------------------------------------------------------------------
  // File I/O (same exec-channel approach as Machine)
  // --------------------------------------------------------------------------

  async writeFile(path: string, content: string): Promise<void> {
    const encoded = btoa(content);
    const dir = path.substring(0, path.lastIndexOf("/"));
    if (dir) {
      await this.sh(`mkdir -p '${dir}'`);
    }
    const result = await this.sh(`echo '${encoded}' | base64 -d > '${path}'`);
    if (result.exitCode !== 0) {
      throw new Error(`writeFile failed: ${result.stderr}`);
    }
  }

  async readFile(path: string): Promise<string> {
    const result = await this.sh(`base64 '${path}'`);
    if (result.exitCode !== 0) {
      throw new Error(`readFile failed: ${result.stderr}`);
    }
    return atob(result.stdout.trim());
  }

  async writeFiles(files: Record<string, string>): Promise<void> {
    for (const [path, content] of Object.entries(files)) {
      await this.writeFile(path, content);
    }
  }
}
