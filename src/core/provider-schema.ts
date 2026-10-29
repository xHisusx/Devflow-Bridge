/**
 * Declares the default output fields each provider type exposes to subsequent pipeline steps.
 * These are the fields a step with `from: <type>:*` can reference in its templates,
 * unless the upstream step narrows them via its own `outputs` list.
 *
 * `plane` plays two distinct roles, so it has two output sets:
 * - "trigger": when `plane` is the pipeline source (first step of a webhook pipeline). Must mirror
 *   the `vars` built in process-plane-webhook.ts.
 * - "step": when `plane` is the result of a `to: plane:*` step (intake). Must mirror the `outputs`
 *   composed in process-intake-pipeline.ts (executePlaneStep).
 */
const PLANE_TRIGGER_OUTPUTS: readonly string[] = [
  "project",
  "seq",
  "title",
  "state",
  "stateGroup",
  "priority",
  "action",
  "entity",
  "issueId",
  "issueUrl",
  "identifier",
  "assignee",
];

const PLANE_STEP_OUTPUTS: readonly string[] = [
  "issueId",
  "issueUrl",
  "seq",
  "identifier",
  "name",
  "title",
  "description",
  "labels",
  "workspace",
  "project",
  "action",
];

/** Result of a `to: taiga:*` step — must mirror the outputs composed in create-taiga-issue.ts. */
const TAIGA_STEP_OUTPUTS: readonly string[] = [
  "issueId",
  "issueUrl",
  "seq",
  "identifier",
  "name",
  "title",
  "description",
  "labels",
  "project",
  "action",
  "status",
  "assignee",
  "type",
  "priority",
];

/**
 * Trigger of a Taiga webhook pipeline (`from: taiga:*` as the first step) — must mirror the vars
 * built by buildTaigaTriggerOutputs in the taiga module. These are event fields (what changed,
 * who it is assigned to), as opposed to TAIGA_STEP_OUTPUTS which describes a written item.
 */
const TAIGA_TRIGGER_OUTPUTS: readonly string[] = [
  "action",
  "entity",
  "issueId",
  "issueUrl",
  "seq",
  "identifier",
  "name",
  "title",
  "description",
  "project",
  "status",
  "statusFrom",
  "type",
  "priority",
  "labels",
  "assignee",
  "assigneeEmail",
  "assigneeUsername",
  "assigneeInitials",
  "slug",
  "author",
  "changedFields",
  "sprint",
  "parentId",
  "parentSeq",
  "parentIdentifier",
  "parentName",
  "parentUrl",
  "receivedAt",
];

/**
 * Result of a `to: gitlab:*` step — must mirror the outputs composed in run-gitlab-step.ts.
 * `task*` fields echo the upstream item the branch/MR was made for, so later steps (a DM, a
 * write-back into the tracker) stay self-sufficient.
 */
const GITLAB_STEP_OUTPUTS: readonly string[] = [
  "branch",
  "branchUrl",
  "ref",
  "repo",
  "repoUrl",
  "mrIid",
  "mrUrl",
  "mrTitle",
  "mrTarget",
  "issueIid",
  "issueUrl",
  "assignee",
  "assigneeEmail",
  "assigneeInitials",
  "taskId",
  "taskName",
  "taskUrl",
  "taskIdentifier",
];

/**
 * Trigger of a GitLab webhook pipeline (`from: gitlab:*` as the first step) — must mirror the vars
 * built by buildGitLabTriggerOutputs in the gitlab module. These are repository event fields (what
 * happened to a merge request or a branch), as opposed to GITLAB_STEP_OUTPUTS which describes
 * repository work the bridge just did. `task*` is the tracker item recalled from the task link.
 */
const GITLAB_TRIGGER_OUTPUTS: readonly string[] = [
  "event",
  "action",
  "state",
  "repo",
  "repoUrl",
  "branch",
  "target",
  "mrIid",
  "mrUrl",
  "mrTitle",
  "draft",
  "merged",
  "labels",
  "author",
  "authorEmail",
  "commits",
  "lastCommit",
  "sha",
  "taskId",
  "taskName",
  "taskUrl",
  "taskIdentifier",
  "receivedAt",
];

/**
 * Extra template vars a `to: gitlab:*` step computes for its *own* content, on top of whatever
 * the upstream step exposes: the transliterated title, the assignee's initials, the resolved
 * repository, and `task*` (the source item, named so it survives the step's own issue fields).
 * Must mirror the `vars` built in run-gitlab-step.ts.
 */
export const GITLAB_COMPUTED_VARS: readonly string[] = [
  "slug",
  "branchType",
  "assignee",
  "assigneeEmail",
  "assigneeInitials",
  "repo",
  "repoUrl",
  "taskId",
  "taskName",
  "taskUrl",
  "taskIdentifier",
];

/**
 * Trigger of a form-submission pipeline (`from: form:*`) — must mirror the trigger composed in
 * process-form-submission.ts. `data` holds submitted fields keyed by block name.
 */
const FORM_TRIGGER_OUTPUTS: readonly string[] = [
  "data",
  "user",
  "userId",
  "chatId",
  "receivedAt",
  "meta",
];

export const PROVIDER_OUTPUTS: Record<string, readonly string[]> = {
  api: ["body", "files", "receivedAt"],
  plane: PLANE_STEP_OUTPUTS,
  taiga: TAIGA_STEP_OUTPUTS,
  gitlab: GITLAB_STEP_OUTPUTS,
  pachka: ["messageId", "chatId", "channel", "message"],
  webhook: ["channel", "message"],
};

export function getProviderOutputs(
  type: string,
  role: "trigger" | "step" = "step",
): readonly string[] {
  if (role === "trigger") {
    if (type === "plane") return PLANE_TRIGGER_OUTPUTS;
    if (type === "taiga") return TAIGA_TRIGGER_OUTPUTS;
    if (type === "gitlab") return GITLAB_TRIGGER_OUTPUTS;
    if (type === "form") return FORM_TRIGGER_OUTPUTS;
  }
  return PROVIDER_OUTPUTS[type] ?? [];
}
