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
  description: string;
  tags: string[];
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
  /** Taiga posts a comment when a patch carries one. */
  comment?: string;
}

/** One task of a user story, as the story's progress is judged by. */
export interface TaigaTaskSummary {
  id: number;
  ref: number;
  subject: string;
  /** Status id; the names live in the project (see getItemStatuses). */
  status: number;
  isClosed: boolean;
}

/** A project's custom field definition ("MR", "Ветка"). */
export interface TaigaCustomAttribute {
  id: number;
  name: string;
}

/** An item's custom field values, keyed by attribute id, with their own OCC version. */
export interface TaigaCustomAttributeValues {
  values: Record<string, unknown>;
  version: number;
}

export interface ITaigaApiClient {
  getProjectBySlug(slug: string): Promise<TaigaProjectInfo>;
  createItem(entity: TaigaEntity, payload: TaigaCreatePayload): Promise<TaigaCreatedItem>;
  getItem(entity: TaigaEntity, id: number): Promise<TaigaItemInfo>;
  getItemStatuses(entity: TaigaEntity, projectId: number): Promise<TaigaStatusInfo[]>;
  /**
   * Tasks belonging to a user story. A story's work is split across its tasks, so this is what
   * answers "is everything under this story finished" — a question no single event can answer.
   */
  getTasksOfUserStory(userStoryId: number): Promise<TaigaTaskSummary[]>;
  /** Issue types of the project (issues only; "Ошибка", "Вопрос", ...). */
  getIssueTypes(projectId: number): Promise<TaigaStatusInfo[]>;
  /** Issue priorities of the project (issues only; "Low", "Normal", ...). */
  getPriorities(projectId: number): Promise<TaigaStatusInfo[]>;
  updateItem(entity: TaigaEntity, id: number, patch: TaigaItemPatch, version: number): Promise<void>;
  /** Resolve a project member's Taiga user id by email (case-insensitive), or null. */
  getMemberIdByEmail(projectId: number, email: string): Promise<number | null>;
  /**
   * Resolve a project member's email by Taiga user id, or null. Webhook payloads carry only
   * `assigned_to.id`, so this is how an event's assignee is matched to GitLab / Pachka accounts.
   */
  getMemberEmailById(projectId: number, userId: number): Promise<string | null>;
  /** Custom field definitions of the project, for resolving a field name to its id. */
  getCustomAttributes(entity: TaigaEntity, projectId: number): Promise<TaigaCustomAttribute[]>;
  getCustomAttributeValues(entity: TaigaEntity, itemId: number): Promise<TaigaCustomAttributeValues>;
  /** Patch custom field values (merged with the current ones by the caller). */
  setCustomAttributeValues(
    entity: TaigaEntity,
    itemId: number,
    values: Record<string, unknown>,
    version: number,
  ): Promise<void>;
}
