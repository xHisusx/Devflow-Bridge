import type { RuleOn } from "../../../messenger/domain/entities/notification";
import type { GitLabWebhookPayload } from "../entities/gitlab-webhook-payload";
import { asArray } from "../../../plane/domain/services/rule-matcher";

/**
 * Event facts a `from: gitlab:*` trigger is matched against, derived from the webhook payload so
 * the matching stays a pure function of plain values.
 */
export interface GitLabTriggerFacts {
  /** merge_request | push | tag_push | issue | note | pipeline */
  event: string;
  /** Merge-request/issue action ("open", "merge", "close", "update"); "push" for push events. */
  action: string;
  /** Merge-request/issue state: opened | closed | merged | locked. */
  state: string;
  /** Repository path with namespace ("team/backend"). */
  repo: string;
  /** Source branch of the merge request, or the branch that was pushed to. */
  branch: string;
  /** Target branch of the merge request. */
  target: string;
  draft: boolean;
  merged: boolean;
  labels: string[];
}

/** "refs/heads/master" -> "master" (tags: "refs/tags/v1" -> "v1"). */
export function branchFromRef(ref: string | undefined): string {
  if (!ref) return "";
  return ref.replace(/^refs\/(heads|tags)\//, "");
}

export function extractGitLabFacts(payload: GitLabWebhookPayload): GitLabTriggerFacts {
  const event = payload.object_kind ?? payload.event_type ?? "";
  const attrs = payload.object_attributes ?? {};
  const state = str(attrs.state);

  return {
    event,
    action: event === "push" || event === "tag_push" ? "push" : str(attrs.action),
    state,
    repo: str(payload.project?.path_with_namespace),
    branch: event === "push" || event === "tag_push"
      ? branchFromRef(payload.ref)
      : str(attrs.source_branch),
    target: str(attrs.target_branch),
    draft: Boolean(attrs.draft ?? attrs.work_in_progress ?? false),
    merged: state === "merged" || str(attrs.action) === "merge",
    labels: (attrs.labels ?? payload.labels ?? [])
      .map((l) => str(l?.title))
      .filter(Boolean),
  };
}

/**
 * Trigger conditions of a GitLab-sourced pipeline. Conditions combine with AND, arrays of values
 * are OR (same as every other trigger). `labels` matches when *any* of the named labels is set.
 */
export function matchesGitLabCondition(on: RuleOn, facts: GitLabTriggerFacts): boolean {
  if (!matchesName(on.event, facts.event)) return false;
  if (!matchesName(on.action, facts.action)) return false;
  if (!matchesName(on.state, facts.state)) return false;
  if (!matchesName(on.target, facts.target)) return false;
  if (!matchesName(on.branch, facts.branch)) return false;

  if (on.draft != null && on.draft !== facts.draft) return false;

  const labels = asArray(on.labels).map((l) => String(l).toLowerCase());
  if (labels.length > 0) {
    const have = facts.labels.map((l) => l.toLowerCase());
    if (!labels.some((l) => have.includes(l))) return false;
  }

  return true;
}

/**
 * Canonical `gitlab` *trigger* outputs (what a GitLab webhook pipeline's first step exposes to its
 * templates). Keeping the key set here lets a drift-guard test assert it matches
 * GITLAB_TRIGGER_OUTPUTS in provider-schema.ts.
 *
 * `task*` is the tracker item the branch/MR was created for, recalled from the task link the
 * `to: gitlab:*` step recorded — GitLab events carry no tracker id of their own.
 */
export interface GitLabTriggerFields {
  event: string;
  action: string;
  state: string;
  repo: string;
  repoUrl: string;
  branch: string;
  target: string;
  mrIid: number | null;
  mrUrl: string;
  mrTitle: string;
  draft: boolean;
  merged: boolean;
  labels: string[];
  author: string;
  authorEmail: string;
  commits: number;
  lastCommit: string;
  sha: string;
  taskId: string;
  taskName: string;
  taskUrl: string;
  taskIdentifier: string;
  receivedAt: string;
}

export function buildGitLabTriggerOutputs(f: GitLabTriggerFields): Record<string, unknown> {
  return {
    event: f.event,
    action: f.action,
    state: f.state,
    repo: f.repo,
    repoUrl: f.repoUrl,
    branch: f.branch,
    target: f.target,
    mrIid: f.mrIid,
    mrUrl: f.mrUrl,
    mrTitle: f.mrTitle,
    draft: f.draft,
    merged: f.merged,
    labels: f.labels,
    author: f.author,
    authorEmail: f.authorEmail,
    commits: f.commits,
    lastCommit: f.lastCommit,
    sha: f.sha,
    taskId: f.taskId,
    taskName: f.taskName,
    taskUrl: f.taskUrl,
    taskIdentifier: f.taskIdentifier,
    receivedAt: f.receivedAt,
  };
}

/** Case-insensitive OR match of a condition value (or list) against an event value. */
function matchesName(condition: string | string[] | undefined, value: string): boolean {
  const expected = asArray(condition).map((v) => String(v).toLowerCase());
  if (expected.length === 0) return true;
  return expected.includes(value.toLowerCase());
}

function str(value: unknown): string {
  return value == null ? "" : String(value);
}
