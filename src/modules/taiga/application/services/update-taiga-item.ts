import type { TaigaEntity, TaigaProvider } from "../../../../core/config";
import type { ITaigaApiClient } from "../ports/taiga-api.port";
import type { MappedContent } from "../../../plane/domain/services/content-mapper";
import { statusLabel, buildItemUrl } from "../../domain/services/feedback-buttons";
import { TaigaWriteError } from "./create-taiga-issue";
import type { TaigaCreateResult } from "./create-taiga-issue";
import { log } from "../../../../core/logger";

/**
 * Update an existing Taiga item (`to: taiga:*` with `content.item`) instead of creating one:
 * write custom fields (by field name), move the status, assign by email, post a comment.
 * Outputs mirror the create path's schema so downstream steps see the same fields.
 *
 * Supported content keys: `item` (id, required), `customFields` (name -> value), `status`
 * (status name), `assigneeEmail`, `comment`.
 */
export async function updateTaigaItemFromContent(
  client: ITaigaApiClient,
  provider: TaigaProvider,
  mapped: MappedContent,
): Promise<TaigaCreateResult> {
  const entity: TaigaEntity = provider.entity ?? "issue";

  const itemId = Number(mapped.item);
  if (!Number.isFinite(itemId) || itemId <= 0) {
    throw new TaigaWriteError(`item id is required for a taiga update step (got "${mapped.item}")`);
  }

  const project = await client.getProjectBySlug(provider.project);
  const item = await client.getItem(entity, itemId);

  // ── Status / assignee / comment in one patch (Taiga bumps the version on each write) ──
  const requestedStatus = str(mapped.status);
  let statusId: number | undefined;
  let statusName: string | null = item.statusName;
  if (requestedStatus) {
    const statuses = await client.getItemStatuses(entity, project.id);
    const match = statuses.find((s) => s.name.toLowerCase() === requestedStatus.toLowerCase());
    if (!match) {
      throw new TaigaWriteError(
        `Status "${requestedStatus}" not found. Available: ${statuses.map((s) => s.name).join(", ")}`,
      );
    }
    statusId = match.id;
    statusName = match.name;
  }

  const assigneeEmail = str(mapped.assigneeEmail);
  let assignedTo: number | null = null;
  if (assigneeEmail) {
    assignedTo = await client.getMemberIdByEmail(project.id, assigneeEmail);
    if (!assignedTo) log.warn("Taiga update: no project member with that email", { assigneeEmail });
  }

  const comment = str(mapped.comment);
  if (statusId != null || assignedTo != null || comment) {
    await client.updateItem(
      entity,
      itemId,
      {
        ...(statusId != null ? { status: statusId } : {}),
        ...(assignedTo != null ? { assigned_to: assignedTo } : {}),
        ...(comment ? { comment } : {}),
      },
      item.version,
    );
    log.info("Taiga item updated", { entity, itemId, status: statusName, assignedTo, comment: Boolean(comment) });
  }

  // ── Custom fields by name (e.g. { "MR": "https://git/.../merge_requests/7" }) ──
  const customFields = asRecord(mapped.customFields);
  if (customFields) {
    await writeCustomFields(client, entity, project.id, itemId, customFields);
  }

  // Re-read so outputs carry the item's state after every write.
  const fresh = await client.getItem(entity, itemId);
  let freshStatusName = fresh.statusName ?? statusName;
  if (!freshStatusName) {
    try {
      const statuses = await client.getItemStatuses(entity, project.id);
      freshStatusName = statuses.find((s) => s.id === fresh.status)?.name ?? null;
    } catch (e) {
      log.warn("Failed to resolve Taiga status name", { error: String(e) });
    }
  }
  let typeName: string | null = null;
  if (entity === "issue" && fresh.typeId != null) {
    try {
      const types = await client.getIssueTypes(project.id);
      typeName = types.find((t) => t.id === fresh.typeId)?.name ?? null;
    } catch (e) {
      log.warn("Failed to resolve Taiga issue type", { error: String(e) });
    }
  }
  let priorityName: string | null = null;
  if (entity === "issue" && fresh.priorityId != null) {
    try {
      const priorities = await client.getPriorities(project.id);
      priorityName = priorities.find((p) => p.id === fresh.priorityId)?.name ?? null;
    } catch (e) {
      log.warn("Failed to resolve Taiga priority", { error: String(e) });
    }
  }

  return {
    result: { id: String(fresh.id), issue_id: String(fresh.id), sequence_id: fresh.ref },
    outputs: {
      issueId: String(fresh.id),
      issueUrl: buildItemUrl(provider, project.slug, fresh.ref),
      seq: fresh.ref,
      identifier: `#${fresh.ref}`,
      name: fresh.subject,
      title: fresh.subject,
      description: fresh.description,
      labels: fresh.tags,
      project: project.name,
      action: "update",
      status: statusLabel(provider.feedback?.statusLabels, freshStatusName),
      assignee: fresh.assigneeName ?? "—",
      type: typeName ?? "—",
      priority: statusLabel(provider.priorityLabels, priorityName) || "—",
    },
  };
}

/**
 * Resolve custom field names to ids and patch them, keeping the values the item already has.
 *
 * A field the project does not define is skipped with a warning naming the fields it does define,
 * not an error: the write-back is an extra, and failing it would also cost the notification steps
 * that follow in the pipeline. A project that simply has no such fields needs no setup.
 *
 * A field whose value resolved to nothing is left as it is: these writes fill fields
 * automatically, so a merge request that does not exist yet must not erase the one recorded
 * before it.
 */
async function writeCustomFields(
  client: ITaigaApiClient,
  entity: TaigaEntity,
  projectId: number,
  itemId: number,
  fields: Record<string, unknown>,
): Promise<void> {
  const definitions = await client.getCustomAttributes(entity, projectId);
  const current = await client.getCustomAttributeValues(entity, itemId);
  const values: Record<string, unknown> = { ...current.values };
  const written: string[] = [];

  for (const [name, value] of Object.entries(fields)) {
    const definition = definitions.find((d) => d.name.toLowerCase() === name.toLowerCase());
    if (!definition) {
      log.warn(
        `Taiga custom field "${name}" is not defined in the project — skipped. ` +
          `Defined: ${definitions.map((d) => d.name).join(", ") || "(none)"}`,
        { entity, itemId },
      );
      continue;
    }
    if (value == null || value === "") {
      log.debug(`Taiga custom field "${definition.name}" has no value — left unchanged`, {
        entity,
        itemId,
      });
      continue;
    }
    values[String(definition.id)] = String(value);
    written.push(definition.name);
  }

  if (written.length === 0) return;

  await client.setCustomAttributeValues(entity, itemId, values, current.version);
  log.info("Taiga custom fields written", { entity, itemId, fields: written });
}

function str(value: unknown): string {
  return value == null ? "" : String(value);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
