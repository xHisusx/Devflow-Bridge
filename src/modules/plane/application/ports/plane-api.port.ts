import type { PlaneProject } from "../../domain/entities/project";
import type { PlaneMember } from "../../domain/entities/member";
import type { PlaneState } from "../../domain/entities/issue";

export interface UploadCredentials {
  upload_data: {
    url: string;
    fields: Record<string, string>;
  };
  asset_id: string;
}

export interface IntakeIssueResult {
  id: string;
  issue_id: string;
  sequence_id: number;
}

export interface PlaneLabel {
  id: string;
  name: string;
  color: string;
}

export interface PlaneWorkItem {
  id: string;
  sequence_id: number;
  name: string;
}

export interface IPlaneApiClient {
  getProjects(workspace: string): Promise<PlaneProject[]>;
  getMembers(workspace: string): Promise<PlaneMember[]>;
  getStates(workspace: string, projectId: string): Promise<PlaneState[]>;
  getLabels(workspace: string, projectId: string): Promise<PlaneLabel[]>;
  createIntakeIssue(
    workspace: string,
    projectId: string,
    issue: { name: string; description_html?: string },
  ): Promise<IntakeIssueResult>;
  getUploadCredentials(
    workspace: string,
    projectId: string,
    issueId: string,
    file: { name: string; type: string; size: number },
  ): Promise<UploadCredentials>;
  uploadToStorage(credentials: UploadCredentials, file: Blob): Promise<void>;
  completeUpload(
    workspace: string,
    projectId: string,
    issueId: string,
    assetId: string,
  ): Promise<void>;
  getWorkItem(
    workspace: string,
    projectId: string,
    issueId: string,
  ): Promise<PlaneWorkItem>;
  updateWorkItem(
    workspace: string,
    projectId: string,
    issueId: string,
    data: { description_html?: string; labels?: string[]; priority?: string },
  ): Promise<void>;
}
