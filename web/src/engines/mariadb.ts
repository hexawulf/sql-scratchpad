import type {
  ApiErrorResponse,
  CreateWorkspaceResponse,
  DatasetMeta,
  EngineAdapter,
  ExecRequest,
  ExecResponse,
  ImportRequest,
  ImportResponse,
  OkResponse,
  ResetWorkspaceResponse,
  SchemaTree,
  SessionId,
} from '@sql-scratchpad/shared';

export class ApiHttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiHttpError';
    this.status = status;
    this.code = code;
  }
}

export class WorkspaceExpiredError extends ApiHttpError {
  constructor(message = 'Workspace expired') {
    super(404, 'WORKSPACE_NOT_FOUND', message);
    this.name = 'WorkspaceExpiredError';
  }
}

export type FetchLike = typeof fetch;

export interface MariaDbAdapterOptions {
  baseUrl?: string;
  fetchImpl?: FetchLike;
  initialWsId?: string | null;
  initialDatabase?: string | null;
}

export class MariaDbAdapter implements EngineAdapter {
  readonly id = 'mariadb' as const;

  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private wsId: string | null;
  private database: string | null;

  constructor(options: MariaDbAdapterOptions = {}) {
    this.baseUrl = (options.baseUrl ?? '/api').replace(/\/+$/, '');
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.wsId = options.initialWsId ?? null;
    this.database = options.initialDatabase ?? null;
  }

  getWorkspaceId(): string | null {
    return this.wsId;
  }

  getDatabase(): string | null {
    return this.database;
  }

  attach(wsId: string, database: string | null = null): void {
    this.wsId = wsId;
    this.database = database;
  }

  async fetchDatasets(): Promise<DatasetMeta[]> {
    return this.request<DatasetMeta[]>('/datasets', { method: 'GET' });
  }

  async open(datasetId: string): Promise<void> {
    const res = await this.request<CreateWorkspaceResponse>('/workspaces', {
      method: 'POST',
      body: JSON.stringify({ dataset: datasetId }),
    });
    this.wsId = res.wsId;
    this.database = res.database;
  }

  async exec(req: ExecRequest): Promise<ExecResponse> {
    const wsId = this.requireWorkspace();
    return this.request<ExecResponse>(`/workspaces/${encodeURIComponent(wsId)}/exec`, {
      method: 'POST',
      body: JSON.stringify(req),
    });
  }

  async importSql(req: ImportRequest): Promise<ImportResponse> {
    const wsId = this.requireWorkspace();
    return this.request<ImportResponse>(`/workspaces/${encodeURIComponent(wsId)}/import`, {
      method: 'POST',
      body: JSON.stringify(req),
    });
  }

  async schema(): Promise<SchemaTree> {
    const wsId = this.requireWorkspace();
    const tree = await this.request<SchemaTree>(
      `/workspaces/${encodeURIComponent(wsId)}/schema`,
      { method: 'GET' },
    );
    this.database = tree.database;
    return tree;
  }

  async reset(datasetId: string): Promise<void> {
    const wsId = this.requireWorkspace();
    const res = await this.request<ResetWorkspaceResponse>(
      `/workspaces/${encodeURIComponent(wsId)}/reset`,
      {
        method: 'POST',
        body: JSON.stringify({ dataset: datasetId }),
      },
    );
    this.database = res.database;
  }

  async kill(session: SessionId = 'A'): Promise<void> {
    const wsId = this.requireWorkspace();
    await this.request<OkResponse>(
      `/workspaces/${encodeURIComponent(wsId)}/sessions/${encodeURIComponent(session)}/kill`,
      { method: 'POST' },
    );
  }

  async close(): Promise<void> {
    if (!this.wsId) return;
    const wsId = this.wsId;
    this.wsId = null;
    this.database = null;
    try {
      await this.request<OkResponse>(`/workspaces/${encodeURIComponent(wsId)}`, {
        method: 'DELETE',
      });
    } catch (err) {
      if (err instanceof WorkspaceExpiredError) return;
      throw err;
    }
  }

  private requireWorkspace(): string {
    if (!this.wsId) {
      throw new WorkspaceExpiredError('No active workspace');
    }
    return this.wsId;
  }

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    const headers = new Headers(init.headers);
    if (init.body !== undefined && !headers.has('content-type')) {
      headers.set('content-type', 'application/json');
    }
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      headers,
    });
    if (!response.ok) {
      let code = 'HTTP_ERROR';
      let message = `Request failed with status ${response.status}`;
      try {
        const body = (await response.json()) as Partial<ApiErrorResponse>;
        if (body.error?.code) code = body.error.code;
        if (body.error?.message) message = body.error.message;
      } catch {
        // Non-JSON error body
      }
      if (response.status === 404) {
        throw new WorkspaceExpiredError(message);
      }
      throw new ApiHttpError(response.status, code, message);
    }
    return (await response.json()) as T;
  }
}
