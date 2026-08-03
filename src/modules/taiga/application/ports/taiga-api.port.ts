import type { TaigaEntity } from "../../../../core/config";

export interface TaigaProjectInfo {
  id: number;
  slug: string;
  name: string;
}

export interface TaigaCreatedItem {
  id: number;
  ref: number;
  subject: string;
  description: string;
  tags: string[];
  status: number | null;
  /** Status name from *_extra_info when the API returns it, else null (resolve via getItemStatuses). */
  statusName: string | null;
  /** Issue type id (issues only). */
  typeId: number | null;
  /** Priority id (issues only). */
  priorityId: number | null;
}

export interface TaigaCreatePayload {
  project: number;
  subject: string;
  description?: string;
  tags?: string[];
  /** Issue type id (issues only; ignored for user stories and tasks). */
  typeId?: number;
  /** Priority id (issues only; ignored for user stories and tasks). */
  priorityId?: number;
}

export interface TaigaStatusInfo {
  id: number;
  name: string;
}

export interface TaigaItemInfo {
  id: number;
  ref: number;
  subject: string;
  /** OCC version, required for patches. */
  version: number;
  status: number;
  statusName: string | null;
  /** Assignee display name, or null when unassigned. */
  assigneeName: string | null;
  /** Issue type id (issues only). */
  typeId: number | null;
  /** Priority id (issues only). */
  priorityId: number | null;
}

export interface TaigaItemPatch {
  status?: number;
  assigned_to?: number;
}

export interface ITaigaApiClient {
  getProjectBySlug(slug: string): Promise<TaigaProjectInfo>;
  createItem(entity: TaigaEntity, payload: TaigaCreatePayload): Promise<TaigaCreatedItem>;
  getItem(entity: TaigaEntity, id: number): Promise<TaigaItemInfo>;
  getItemStatuses(entity: TaigaEntity, projectId: number): Promise<TaigaStatusInfo[]>;
  /** Issue types of the project (issues only; "Ошибка", "Вопрос", ...). */
  getIssueTypes(projectId: number): Promise<TaigaStatusInfo[]>;
  /** Issue priorities of the project (issues only; "Low", "Normal", ...). */
  getPriorities(projectId: number): Promise<TaigaStatusInfo[]>;
  updateItem(entity: TaigaEntity, id: number, patch: TaigaItemPatch, version: number): Promise<void>;
  /** Resolve a project member's Taiga user id by email (case-insensitive), or null. */
  getMemberIdByEmail(projectId: number, email: string): Promise<number | null>;
}
