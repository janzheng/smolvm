/**
 * smolvm TypeScript SDK — HTTP Client
 *
 * Low-level transport layer. Handles all REST API communication.
 * Users should prefer the high-level Sandbox/MicroVM classes.
 */

import type {
  CheckpointMetadata,
  CloneSandboxRequest,
  ContainerInfo,
  CreateCheckpointResponse,
  CreateContainerOptions,
  CreateMicroVMRequest,
  CreateSandboxRequest,
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
  MergeSandboxRequest,
  MicroVMInfo,
  ResourceStats,
  RestoreCheckpointResponse,
  SandboxInfo,
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
  // Sandboxes
  // --------------------------------------------------------------------------

  async createSandbox(req: CreateSandboxRequest): Promise<SandboxInfo> {
    const resp = await this.request("POST", "/sandboxes", req);
    return this.json(resp);
  }

  async getSandbox(name: string): Promise<SandboxInfo> {
    const resp = await this.request("GET", `/sandboxes/${name}`);
    return this.json(resp);
  }

  async listSandboxes(): Promise<SandboxInfo[]> {
    const resp = await this.request("GET", "/sandboxes");
    const data = await this.json<{ sandboxes: SandboxInfo[] }>(resp);
    return data.sandboxes;
  }

  async sandboxStats(name: string): Promise<ResourceStats> {
    const resp = await this.request("GET", `/sandboxes/${name}/stats`);
    return this.json(resp);
  }

  async startSandbox(name: string): Promise<SandboxInfo> {
    const resp = await this.request("POST", `/sandboxes/${name}/start`);
    return this.json(resp);
  }

  async stopSandbox(name: string): Promise<SandboxInfo> {
    const resp = await this.request("POST", `/sandboxes/${name}/stop`);
    return this.json(resp);
  }

  async deleteSandbox(name: string, force = false): Promise<void> {
    const qs = force ? "?force=true" : "";
    const resp = await this.request("DELETE", `/sandboxes/${name}${qs}`);
    if (!resp.ok) {
      const text = await resp.text();
      throw new SmolvmError(resp.status, text);
    }
    // Consume body
    await resp.text();
  }

  async execSandbox(
    name: string,
    command: string[],
    opts?: ExecOptions,
  ): Promise<ExecResult> {
    const body: Record<string, unknown> = {
      command,
      env: opts?.env,
      workdir: opts?.workdir,
      timeout_secs: opts?.timeout_secs ?? 30,
    };
    if (opts?.user) body.user = opts.user;
    const resp = await this.request("POST", `/sandboxes/${name}/exec`, body);
    return this.json(resp);
  }

  async cloneSandbox(sourceName: string, cloneName: string): Promise<SandboxInfo> {
    const resp = await this.request("POST", `/sandboxes/${sourceName}/clone`, {
      name: cloneName,
    });
    return this.json(resp);
  }

  async diffSandboxes(name: string, other: string): Promise<DiffResult> {
    const resp = await this.request("GET", `/sandboxes/${name}/diff/${other}`);
    return this.json(resp);
  }

  async mergeSandboxes(
    sourceName: string,
    targetName: string,
    req?: MergeSandboxRequest,
  ): Promise<MergeResponse> {
    const resp = await this.request(
      "POST",
      `/sandboxes/${sourceName}/merge/${targetName}`,
      req ?? {},
    );
    return this.json(resp);
  }

  // --------------------------------------------------------------------------
  // File API
  // --------------------------------------------------------------------------

  async readFile(sandboxName: string, path: string): Promise<FileReadResponse> {
    const encodedPath = encodeURIComponent(path);
    const resp = await this.request("GET", `/sandboxes/${sandboxName}/files/${encodedPath}`);
    return this.json(resp);
  }

  async writeFile(
    sandboxName: string,
    path: string,
    content: string,
    permissions?: string,
  ): Promise<void> {
    const encodedPath = encodeURIComponent(path);
    const body: Record<string, unknown> = { content };
    if (permissions) body.permissions = permissions;
    const resp = await this.request("PUT", `/sandboxes/${sandboxName}/files/${encodedPath}`, body);
    if (!resp.ok) {
      const text = await resp.text();
      throw new SmolvmError(resp.status, text);
    }
    await resp.text();
  }

  async deleteFile(sandboxName: string, path: string): Promise<void> {
    const encodedPath = encodeURIComponent(path);
    const resp = await this.request("DELETE", `/sandboxes/${sandboxName}/files/${encodedPath}`);
    if (!resp.ok) {
      const text = await resp.text();
      throw new SmolvmError(resp.status, text);
    }
    await resp.text();
  }

  async listFiles(sandboxName: string, dir?: string): Promise<FileListResponse> {
    const qs = dir ? `?dir=${encodeURIComponent(dir)}` : "";
    const resp = await this.request("GET", `/sandboxes/${sandboxName}/files${qs}`);
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
    sandboxName: string,
    path: string,
    data: Uint8Array | Blob,
    permissions?: string,
  ): Promise<{ uploaded: string; size: number }> {
    const encodedPath = encodeURIComponent(path);
    const form = new FormData();
    const blob = data instanceof Blob ? data : new Blob([data.buffer as ArrayBuffer]);
    form.append("file", blob);
    if (permissions) form.append("permissions", permissions);

    const resp = await fetch(
      `${this.api}/sandboxes/${sandboxName}/upload/${encodedPath}`,
      { method: "POST", body: form },
    );
    return this.json(resp);
  }

  /**
   * Upload a tar.gz archive and extract it into a sandbox directory.
   */
  async uploadArchive(
    sandboxName: string,
    archive: Uint8Array | Blob,
    dir?: string,
  ): Promise<{ extracted_to: string; archive_size: number }> {
    const qs = dir ? `?dir=${encodeURIComponent(dir)}` : "";
    const body = archive instanceof Blob ? archive : new Blob([archive.buffer as ArrayBuffer]);
    const resp = await fetch(
      `${this.api}/sandboxes/${sandboxName}/archive/upload${qs}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/gzip" },
        body,
      },
    );
    return this.json(resp);
  }

  /**
   * Download a sandbox directory as a tar.gz archive.
   */
  async downloadArchive(
    sandboxName: string,
    dir?: string,
  ): Promise<Uint8Array> {
    const qs = dir ? `?dir=${encodeURIComponent(dir)}` : "";
    const resp = await fetch(
      `${this.api}/sandboxes/${sandboxName}/archive${qs}`,
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

  async pushSandbox(sandboxName: string): Promise<void> {
    const resp = await this.request("POST", `/sandboxes/${sandboxName}/push`);
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

  async pullSnapshot(snapshotName: string, sandboxName: string): Promise<SandboxInfo> {
    const resp = await this.request("POST", `/snapshots/${snapshotName}/pull`, {
      name: sandboxName,
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
    sandboxName: string,
    image: string,
    command: string[],
    opts?: ExecOptions,
  ): Promise<ExecResult> {
    const body: Record<string, unknown> = {
      image,
      command,
      env: opts?.env,
      workdir: opts?.workdir,
      timeout_secs: opts?.timeout_secs ?? 30,
    };
    if (opts?.user) body.user = opts.user;
    const resp = await this.request("POST", `/sandboxes/${sandboxName}/run`, body);
    return this.json(resp);
  }

  // --------------------------------------------------------------------------
  // Images (scoped to a sandbox)
  // --------------------------------------------------------------------------

  async pullImage(sandboxName: string, image: string): Promise<{ image: ImageInfo }> {
    const resp = await this.request(
      "POST",
      `/sandboxes/${sandboxName}/images/pull`,
      { image },
    );
    return this.json(resp);
  }

  async listImages(sandboxName: string): Promise<ImageInfo[]> {
    const resp = await this.request("GET", `/sandboxes/${sandboxName}/images`);
    const data = await this.json<{ images: ImageInfo[] }>(resp);
    return data.images;
  }

  // --------------------------------------------------------------------------
  // Containers (inside a sandbox)
  // --------------------------------------------------------------------------

  async listContainers(
    sandboxName: string,
  ): Promise<ContainerInfo[]> {
    const resp = await this.request(
      "GET",
      `/sandboxes/${sandboxName}/containers`,
    );
    const data = await this.json<{ containers: ContainerInfo[] }>(resp);
    return data.containers;
  }

  async createContainer(
    sandboxName: string,
    opts: CreateContainerOptions,
  ): Promise<ContainerInfo> {
    const resp = await this.request(
      "POST",
      `/sandboxes/${sandboxName}/containers`,
      opts,
    );
    return this.json(resp);
  }

  async startContainer(sandboxName: string, containerId: string): Promise<void> {
    const resp = await this.request(
      "POST",
      `/sandboxes/${sandboxName}/containers/${containerId}/start`,
    );
    if (!resp.ok) {
      const text = await resp.text();
      throw new SmolvmError(resp.status, text);
    }
    await resp.text();
  }

  async execContainer(
    sandboxName: string,
    containerId: string,
    command: string[],
    opts?: ExecOptions,
  ): Promise<ExecResult> {
    const resp = await this.request(
      "POST",
      `/sandboxes/${sandboxName}/containers/${containerId}/exec`,
      {
        command,
        env: opts?.env,
        workdir: opts?.workdir,
        timeout_secs: opts?.timeout_secs ?? 30,
      },
    );
    return this.json(resp);
  }

  async stopContainer(sandboxName: string, containerId: string): Promise<void> {
    const resp = await this.request(
      "POST",
      `/sandboxes/${sandboxName}/containers/${containerId}/stop`,
      { timeout_secs: 10 },
    );
    if (!resp.ok) {
      const text = await resp.text();
      throw new SmolvmError(resp.status, text);
    }
    await resp.text();
  }

  async deleteContainer(
    sandboxName: string,
    containerId: string,
    force = false,
  ): Promise<void> {
    const resp = await this.request(
      "DELETE",
      `/sandboxes/${sandboxName}/containers/${containerId}`,
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

  async debugMounts(sandboxName: string): Promise<DebugMountsResponse> {
    const resp = await this.request(
      "GET",
      `/sandboxes/${sandboxName}/debug/mounts`,
    );
    return this.json(resp);
  }

  async debugNetwork(sandboxName: string): Promise<DebugNetworkResponse> {
    const resp = await this.request(
      "GET",
      `/sandboxes/${sandboxName}/debug/network`,
    );
    return this.json(resp);
  }

  // --------------------------------------------------------------------------
  // Checkpoints
  // --------------------------------------------------------------------------

  async createCheckpoint(sandboxName: string): Promise<CreateCheckpointResponse> {
    const resp = await this.request("POST", `/sandboxes/${sandboxName}/checkpoint`);
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
      timeout_secs: opts?.timeout_secs ?? 30,
    });
    return this.json(resp);
  }

  // ── Jobs (Work Queue) ───────────────────────────────────────────

  async submitJob(req: SubmitJobRequest): Promise<SubmitJobResponse> {
    const resp = await this.request("POST", "/jobs", req);
    return this.json(resp);
  }

  async listJobs(opts?: { status?: string; sandbox?: string; limit?: number }): Promise<ListJobsResponse> {
    const params = new URLSearchParams();
    if (opts?.status) params.set("status", opts.status);
    if (opts?.sandbox) params.set("sandbox", opts.sandbox);
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
