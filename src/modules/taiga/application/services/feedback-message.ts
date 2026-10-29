import type { Config, TaigaProvider } from "../../../../core/config";
import type { IPipelineStateStore } from "../../../../core/persistence/pipeline-state.port";
import { isNotifyContent, type NotifyContent } from "../../../messenger/domain/entities/notification";
import type { ITaigaApiClient, TaigaProjectInfo } from "../ports/taiga-api.port";
import { statusLabel, buildItemUrl } from "../../domain/services/feedback-buttons";
import { log } from "../../../../core/logger";

/**
 * Find the notify content of the pipeline rule taiga:<alias> -> pachka:<target>: the message
 * template and the per-status buttons of that card. Reused to re-render the tracked message when
 * the item's status/assignee changes, so a card's format and its actions live in one place —
 * the rule that sent it.
 *
 * The card is not always sent by a Taiga step: in the "task assigned -> branch + draft MR -> DM"
 * flow the message comes from a `from: gitlab:*` step of a pipeline that a Taiga event triggered.
 * So when no rule notifies that target directly, the pipelines this provider triggers are searched
 * for the step that does — a card is re-rendered by the template that produced it either way.
 */
export function findNotifyContent(
  config: Config,
  taigaRef: string,
  pachkaAlias: string,
): NotifyContent | null {
  const target = `pachka:${pachkaAlias}`;

  for (const pipeline of config.rules) {
    for (const rule of pipeline) {
      if (rule.from !== taigaRef || rule.to !== target) continue;
      if (isNotifyContent(rule.on.content) && rule.on.content.message) return rule.on.content;
    }
  }

  for (const pipeline of config.rules) {
    if (pipeline[0]?.from !== taigaRef) continue;
    for (const rule of pipeline) {
      if (rule.to !== target) continue;
      if (isNotifyContent(rule.on.content) && rule.on.content.message) return rule.on.content;
    }
  }

  return null;
}

/**
 * Complete the vars of a card with what the tracker event itself does not carry.
 *
 * A card sent by a `to: gitlab:*` step names the item as `task*` and shows the branch and the
 * merge request opened for it. Re-rendering that card after a status change has to resolve the
 * same placeholders, so the item's own fields are aliased to their `task*` names and the
 * repository work is recalled from the task link.
 */
export function withCardVars(
  vars: Record<string, unknown>,
  state: IPipelineStateStore | null,
  tracker: string,
): Record<string, unknown> {
  const taskId = String(vars.issueId ?? "");
  const link = taskId ? state?.findLinkByTask(tracker, taskId) ?? null : null;

  return {
    ...vars,
    taskId: vars.issueId,
    taskName: vars.name,
    taskUrl: vars.issueUrl,
    taskIdentifier: vars.identifier,
    taskProject: vars.project,
    taskStatus: vars.status,
    ...(link
      ? { repo: link.repo, branch: link.branch, mrIid: link.mrIid, mrUrl: link.mrUrl }
      : {}),
  };
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
