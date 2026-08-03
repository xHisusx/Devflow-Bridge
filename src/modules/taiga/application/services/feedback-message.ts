import type { Config, TaigaProvider } from "../../../../core/config";
import { isNotifyContent } from "../../../messenger/domain/entities/notification";
import type { ITaigaApiClient, TaigaProjectInfo } from "../ports/taiga-api.port";
import { statusLabel, buildItemUrl } from "../../domain/services/feedback-buttons";
import { log } from "../../../../core/logger";

/**
 * Find the notify message template of the pipeline rule taiga:<alias> -> pachka:<target>.
 * Reused to re-render the tracked message when the item's status/assignee changes,
 * so the card format lives in one place (the rule's content.message).
 */
export function findNotifyTemplate(
  config: Config,
  taigaRef: string,
  pachkaAlias: string,
): string | null {
  for (const pipeline of config.rules) {
    for (const rule of pipeline) {
      if (rule.from !== taigaRef || rule.to !== `pachka:${pachkaAlias}`) continue;
      if (isNotifyContent(rule.on.content) && rule.on.content.message) return rule.on.content.message;
    }
  }
  return null;
}

/** Fetch the item's current state and build template vars (same names as taiga step outputs). */
export async function buildItemVars(
  client: ITaigaApiClient,
  provider: TaigaProvider,
  project: TaigaProjectInfo,
  itemId: number,
): Promise<Record<string, unknown>> {
  const entity = provider.entity ?? "issue";
  const item = await client.getItem(entity, itemId);

  let statusName = item.statusName;
  if (!statusName) {
    try {
      const statuses = await client.getItemStatuses(entity, project.id);
      statusName = statuses.find((s) => s.id === item.status)?.name ?? null;
    } catch (e) {
      log.warn("Failed to resolve Taiga status name", { error: String(e) });
    }
  }
  let typeName: string | null = null;
  if (entity === "issue" && item.typeId != null) {
    try {
      const types = await client.getIssueTypes(project.id);
      typeName = types.find((t) => t.id === item.typeId)?.name ?? null;
    } catch (e) {
      log.warn("Failed to resolve Taiga issue type", { error: String(e) });
    }
  }
  let priorityName: string | null = null;
  if (entity === "issue" && item.priorityId != null) {
    try {
      const priorities = await client.getPriorities(project.id);
      priorityName = priorities.find((p) => p.id === item.priorityId)?.name ?? null;
    } catch (e) {
      log.warn("Failed to resolve Taiga priority", { error: String(e) });
    }
  }

  return {
    issueId: String(item.id),
    issueUrl: buildItemUrl(provider, project.slug, item.ref),
    seq: item.ref,
    identifier: `#${item.ref}`,
    name: item.subject,
    title: item.subject,
    project: project.name,
    status: statusLabel(provider.feedback?.statusLabels, statusName),
    assignee: item.assigneeName ?? "—",
    type: typeName ?? "—",
    priority: statusLabel(provider.priorityLabels, priorityName) || "—",
  };
}
