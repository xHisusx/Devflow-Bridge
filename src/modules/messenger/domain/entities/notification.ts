import type { StateGroup } from "../../../plane/domain/entities";
import type { BitrixContent, TaigaFeedbackButton } from "../../../../core/config";

// Content для to: "plane" — маппинг полей из request body
export interface PlaneContent {
  [field: string]: string | string[] | number;
}

// Content для to: "pachka:*" / "webhook:*" — шаблон уведомления
export interface NotifyContent {
  message: string;
  actions?: RuleAction[];
  /**
   * DM mode only (`pachka` provider with `dm: true`): recipient of the personal message —
   * a work email or a numeric Pachka user id. Templated like any other content value.
   */
  recipient?: string;
  /**
   * Taiga status name -> the callback buttons *this* card carries once the item reaches that
   * status, overriding the provider-wide `feedback.buttons` for this step alone (a status with
   * no entry here leaves the card without action buttons).
   *
   * One item is shown in several places at once — a DM to the developer, the team channel, the
   * testing channel — and a transition means something different in each: the tester may return
   * the task or finish it, while the developer has nothing to press until it comes back. A step
   * already owns the text of the card it sends, so it owns its buttons too.
   */
  buttonsByStatus?: Record<string, TaigaFeedbackButton[]>;
}

// ── Content для to: "gitlab:*" — декларативные операции в репозитории ──

export interface GitLabMrContent {
  title?: string;
  description?: string;
  /** Target branch; defaults to the provider's `mr.target` / `defaultBranch`. */
  target?: string;
  draft?: boolean;
  labels?: string[];
  removeSourceBranch?: boolean;
  squash?: boolean;
  /** Email of the person the MR is assigned to; resolved to a GitLab user. */
  assigneeEmail?: string;
  reviewerEmails?: string | string[];
}

export interface GitLabIssueContent {
  title: string;
  description?: string;
  labels?: string[];
  assigneeEmail?: string;
}

/**
 * Each declared key is one operation, executed in this order: `branch` (create if missing),
 * `mr` (create or reuse the open MR for that branch), `issue`, `comment` (note on the MR).
 */
export interface GitLabContent {
  /** Repository override ("group/repo"); defaults to the tag map, then the provider's `project`. */
  repo?: string;
  /** Tags consulted against the provider's `repoByTag` map. */
  tags?: string | string[];
  /** Branch name (template). Defaults to the provider's `branch.pattern`. */
  branch?: string;
  /** Branch type for `{{branchType}}`, overriding the provider's `branch.typeByTag` lookup. */
  branchType?: string;
  /** Base ref of the new branch. Defaults to the provider's `defaultBranch`. */
  ref?: string;
  /** Work email of the assignee — source of the MR assignee and of `{{initials}}`. */
  assigneeEmail?: string;
  /** Full name of the assignee — fallback source of `{{initials}}`. */
  assigneeName?: string;
  mr?: GitLabMrContent;
  issue?: GitLabIssueContent;
  comment?: string;
  [key: string]: unknown;
}

export function isNotifyContent(content: unknown): content is NotifyContent {
  return typeof content === "object" && content !== null && "message" in content;
}

export interface ButtonDef {
  text: string;
  url?: string;
  callbackData?: string;
  /** Alias of a `form` provider; renders a data-button that opens the form. Excludes url/callbackData. */
  form?: string;
}

export type RuleAction =
  | { type: "reaction"; emoji: string }
  | { type: "editPrevious"; message?: string }
  | { type: "threadReply"; message: string }
  | { type: "buttons"; buttons: ButtonDef[] }
  | { type: "pin" };

export interface RuleOn {
  // ── Match conditions (trigger step only) ──
  // Evaluated by rule-matcher (Plane webhook events) or taiga-trigger (Taiga webhook events) on the
  // pipeline's first step. Ignored for api:intake / form-sourced pipelines and for non-first steps.
  /**
   * Plane: create|update|delete. Taiga: create|change|delete.
   * GitLab: open|close|reopen|update|approved|merge (push events read as "push").
   * A list is an OR, as everywhere else.
   */
  action?: string | string[];
  /** Plane: issue|work_item|task|... Taiga: issue|user_story|task. */
  entity?: string | string[];
  state?: string | string[];
  stateGroup?: StateGroup | StateGroup[];
  priority?: string | string[];

  // ── Taiga trigger conditions ──
  /** Status name(s) the item must have after the event ("New", "In progress"). */
  status?: string | string[];
  /** Issue type name(s) ("Ошибка", "Вопрос"). Issues only. */
  type?: string | string[];
  /** Field name(s) that must appear in the event's change diff ("assigned_to", "status"). */
  changed?: string | string[];
  /**
   * Tag name(s) the item must carry; matches when any of them is set (case-insensitive). Use it
   * to keep a pipeline to the tasks it is meant for — e.g. only those tagged with a repository.
   */
  tags?: string | string[];
  /**
   * Sprint (milestone) filter: "any" — the item (for a task: its user story) is in some sprint,
   * "none" — it is in none, or the sprint name(s) it must be in.
   */
  sprint?: string | string[];
  /**
   * Roll-up filter: every task of the user story this event belongs to (for a task event — its
   * parent story; for a story event — the story itself) is in one of the named statuses, and the
   * story has at least one task. Costs an API call, so it is checked last.
   *
   * This is how "the work is finished" is told from "a piece of the work is finished": a story is
   * delivered task by task, and only the last of them makes the story itself ready.
   */
  allTasks?: string | string[];
  /**
   * Status of the parent user story of a task event (empty for any other entity, so a rule naming
   * it never fires on a story or an issue). It comes with the payload — Taiga serializes a task's
   * story in full — so unlike `allTasks` it costs nothing.
   *
   * This is what makes the roll-up reversible: a task going back into work concerns the story only
   * while the story is already handed over for testing, and must not rewrite its status otherwise.
   */
  parentStatus?: string | string[];
  /**
   * Assignment filter:
   * - "first" — the item just got its first assignee (created with one, or changed from empty)
   * - "any" — an assignee is set
   * - "none" — no assignee
   */
  assigned?: "first" | "any" | "none";

  // ── GitLab trigger conditions ──
  /** Webhook event kind: merge_request | push | tag_push | issue | note | pipeline. */
  event?: string | string[];
  /** Target branch of the merge request ("master"). */
  target?: string | string[];
  /** Source branch of the merge request, or the branch that was pushed to. */
  branch?: string | string[];
  /** Label name(s) on the merge request; matches when any of them is set. */
  labels?: string | string[];
  /** Draft state of the merge request. */
  draft?: boolean;

  // ── Step payload (all sources) ──
  content: PlaneContent | NotifyContent | GitLabContent | BitrixContent;
  outputs?: string[]; // fields this step exposes to subsequent steps (defaults to the provider schema)
  /**
   * Run this step at most once per key, remembered across restarts. `true` derives the key from
   * the step and the item it is about (plus the recipient for a DM); a string is a template for
   * the key. Repository writes are idempotent on their own — this is what keeps a person from
   * being notified again when the same task is assigned to them a second time.
   */
  once?: boolean | string;
}

export interface Rule {
  from: string; // "type:alias" (e.g. "plane:dev", "api:intake")
  to: string; // "type:alias" (e.g. "pachka:releases", "plane:dev")
  on: RuleOn;
}

export function parseRef(ref: string): { type: string; alias: string } {
  const [type, alias = ""] = ref.split(":");
  return { type, alias };
}
