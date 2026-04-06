/**
 * smolvm TypeScript SDK — HTTP Client
 *
 * Low-level transport layer. Handles all REST API communication.
 * Users should prefer the high-level Machine/MicroVM classes.
 */

import type {
  CheckpointMetadata,
  CloneMachineRequest,
  ContainerInfo,
  CreateCheckpointResponse,
  CreateContainerOptions,
  CreateMicroVMRequest,
  CreateMachineRequest,
  DebugMountsResponse,
  DebugNetworkResponse,
  DiffResult,
  ExecOptions,
  ExecResult,
  FileInfo,
  FileListResponse,
  FileReadResponse,
  HealthResponse,
  ImageInfo,
  MergeResponse,
  MergeMachineRequest,
  MicroVMInfo,
  ResourceStats,
  RestoreCheckpointResponse,
  MachineInfo,
  SnapshotInfo,
  SnapshotListResponse,
  StarterInfo,
  StarterListResponse,
  SubmitJobRequest,
  SubmitJobResponse,
  JobInfo,
  ListJobsResponse,
  CompleteJobRequest,
  FailJobRequest,
} from "./types.ts";

export class SmolvmError extends Error {
  constructor(
    public status: number,
    public body: string,
    message?: string,
  ) {
    super(message ?? `smolvm API error (${status}): ${body}`);
    this.name = "SmolvmError";
  }
}

export class SmolvmHttpClient {
  private baseUrl: string;
  private apiToken?: string;

  constructor(baseUrl?: string, apiToken?: string) {
    this.baseUrl = (
      baseUrl ??
      (typeof Deno !== "undefined"
        ? Deno.env.get("SMOLVM_URL")
        : undefined) ??
      "http://127.0.0.1:9090"
    ).replace(/\/$/, "");
    this.apiToken =
      apiToken ??
      (typeof Deno !== "undefined"
        ? Deno.env.get("SMOLVM_API_TOKEN")
        : undefined);
  }

  // --------------------------------------------------------------------------
  // Internal HTTP helpers
  // --------------------------------------------------------------------------

  private get api(): string {
    return `${this.baseUrl}/api/v1`;
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Response> {
    const url = path.startsWith("http") ? path : `${this.api}${path}`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.apiToken) {
      headers["Authorization"] = `Bearer ${this.apiToken}`;
    }
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
    }
    return fetch(url, init);
  }

  private async json<T>(resp: Response): Promise<T> {
    if (!resp.ok) {
      const text = await resp.text();
      throw new SmolvmError(resp.status, text);
    }
    return resp.json() as Promise<T>;
  }

  // --------------------------------------------------------------------------
  // Health
  // --------------------------------------------------------------------------

  async health(): Promise<HealthResponse> {
    const resp = await fetch(`${this.baseUrl}/health`);
    return this.json(resp);
  }

  // --------------------------------------------------------------------------
  // Machines
  // --------------------------------------------------------------------------

  async createMachine(req: CreateMachineRequest): Promise<MachineInfo> {
    const resp = await this.request("POST", "/machines", req);
    return this.json(resp);
  }

  async getMachine(name: string): Promise<MachineInfo> {
    const resp = await this.request("GET", `/machines/${name}`);
    return this.json(resp);
  }

  async listMachines(): Promise<MachineInfo[]> {
    const resp = await this.request("GET", "/machines");
    const data = await this.json<{ machines: MachineInfo[] }>(resp);
    return data.machines;
  }

  async machineStats(name: string): Promise<ResourceStats> {
    const resp = await this.request("GET", `/machines/${name}/stats`);
    return this.json(resp);
  }

  async startMachine(name: string): Promise<MachineInfo> {
    const resp = await this.request("POST", `/machines/${name}/start`);
    return this.json(resp);
  }

  async stopMachine(name: string): Promise<MachineInfo> {
    const resp = await this.request("POST", `/machines/${name}/stop`);
    return this.json(resp);
  }

  async deleteMachine(name: string, force = false): Promise<void> {
    const qs = force ? "?force=true" : "";
    const resp = await this.request("DELETE", `/machines/${name}${qs}`);
    if (!resp.ok) {
      const text = await resp.text();
      throw new SmolvmError(resp.status, text);
    }
    // Consume body
    await resp.text();
  }

  async execMachine(
    name: string,
    command: string[],
    opts?: ExecOptions,
  ): Promise<ExecResult> {
    const body: Record<string, unknown> = {
      command,
      env: opts?.env,
      workdir: opts?.workdir,
      timeoutSecs: opts?.timeout_secs ?? 30,
    };
    if (opts?.user) body.user = opts.user;
    const resp = await this.request("POST", `/machines/${name}/exec`, body);
    return this.json(resp);
  }

  async cloneMachine(sourceName: string, cloneName: string): Promise<MachineInfo> {
    const resp = await this.request("POST", `/machines/${sourceName}/clone`, {
      name: cloneName,
    });
    return this.json(resp);
  }

  async diffMachines(name: string, other: string): Promise<DiffResult> {
    const resp = await this.request("GET", `/machines/${name}/diff/${other}`);
    return this.json(resp);
  }

  async mergeMachines(
    sourceName: string,
    targetName: string,
    req?: MergeMachineRequest,
  ): Promise<MergeResponse> {
    const resp = await this.request(
      "POST",
      `/machines/${sourceName}/merge/${targetName}`,
      req ?? {},
    );
    return this.json(resp);
  }

  // --------------------------------------------------------------------------
  // File API
  // --------------------------------------------------------------------------

  async readFile(machineName: string, path: string): Promise<FileReadResponse> {
    const encodedPath = encodeURIComponent(path);
    const resp = await this.request("GET", `/machines/${machineName}/files/${encodedPath}`);
    return this.json(resp);
  }

  async writeFile(
    machineName: string,
    path: string,
    content: string,
    permissions?: string,
  ): Promise<void> {
    const encodedPath = encodeURIComponent(path);
    const body: Record<string, unknown> = { content };
    if (permissions) body.permissions = permissions;
    const resp = await this.request("PUT", `/machines/${machineName}/files/${encodedPath}`, body);
    if (!resp.ok) {
      const text = await resp.text();
      throw new SmolvmError(resp.status, text);
    }
    await resp.text();
  }

  async deleteFile(machineName: string, path: string): Promise<void> {
    const encodedPath = encodeURIComponent(path);
    const resp = await this.request("DELETE", `/machines/${machineName}/files/${encodedPath}`);
    if (!resp.ok) {
      const text = await resp.text();
      throw new SmolvmError(resp.status, text);
    }
    await resp.text();
  }

  async listFiles(machineName: string, dir?: string): Promise<FileListResponse> {
    const qs = dir ? `?dir=${encodeURIComponent(dir)}` : "";
    const resp = await this.request("GET", `/machines/${machineName}/files${qs}`);
    return this.json(resp);
  }

  // --------------------------------------------------------------------------
  // Multipart Upload & Archive
  // --------------------------------------------------------------------------

  /**
   * Upload a file via multipart/form-data (no base64 encoding needed).
   * Suitable for large binary files.
   */
  async uploadFile(
    machineName: string,
    path: string,
    data: Uint8Array | Blob,
    permissions?: string,
  ): Promise<{ uploaded: string; size: number }> {
    const encodedPath = encodeURIComponent(path);
    const form = new FormData();
    const blob = data instanceof Blob ? data : new Blob([data.buffer as ArrayBuffer]);
    form.append("file", blob);
    if (permissions) form.append("permissions", permissions);

    const headers: Record<string, string> = {};
    if (this.apiToken) headers["Authorization"] = `Bearer ${this.apiToken}`;
    const resp = await fetch(
      `${this.api}/machines/${machineName}/upload/${encodedPath}`,
      { method: "POST", body: form, headers },
    );
    return this.json(resp);
  }

  /**
   * Upload a tar.gz archive and extract it into a machine directory.
   */
  async uploadArchive(
    machineName: string,
    archive: Uint8Array | Blob,
    dir?: string,
  ): Promise<{ extracted_to: string; archive_size: number }> {
    const qs = dir ? `?dir=${encodeURIComponent(dir)}` : "";
    const body = archive instanceof Blob ? archive : new Blob([archive.buffer as ArrayBuffer]);
    const headers: Record<string, string> = { "Content-Type": "application/gzip" };
    if (this.apiToken) headers["Authorization"] = `Bearer ${this.apiToken}`;
    const resp = await fetch(
      `${this.api}/machines/${machineName}/archive/upload${qs}`,
      { method: "POST", headers, body },
    );
    return this.json(resp);
  }

  /**
   * Download a machine directory as a tar.gz archive.
   */
  async downloadArchive(
    machineName: string,
    dir?: string,
  ): Promise<Uint8Array> {
    const qs = dir ? `?dir=${encodeURIComponent(dir)}` : "";
    const headers: Record<string, string> = {};
    if (this.apiToken) headers["Authorization"] = `Bearer ${this.apiToken}`;
    const resp = await fetch(
      `${this.api}/machines/${machineName}/archive${qs}`,
      { headers },
    );
    if (!resp.ok) {
      const text = await resp.text();
      throw new SmolvmError(resp.status, text);
    }
    const buf = await resp.arrayBuffer();
    return new Uint8Array(buf);
  }

  // --------------------------------------------------------------------------
  // Starters
  // --------------------------------------------------------------------------

  async listStarters(): Promise<StarterInfo[]> {
    const resp = await this.request("GET", "/starters");
    const data = await this.json<StarterListResponse>(resp);
    return data.starters;
  }

  // --------------------------------------------------------------------------
  // Snapshots (push/pull)
  // --------------------------------------------------------------------------

  async pushMachine(machineName: string): Promise<void> {
    const resp = await this.request("POST", `/machines/${machineName}/push`);
    if (!resp.ok) {
      const text = await resp.text();
      throw new SmolvmError(resp.status, text);
    }
    await resp.text();
  }

  async listSnapshots(): Promise<SnapshotInfo[]> {
    const resp = await this.request("GET", "/snapshots");
    const data = await this.json<SnapshotListResponse>(resp);
    return data.snapshots;
  }

  async pullSnapshot(snapshotName: string, machineName: string): Promise<MachineInfo> {
    const resp = await this.request("POST", `/snapshots/${snapshotName}/pull`, {
      name: machineName,
    });
    return this.json(resp);
  }

  async deleteSnapshot(name: string): Promise<void> {
    const resp = await this.request("DELETE", `/snapshots/${name}`);
    if (!resp.ok) {
      const text = await resp.text();
      throw new SmolvmError(resp.status, text);
    }
    await resp.text();
  }

  // --------------------------------------------------------------------------
  // Run in Image
  // --------------------------------------------------------------------------

  async runInImage(
    machineName: string,
    image: string,
    command: string[],
    opts?: ExecOptions,
  ): Promise<ExecResult> {
    const body: Record<string, unknown> = {
      image,
      command,
      env: opts?.env,
      workdir: opts?.workdir,
      timeoutSecs: opts?.timeout_secs ?? 30,
    };
    if (opts?.user) body.user = opts.user;
    const resp = await this.request("POST", `/machines/${machineName}/run`, body);
    return this.json(resp);
  }

  // --------------------------------------------------------------------------
  // Images (scoped to a machine)
  // --------------------------------------------------------------------------

  async pullImage(machineName: string, image: string): Promise<{ image: ImageInfo }> {
    const resp = await this.request(
      "POST",
      `/machines/${machineName}/images/pull`,
      { image },
    );
    return this.json(resp);
  }

  async listImages(machineName: string): Promise<ImageInfo[]> {
    const resp = await this.request("GET", `/machines/${machineName}/images`);
    const data = await this.json<{ images: ImageInfo[] }>(resp);
    return data.images;
  }

  // --------------------------------------------------------------------------
  // Containers (inside a machine)
  // --------------------------------------------------------------------------

  async listContainers(
    machineName: string,
  ): Promise<ContainerInfo[]> {
    const resp = await this.request(
      "GET",
      `/machines/${machineName}/containers`,
    );
    const data = await this.json<{ containers: ContainerInfo[] }>(resp);
    return data.containers;
  }

  async createContainer(
    machineName: string,
    opts: CreateContainerOptions,
  ): Promise<ContainerInfo> {
    const resp = await this.request(
      "POST",
      `/machines/${machineName}/containers`,
      opts,
    );
    return this.json(resp);
  }

  async startContainer(machineName: string, containerId: string): Promise<void> {
    const resp = await this.request(
      "POST",
      `/machines/${machineName}/containers/${containerId}/start`,
    );
    if (!resp.ok) {
      const text = await resp.text();
      throw new SmolvmError(resp.status, text);
    }
    await resp.text();
  }

  async execContainer(
    machineName: string,
    containerId: string,
    command: string[],
    opts?: ExecOptions,
  ): Promise<ExecResult> {
    const resp = await this.request(
      "POST",
      `/machines/${machineName}/containers/${containerId}/exec`,
      {
        command,
        env: opts?.env,
        workdir: opts?.workdir,
        timeoutSecs: opts?.timeout_secs ?? 30,
      },
    );
    return this.json(resp);
  }

  async stopContainer(machineName: string, containerId: string): Promise<void> {
    const resp = await this.request(
      "POST",
      `/machines/${machineName}/containers/${containerId}/stop`,
      { timeoutSecs: 10 },
    );
    if (!resp.ok) {
      const text = await resp.text();
      throw new SmolvmError(resp.status, text);
    }
    await resp.text();
  }

  async deleteContainer(
    machineName: string,
    containerId: string,
    force = false,
  ): Promise<void> {
    const resp = await this.request(
      "DELETE",
      `/machines/${machineName}/containers/${containerId}`,
      force ? { force: true } : undefined,
    );
    if (!resp.ok) {
      const text = await resp.text();
      throw new SmolvmError(resp.status, text);
    }
    await resp.text();
  }

  // --------------------------------------------------------------------------
  // Debug Diagnostics
  // --------------------------------------------------------------------------

  async debugMounts(machineName: string): Promise<DebugMountsResponse> {
    const resp = await this.request(
      "GET",
      `/machines/${machineName}/debug/mounts`,
    );
    return this.json(resp);
  }

  async debugNetwork(machineName: string): Promise<DebugNetworkResponse> {
    const resp = await this.request(
      "GET",
      `/machines/${machineName}/debug/network`,
    );
    return this.json(resp);
  }

  // --------------------------------------------------------------------------
  // Checkpoints
  // --------------------------------------------------------------------------

  async createCheckpoint(machineName: string): Promise<CreateCheckpointResponse> {
    const resp = await this.request("POST", `/machines/${machineName}/checkpoint`);
    return this.json(resp);
  }

  async listCheckpoints(): Promise<CheckpointMetadata[]> {
    const resp = await this.request("GET", "/checkpoints");
    const data = await this.json<{ checkpoints: CheckpointMetadata[] }>(resp);
    return data.checkpoints;
  }

  async restoreCheckpoint(
    checkpointId: string,
    name: string,
  ): Promise<RestoreCheckpointResponse> {
    const resp = await this.request("POST", `/checkpoints/${checkpointId}/restore`, { name });
    return this.json(resp);
  }

  async deleteCheckpoint(checkpointId: string): Promise<void> {
    const resp = await this.request("DELETE", `/checkpoints/${checkpointId}`);
    if (!resp.ok) {
      const text = await resp.text();
      throw new SmolvmError(resp.status, text);
    }
    await resp.text();
  }

  // --------------------------------------------------------------------------
  // MicroVMs
  // --------------------------------------------------------------------------

  async createMicroVM(req: CreateMicroVMRequest): Promise<MicroVMInfo> {
    const resp = await this.request("POST", "/microvms", req);
    return this.json(resp);
  }

  async getMicroVM(name: string): Promise<MicroVMInfo> {
    const resp = await this.request("GET", `/microvms/${name}`);
    return this.json(resp);
  }

  async listMicroVMs(): Promise<MicroVMInfo[]> {
    const resp = await this.request("GET", "/microvms");
    const data = await this.json<{ microvms: MicroVMInfo[] }>(resp);
    return data.microvms;
  }

  async startMicroVM(name: string): Promise<MicroVMInfo> {
    const resp = await this.request("POST", `/microvms/${name}/start`);
    return this.json(resp);
  }

  async stopMicroVM(name: string): Promise<MicroVMInfo> {
    const resp = await this.request("POST", `/microvms/${name}/stop`);
    return this.json(resp);
  }

  async deleteMicroVM(name: string, force = false): Promise<void> {
    const qs = force ? "?force=true" : "";
    const resp = await this.request("DELETE", `/microvms/${name}${qs}`);
    if (!resp.ok) {
      const text = await resp.text();
      throw new SmolvmError(resp.status, text);
    }
    await resp.text();
  }

  async execMicroVM(
    name: string,
    command: string[],
    opts?: ExecOptions,
  ): Promise<ExecResult> {
    const resp = await this.request("POST", `/microvms/${name}/exec`, {
      command,
      env: opts?.env,
      workdir: opts?.workdir,
      timeoutSecs: opts?.timeout_secs ?? 30,
    });
    return this.json(resp);
  }

  // ── Jobs (Work Queue) ───────────────────────────────────────────

  async submitJob(req: SubmitJobRequest): Promise<SubmitJobResponse> {
    const resp = await this.request("POST", "/jobs", req);
    return this.json(resp);
  }

  async listJobs(opts?: { status?: string; machine?: string; limit?: number }): Promise<ListJobsResponse> {
    const params = new URLSearchParams();
    if (opts?.status) params.set("status", opts.status);
    if (opts?.machine) params.set("machine", opts.machine);
    if (opts?.limit) params.set("limit", String(opts.limit));
    const qs = params.toString() ? `?${params}` : "";
    const resp = await this.request("GET", `/jobs${qs}`);
    return this.json(resp);
  }

  async getJob(id: string): Promise<JobInfo> {
    const resp = await this.request("GET", `/jobs/${id}`);
    return this.json(resp);
  }

  async pollJob(): Promise<JobInfo | null> {
    const resp = await this.request("POST", "/jobs/poll");
    if (resp.status === 204) return null;
    return this.json(resp);
  }

  async completeJob(id: string, req: CompleteJobRequest): Promise<JobInfo> {
    const resp = await this.request("POST", `/jobs/${id}/complete`, req);
    return this.json(resp);
  }

  async failJob(id: string, error: string): Promise<JobInfo> {
    const resp = await this.request("POST", `/jobs/${id}/fail`, { error });
    return this.json(resp);
  }

  async deleteJob(id: string): Promise<void> {
    const resp = await this.request("DELETE", `/jobs/${id}`);
    if (!resp.ok) {
      const text = await resp.text();
      throw new SmolvmError(resp.status, text);
    }
    await resp.text();
  }
}
