import type { PlaneState } from "../../domain/entities/issue";
import type { PlaneProject } from "../../domain/entities/project";
import type { PlaneMember } from "../../domain/entities/member";
import type { IPlaneApiClient, UploadCredentials, IntakeIssueResult, PlaneLabel, PlaneWorkItem } from "../../application/ports/plane-api.port";

export class PlaneClient implements IPlaneApiClient {
  private baseUrl: string;
  private apiKey: string;

  constructor(baseUrl: string, apiKey: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.apiKey = apiKey;
  }

  private async request<T>(
    path: string,
    options?: { method?: string; body?: unknown },
  ): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: options?.method ?? "GET",
      headers: {
        "X-API-Key": this.apiKey,
        ...(options?.body ? { "Content-Type": "application/json" } : {}),
      },
      ...(options?.body ? { body: JSON.stringify(options.body) } : {}),
    });
    if (!res.ok) {
      throw new Error(`Plane API ${path}: ${res.status} ${res.statusText}`);
    }
    return res.json() as Promise<T>;
  }

  async getStates(workspace: string, projectId: string): Promise<PlaneState[]> {
    const data = await this.request<{ results: PlaneState[] }>(
      `/api/v1/workspaces/${workspace}/projects/${projectId}/states/`
    );
    return data.results;
  }

  async getProjects(workspace: string): Promise<PlaneProject[]> {
    const data = await this.request<{ results: PlaneProject[] }>(
      `/api/v1/workspaces/${workspace}/projects/`
    );
    return data.results;
  }

  async getMembers(workspace: string): Promise<PlaneMember[]> {
    return this.request<PlaneMember[]>(
      `/api/v1/workspaces/${workspace}/members/`
    );
  }

  async getLabels(workspace: string, projectId: string): Promise<PlaneLabel[]> {
    const data = await this.request<{ results: PlaneLabel[] }>(
      `/api/v1/workspaces/${workspace}/projects/${projectId}/labels/`
    );
    return data.results;
  }

  async createIntakeIssue(
    workspace: string,
    projectId: string,
    issue: { name: string; description_html?: string },
  ): Promise<IntakeIssueResult> {
    const data = await this.request<{ id: string; issue_detail: { id: string; sequence_id: number } }>(
      `/api/v1/workspaces/${workspace}/projects/${projectId}/intake-issues/`,
      { method: "POST", body: { issue } },
    );
    return { id: data.id, issue_id: data.issue_detail.id, sequence_id: data.issue_detail.sequence_id };
  }

  async getUploadCredentials(
    workspace: string,
    projectId: string,
    issueId: string,
    file: { name: string; type: string; size: number },
  ): Promise<UploadCredentials> {
    return this.request<UploadCredentials>(
      `/api/v1/workspaces/${workspace}/projects/${projectId}/work-items/${issueId}/attachments/`,
      { method: "POST", body: file },
    );
  }

  async uploadToStorage(credentials: UploadCredentials, file: Blob): Promise<void> {
    const formData = new FormData();
    for (const [key, value] of Object.entries(credentials.upload_data.fields)) {
      formData.append(key, value);
    }
    formData.append("file", file);

    const res = await fetch(credentials.upload_data.url, {
      method: "POST",
      body: formData,
    });
    if (!res.ok) {
      throw new Error(`Storage upload failed: ${res.status} ${res.statusText}`);
    }
  }

  async completeUpload(
    workspace: string,
    projectId: string,
    issueId: string,
    assetId: string,
  ): Promise<void> {
    await this.request(
      `/api/v1/workspaces/${workspace}/projects/${projectId}/work-items/${issueId}/attachments/${assetId}/`,
      { method: "PATCH" },
    );
  }

  async getWorkItem(
    workspace: string,
    projectId: string,
    issueId: string,
  ): Promise<PlaneWorkItem> {
    return this.request<PlaneWorkItem>(
      `/api/v1/workspaces/${workspace}/projects/${projectId}/work-items/${issueId}/`,
    );
  }

  async updateWorkItem(
    workspace: string,
    projectId: string,
    issueId: string,
    data: { description_html?: string; labels?: string[]; priority?: string },
  ): Promise<void> {
    await this.request(
      `/api/v1/workspaces/${workspace}/projects/${projectId}/work-items/${issueId}/`,
      { method: "PATCH", body: data },
    );
  }
}
