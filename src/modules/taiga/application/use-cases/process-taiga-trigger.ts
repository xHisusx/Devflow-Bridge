import type { Config, TaigaProvider } from "../../../../core/config";
import type { ProviderRegistry } from "../../../../core/provider-registry";
import type { Rule } from "../../../messenger/domain/entities/notification";
import type { ITaigaApiClient } from "../ports/taiga-api.port";
import type { TaigaWebhookPayload } from "../../domain/entities/taiga-webhook-payload";
import { parseRef } from "../../../messenger/domain/entities/notification";
import { Deduplicator } from "../../../plane/domain/services/deduplicator";
import { formatReceivedAt } from "../../../plane/application/use-cases/process-intake-pipeline";
import { buildItemUrl, statusLabel } from "../../domain/services/feedback-buttons";
import {
  buildTaigaTriggerOutputs,
  extractProjectSlug,
  extractTaigaFacts,
  matchesTaigaCondition,
  type TaigaTriggerFacts,
} from "../../domain/services/taiga-trigger";
import { initials, slugify } from "../../../../core/slug";
import { log } from "../../../../core/logger";

/** Structural dependency on the pipeline engine (implemented by ProcessIntakePipelineUseCase). */
export interface TaigaPipelineRunner {
  run(pipeline: Rule[], triggerOutputs: Record<string, unknown>, files?: File[]): Promise<unknown>;
}

export interface TaigaTriggerResult {
  ok: boolean;
  /** How many pipelines this event started. */
  triggered: number;
}

/**
 * Taiga webhook as a pipeline *trigger* (`from: "taiga:<alias>"` as a pipeline's first step):
 * an item event (created, assigned, status change) runs the matching pipelines, e.g.
 * "task got its first assignee" -> create a branch and a draft MR in GitLab -> DM the assignee.
 *
 * The assignee's email is resolved through the project's memberships, because webhook payloads
 * carry only the user's id and display name. That email is what links the person across systems
 * (Taiga member -> GitLab user -> Pachka profile).
 */
export class ProcessTaigaTriggerUseCase {
  private deduplicator = new Deduplicator();
  /** projectId -> (taiga user id -> email). Successful lookups only; memberships rarely change. */
  private emailCache = new Map<string, string>();

  constructor(
    private config: Config,
    private registry: ProviderRegistry,
    private taigaClients: Map<string, ITaigaApiClient>,
    private pipelineRunner: TaigaPipelineRunner | null,
  ) {}

  async execute(payload: TaigaWebhookPayload): Promise<TaigaTriggerResult> {
    const itemId = payload.data?.id;
    if (payload.action === "test" || !this.pipelineRunner || !itemId) {
      return { ok: true, triggered: 0 };
    }

    const facts = extractTaigaFacts(payload);
    const slug = extractProjectSlug(payload.data?.project?.permalink);
    let triggered = 0;

    for (let index = 0; index < this.config.rules.length; index++) {
      const pipeline = this.config.rules[index];
      const trigger = pipeline[0];
      if (!trigger || parseRef(trigger.from).type !== "taiga") continue;

      const provider = this.registry.getTaiga(trigger.from);
      if (!provider) continue;
      if (slug && provider.project !== slug) continue;

      // Without an explicit `on.entity` the provider's own entity kind gates the event, so an
      // issue-provider does not fire on user-story events of the same project.
      if (!trigger.on.entity && (provider.entity ?? "issue") !== facts.entity) continue;
      if (!matchesTaigaCondition(trigger.on, facts)) continue;

      const dedupKey = [
        index, trigger.from, itemId, facts.action, facts.status,
        facts.changedFields.join("|"), payload.data?.assigned_to?.id ?? "",
      ].join(":");
      if (this.deduplicator.isDuplicate(dedupKey)) {
        log.debug("Taiga trigger: duplicate event skipped", { itemId, pipeline: index });
        continue;
      }

      log.info(`Taiga trigger: ${trigger.from} ${facts.action} #${payload.data?.ref ?? itemId}`, {
        entity: facts.entity,
        status: facts.status,
        changed: facts.changedFields,
      });

      const outputs = await this.buildOutputs(provider, payload, facts);
      try {
        await this.pipelineRunner.run(pipeline, outputs);
        triggered++;
      } catch (e) {
        log.error("Taiga trigger: pipeline failed", {
          trigger: trigger.from,
          itemId,
          error: String(e),
        });
      }
    }

    return { ok: true, triggered };
  }

  /** Trigger outputs for the templates of the pipeline's steps. */
  private async buildOutputs(
    provider: TaigaProvider,
    payload: TaigaWebhookPayload,
    facts: TaigaTriggerFacts,
  ): Promise<Record<string, unknown>> {
    const data = payload.data ?? {};
    const ref = data.ref ?? 0;
    const subject = data.subject ?? "";
    const assignee = data.assigned_to ?? null;
    const assigneeName = assignee?.full_name_display ?? assignee?.full_name ?? "";
    const projectSlug = extractProjectSlug(data.project?.permalink) ?? provider.project;

    const assigneeEmail = assignee?.id
      ? await this.resolveMemberEmail(provider, data.project?.id, assignee.id)
      : "";

    // Tasks carry their parent user story (with its sprint) inline; other entities have none.
    const parent = data.user_story ?? null;

    return buildTaigaTriggerOutputs({
      action: facts.action,
      entity: facts.entity,
      issueId: String(data.id),
      issueUrl: buildItemUrl(provider, projectSlug, ref, facts.entity) || data.permalink || "",
      seq: ref,
      identifier: `#${ref}`,
      name: subject,
      description: data.description ?? "",
      project: data.project?.name ?? provider.project,
      status: statusLabel(provider.feedback?.statusLabels, facts.status || null),
      statusFrom: statusLabel(provider.feedback?.statusLabels, facts.statusFrom || null),
      type: facts.type,
      priority: statusLabel(provider.priorityLabels, facts.priority || null),
      labels: facts.tags,
      assignee: assigneeName,
      assigneeEmail,
      assigneeUsername: assignee?.username ?? "",
      assigneeInitials: initials(assigneeName, assigneeEmail),
      slug: slugify(subject),
      author: payload.by?.full_name_display ?? payload.by?.full_name ?? payload.by?.username ?? "",
      changedFields: facts.changedFields,
      sprint: facts.sprint,
      parentId: parent?.id != null ? String(parent.id) : "",
      parentSeq: parent?.ref ?? null,
      parentIdentifier: parent?.ref != null ? `#${parent.ref}` : "",
      parentName: parent?.subject ?? "",
      parentUrl:
        parent?.permalink ??
        (parent?.ref != null ? buildItemUrl(provider, projectSlug, parent.ref, "user_story") : ""),
      receivedAt: formatReceivedAt(new Date()),
    });
  }

  /** Taiga user id -> member email via the project's memberships (cached per project). */
  private async resolveMemberEmail(
    provider: TaigaProvider,
    projectIdFromPayload: number | undefined,
    userId: number,
  ): Promise<string> {
    const ref = `taiga:${provider.alias}`;
    const client = this.taigaClients.get(ref);
    if (!client) {
      log.warn(`Taiga trigger: no API client for "${ref}" — assignee email unavailable`);
      return "";
    }

    try {
      const projectId = projectIdFromPayload ?? (await client.getProjectBySlug(provider.project)).id;
      const cacheKey = `${projectId}:${userId}`;
      const cached = this.emailCache.get(cacheKey);
      if (cached) return cached;

      const email = await client.getMemberEmailById(projectId, userId);
      if (!email) {
        log.warn("Taiga trigger: no membership email for assignee", { projectId, userId });
        return "";
      }
      this.emailCache.set(cacheKey, email);
      return email;
    } catch (e) {
      log.error("Taiga trigger: failed to resolve assignee email", { userId, error: String(e) });
      return "";
    }
  }
}
