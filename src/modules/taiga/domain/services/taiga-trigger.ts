import type { TaigaEntity } from "../../../../core/config";
import type { RuleOn } from "../../../messenger/domain/entities/notification";
import type { TaigaWebhookPayload } from "../entities/taiga-webhook-payload";
import { asArray } from "../../../plane/domain/services/rule-matcher";

/**
 * Event facts a `from: taiga:*` trigger is matched against. Derived from the webhook payload so
 * the matching itself stays a pure function of plain values.
 */
export interface TaigaTriggerFacts {
  /** Normalized to "create" | "change" | "delete". */
  action: string;
  entity: TaigaEntity;
  status: string;
  statusFrom: string;
  type: string;
  priority: string;
  /** Field names present in the event's change diff ("status", "assigned_to", "subject"). */
  changedFields: string[];
  /** Tags on the item, as written in Taiga ("прокси", "баг"). */
  tags: string[];
  /**
   * Sprint (milestone) name, taken from the item or — for a task — from its parent user story.
   * Empty when the item is in no sprint.
   */
  sprint: string;
  hasSprint: boolean;
  hasAssignee: boolean;
  /**
   * The item just got its first assignee: created with one, or changed from an empty assignee.
   * A reassignment (A -> B) is not a first assignment.
   */
  firstAssignment: boolean;
}

/** Taiga's payload type ("userstory") -> the provider's entity naming ("user_story"). */
export function normalizeTaigaEntity(type: string | undefined): TaigaEntity {
  const value = (type ?? "").toLowerCase().replace(/[^a-z]/g, "");
  if (value === "userstory" || value === "us") return "user_story";
  if (value === "task") return "task";
  return "issue";
}

/**
 * `update` is what Plane-style rules call Taiga's `change`, so it reads as a synonym. Taiga's
 * `close` stays a value of its own: it is a separate event (and arrives without a `change.diff`),
 * so a rule asks for it explicitly with `action: "close"`.
 */
export function normalizeTaigaAction(action: string): string {
  return action === "update" ? "change" : action;
}

export function extractTaigaFacts(payload: TaigaWebhookPayload): TaigaTriggerFacts {
  const data = payload.data ?? {};
  const diff = payload.change?.diff ?? {};
  const action = normalizeTaigaAction(payload.action);
  const assigneeDiff = diffOf(diff.assigned_to);
  const hasAssignee = Boolean(data.assigned_to);

  // A task inherits its sprint from the user story it belongs to, and Taiga serializes that
  // story in full inside the task payload — so no extra API call is needed either way.
  const sprint = milestoneName(data.milestone) || milestoneName(data.user_story?.milestone);

  return {
    action,
    entity: normalizeTaigaEntity(payload.type),
    status: data.status?.name ?? "",
    statusFrom: diffOf(diff.status).from,
    type: data.type?.name ?? "",
    priority: data.priority?.name ?? "",
    changedFields: Object.keys(diff),
    tags: normalizeTags(data.tags),
    sprint,
    hasSprint: Boolean(sprint),
    hasAssignee,
    firstAssignment:
      (action === "create" && hasAssignee) ||
      (action === "change" && "assigned_to" in diff && !assigneeDiff.from && Boolean(assigneeDiff.to)),
  };
}

/**
 * Trigger conditions of a Taiga-sourced pipeline. Conditions combine with AND; arrays of values
 * are OR (same as Plane rules). `changed` matches when *any* of the named fields is in the diff.
 */
export function matchesTaigaCondition(on: RuleOn, facts: TaigaTriggerFacts): boolean {
  // "update" is accepted as a synonym of Taiga's "change" (see normalizeTaigaAction).
  const actions = asArray(on.action).map((a) => normalizeTaigaAction(String(a)));
  if (actions.length > 0 && !actions.includes(facts.action)) return false;

  const entities = asArray(on.entity).map((e) => normalizeTaigaEntity(String(e)));
  if (entities.length > 0 && !entities.includes(facts.entity)) return false;

  if (!matchesName(on.status, facts.status)) return false;
  if (!matchesName(on.type, facts.type)) return false;
  if (!matchesName(on.priority, facts.priority)) return false;

  const changed = asArray(on.changed).map(String);
  if (changed.length > 0 && !changed.some((f) => facts.changedFields.includes(f))) return false;

  // Tags gate which items the pipeline is about at all (e.g. only tasks tagged with a repository),
  // so an item carrying none of the listed tags is simply not this pipeline's business.
  const tags = asArray(on.tags).map((t) => String(t).toLowerCase());
  if (tags.length > 0) {
    const have = facts.tags.map((t) => t.toLowerCase());
    if (!tags.some((t) => have.includes(t))) return false;
  }

  // "any"/"none" ask about membership of any sprint; a name (or list) must match the sprint.
  if (on.sprint === "any" && !facts.hasSprint) return false;
  if (on.sprint === "none" && facts.hasSprint) return false;
  if (on.sprint && on.sprint !== "any" && on.sprint !== "none" && !matchesName(on.sprint, facts.sprint)) {
    return false;
  }

  if (on.assigned === "first" && !facts.firstAssignment) return false;
  if (on.assigned === "any" && !facts.hasAssignee) return false;
  if (on.assigned === "none" && facts.hasAssignee) return false;

  return true;
}

/**
 * Canonical `taiga` *trigger* outputs (the fields a Taiga webhook pipeline's first step exposes to
 * its templates). Keeping the key set in one place lets a drift-guard test assert it matches
 * TAIGA_TRIGGER_OUTPUTS in provider-schema.ts.
 */
export interface TaigaTriggerFields {
  action: string;
  entity: string;
  issueId: string;
  issueUrl: string;
  seq: number;
  identifier: string;
  name: string;
  description: string;
  project: string;
  status: string;
  statusFrom: string;
  type: string;
  priority: string;
  labels: string[];
  assignee: string;
  assigneeEmail: string;
  assigneeUsername: string;
  assigneeInitials: string;
  slug: string;
  author: string;
  changedFields: string[];
  sprint: string;
  /** Parent user story of a task (empty for other entities). */
  parentId: string;
  parentSeq: number | null;
  parentIdentifier: string;
  parentName: string;
  parentUrl: string;
  receivedAt: string;
}

export function buildTaigaTriggerOutputs(f: TaigaTriggerFields): Record<string, unknown> {
  return {
    action: f.action,
    entity: f.entity,
    issueId: f.issueId,
    issueUrl: f.issueUrl,
    seq: f.seq,
    identifier: f.identifier,
    name: f.name,
    title: f.name,
    description: f.description,
    project: f.project,
    status: f.status,
    statusFrom: f.statusFrom,
    type: f.type,
    priority: f.priority,
    labels: f.labels,
    assignee: f.assignee,
    assigneeEmail: f.assigneeEmail,
    assigneeUsername: f.assigneeUsername,
    assigneeInitials: f.assigneeInitials,
    slug: f.slug,
    author: f.author,
    changedFields: f.changedFields,
    sprint: f.sprint,
    parentId: f.parentId,
    parentSeq: f.parentSeq,
    parentIdentifier: f.parentIdentifier,
    parentName: f.parentName,
    parentUrl: f.parentUrl,
    receivedAt: f.receivedAt,
  };
}

/**
 * Tag names out of whatever Taiga serialized. Webhooks send a plain `["прокси"]`, while the REST
 * API answers `[["прокси", "#ff0000"]]` — both read as the names alone.
 */
export function normalizeTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((tag) => (Array.isArray(tag) ? String(tag[0] ?? "") : tag == null ? "" : String(tag)))
    .filter(Boolean);
}

/** Sprint name out of whatever Taiga serialized: a nested object, a bare id, or null. */
export function milestoneName(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "object") {
    const { name, slug, id } = value as { name?: unknown; slug?: unknown; id?: unknown };
    return String(name ?? slug ?? id ?? "");
  }
  return String(value);
}

/** "https://taiga.example.com/project/my-slug" -> "my-slug". */
export function extractProjectSlug(permalink?: string): string | null {
  if (!permalink) return null;
  const parts = permalink.replace(/\/$/, "").split("/");
  return parts[parts.length - 1] || null;
}

/** Case-insensitive OR match of a condition value (or list) against an event value. */
function matchesName(condition: string | string[] | undefined, value: string): boolean {
  const expected = asArray(condition).map((v) => String(v).toLowerCase());
  if (expected.length === 0) return true;
  return expected.includes(value.toLowerCase());
}

/** Taiga diff entries are `{ from, to }` with display values; missing ones read as empty. */
function diffOf(entry: unknown): { from: string; to: string } {
  if (!entry || typeof entry !== "object") return { from: "", to: "" };
  const { from, to } = entry as { from?: unknown; to?: unknown };
  return { from: from == null ? "" : String(from), to: to == null ? "" : String(to) };
}
