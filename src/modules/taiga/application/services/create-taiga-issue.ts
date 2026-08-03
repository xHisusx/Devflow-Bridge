import type { TaigaProvider, TaigaEntity } from "../../../../core/config";
import type { ITaigaApiClient } from "../ports/taiga-api.port";
import type { MappedContent } from "../../../plane/domain/services/content-mapper";
import { statusLabel, buildItemUrl } from "../../domain/services/feedback-buttons";
import { log } from "../../../../core/logger";

/** Raised when a Taiga write (project resolution / create) cannot be completed. */
export class TaigaWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaigaWriteError";
  }
}

export interface TaigaCreateResult {
  result: { id: string; issue_id: string; sequence_id: number };
  /** Step outputs exposed to subsequent pipeline steps — must match TAIGA_STEP_OUTPUTS. */
  outputs: Record<string, unknown>;
}

/**
 * Create a Taiga item (issue / user story / task) from mapped content and assemble the canonical
 * `taiga` step outputs. Entity kind comes from the provider (`entity`, default "issue").
 */
export async function createTaigaIssueFromContent(
  client: ITaigaApiClient,
  provider: TaigaProvider,
  mapped: MappedContent,
): Promise<TaigaCreateResult> {
  const entity: TaigaEntity = provider.entity ?? "issue";

  const name = typeof mapped.name === "string" ? mapped.name : undefined;
  if (!name) throw new TaigaWriteError("name is required (resolved to empty)");
  const description = typeof mapped.description === "string" ? mapped.description : undefined;
  const labels = Array.isArray(mapped.labels) ? mapped.labels.map(String) : undefined;
  const requestedType =
    typeof mapped.type === "string" && mapped.type.trim() ? mapped.type.trim() : undefined;
  const requestedPriority =
    typeof mapped.priority === "string" && mapped.priority.trim() ? mapped.priority.trim() : undefined;

  let project;
  try {
    project = await client.getProjectBySlug(provider.project);
  } catch (e) {
    throw new TaigaWriteError(`Project "${provider.project}" not found: ${String(e)}`);
  }

  // Resolve the requested issue type name -> id (issues only).
  let typeId: number | undefined;
  let typeName: string | null = null;
  if (entity === "issue" && requestedType) {
    const types = await client.getIssueTypes(project.id);
    const match = types.find((t) => t.name.toLowerCase() === requestedType.toLowerCase());
    if (!match) {
      throw new TaigaWriteError(
        `Issue type "${requestedType}" not found. Available: ${types.map((t) => t.name).join(", ")}`,
      );
    }
    typeId = match.id;
    typeName = match.name;
  }

  // Resolve the requested priority name -> id (issues only).
  let priorityId: number | undefined;
  let priorityName: string | null = null;
  if (entity === "issue" && requestedPriority) {
    const priorities = await client.getPriorities(project.id);
    const match = priorities.find((p) => p.name.toLowerCase() === requestedPriority.toLowerCase());
    if (!match) {
      throw new TaigaWriteError(
        `Priority "${requestedPriority}" not found. Available: ${priorities.map((p) => p.name).join(", ")}`,
      );
    }
    priorityId = match.id;
    priorityName = match.name;
  }

  const item = await client.createItem(entity, {
    project: project.id,
    subject: name,
    ...(description ? { description } : {}),
    ...(labels && labels.length > 0 ? { tags: labels } : {}),
    ...(typeId != null ? { typeId } : {}),
    ...(priorityId != null ? { priorityId } : {}),
  });
  log.info("Taiga item created", { entity, id: item.id, ref: item.ref, project: project.slug });

  // Resolve display fields for message templates: status label and issue type name.
  let statusName = item.statusName;
  if (!statusName && item.status != null) {
    try {
      const statuses = await client.getItemStatuses(entity, project.id);
      statusName = statuses.find((s) => s.id === item.status)?.name ?? null;
    } catch (e) {
      log.warn("Failed to resolve Taiga status name", { error: String(e) });
    }
  }
  if (!typeName && entity === "issue" && item.typeId != null) {
    try {
      const types = await client.getIssueTypes(project.id);
      typeName = types.find((t) => t.id === item.typeId)?.name ?? null;
    } catch (e) {
      log.warn("Failed to resolve Taiga issue type", { error: String(e) });
    }
  }
  if (!priorityName && entity === "issue" && item.priorityId != null) {
    try {
      const priorities = await client.getPriorities(project.id);
      priorityName = priorities.find((p) => p.id === item.priorityId)?.name ?? null;
    } catch (e) {
      log.warn("Failed to resolve Taiga priority", { error: String(e) });
    }
  }

  const outputs: Record<string, unknown> = {
    issueId: String(item.id),
    issueUrl: buildItemUrl(provider, project.slug, item.ref),
    seq: item.ref,
    identifier: `#${item.ref}`,
    name,
    title: name,
    description: description ?? "",
    labels: labels ?? [],
    project: project.name,
    action: "create",
    status: statusLabel(provider.feedback?.statusLabels, statusName),
    assignee: "—",
    type: typeName ?? "—",
    priority: statusLabel(provider.priorityLabels, priorityName) || "—",
  };

  return {
    result: { id: String(item.id), issue_id: String(item.id), sequence_id: item.ref },
    outputs,
  };
}
