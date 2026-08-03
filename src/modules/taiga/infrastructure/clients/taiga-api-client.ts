import { TaigaClient as TaigaSdk } from "taiga-api-client";
import type { Issue, Task, UserStory } from "taiga-api-client";
import type { TaigaEntity } from "../../../../core/config";
import type {
  ITaigaApiClient,
  TaigaCreatePayload,
  TaigaCreatedItem,
  TaigaItemInfo,
  TaigaItemPatch,
  TaigaProjectInfo,
  TaigaStatusInfo,
} from "../../application/ports/taiga-api.port";

export interface TaigaCredentials {
  /** Long-lived Application token (`Authorization: Application <token>`). */
  applicationToken?: string;
  /** Username/email + password — logged in once via `login()` at startup. */
  username?: string;
  password?: string;
}

/** Adapter over the `taiga-api-client` SDK implementing the ITaigaApiClient port. */
export class TaigaApiClient implements ITaigaApiClient {
  private sdk: TaigaSdk;
  private credentials: TaigaCredentials;

  constructor(baseUrl: string, credentials: TaigaCredentials) {
    this.credentials = credentials;
    this.sdk = new TaigaSdk({
      baseUrl,
      applicationToken: credentials.applicationToken ?? null,
    });
  }

  /** Perform username/password login when no application token is configured. */
  async login(): Promise<void> {
    if (this.credentials.applicationToken) return;
    const { username, password } = this.credentials;
    if (!username || !password) {
      throw new Error("Taiga credentials missing: set application token or username/password");
    }
    await this.sdk.auth.login({ username, password });
  }

  async getProjectBySlug(slug: string): Promise<TaigaProjectInfo> {
    const project = await this.sdk.projects.getBySlug(slug);
    return { id: project.id, slug: project.slug, name: project.name };
  }

  async createItem(entity: TaigaEntity, payload: TaigaCreatePayload): Promise<TaigaCreatedItem> {
    const body = {
      project: payload.project,
      subject: payload.subject,
      ...(payload.description ? { description: payload.description } : {}),
      ...(payload.tags && payload.tags.length > 0
        ? { tags: payload.tags.map((t): [string, string | null] => [t, null]) }
        : {}),
    };

    let item: Issue | UserStory | Task;
    if (entity === "user_story") {
      item = await this.sdk.userStories.create(body);
    } else if (entity === "task") {
      item = await this.sdk.tasks.create(body);
    } else {
      item = await this.sdk.issues.create({
        ...body,
        ...(payload.typeId != null ? { type: payload.typeId } : {}),
        ...(payload.priorityId != null ? { priority: payload.priorityId } : {}),
      });
    }

    // Detail serializers carry nested *_extra_info objects the SDK types don't declare.
    const raw = item as unknown as Record<string, any>;
    return {
      id: item.id,
      ref: item.ref,
      subject: item.subject,
      description: item.description ?? "",
      tags: (item.tags ?? []).map(([name]) => name),
      status: item.status ?? null,
      statusName: raw.status_extra_info?.name ?? null,
      typeId: typeof raw.type === "number" ? raw.type : null,
      priorityId: typeof raw.priority === "number" ? raw.priority : null,
    };
  }

  private resource(entity: TaigaEntity) {
    if (entity === "user_story") return this.sdk.userStories;
    if (entity === "task") return this.sdk.tasks;
    return this.sdk.issues;
  }

  async getItem(entity: TaigaEntity, id: number): Promise<TaigaItemInfo> {
    const item = await this.resource(entity).get(id);
    const raw = item as unknown as Record<string, any>;
    return {
      id: item.id,
      ref: item.ref,
      subject: item.subject,
      version: item.version,
      status: item.status,
      statusName: raw.status_extra_info?.name ?? null,
      assigneeName:
        raw.assigned_to_extra_info?.full_name_display ?? raw.assigned_to_extra_info?.full_name ?? null,
      typeId: typeof raw.type === "number" ? raw.type : null,
      priorityId: typeof raw.priority === "number" ? raw.priority : null,
    };
  }

  async getItemStatuses(entity: TaigaEntity, projectId: number): Promise<TaigaStatusInfo[]> {
    const data = await this.resource(entity).filtersData({ project: projectId });
    const statuses = (data.statuses ?? []) as Array<{ id: number; name: string }>;
    return statuses.map((s) => ({ id: s.id, name: s.name }));
  }

  async getIssueTypes(projectId: number): Promise<TaigaStatusInfo[]> {
    const data = await this.sdk.issues.filtersData({ project: projectId });
    const types = (data.types ?? []) as Array<{ id: number; name: string }>;
    return types.map((t) => ({ id: t.id, name: t.name }));
  }

  async getPriorities(projectId: number): Promise<TaigaStatusInfo[]> {
    const data = await this.sdk.issues.filtersData({ project: projectId });
    const priorities = ((data as Record<string, any>).priorities ?? []) as Array<{ id: number; name: string }>;
    return priorities.map((p) => ({ id: p.id, name: p.name }));
  }

  async updateItem(entity: TaigaEntity, id: number, patch: TaigaItemPatch, version: number): Promise<void> {
    await this.resource(entity).patch(id, patch, version);
  }

  async getMemberIdByEmail(projectId: number, email: string): Promise<number | null> {
    const needle = email.trim().toLowerCase();
    for await (const m of this.sdk.memberships.paginate({ project: projectId })) {
      if (m.user !== null && (m.user_email ?? "").toLowerCase() === needle) return m.user;
    }
    return null;
  }
}
