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
  pachka: ["messageId", "chatId", "channel", "message"],
  webhook: ["channel", "message"],
};

export function getProviderOutputs(
  type: string,
  role: "trigger" | "step" = "step",
): readonly string[] {
  if (type === "plane" && role === "trigger") return PLANE_TRIGGER_OUTPUTS;
  if (type === "form" && role === "trigger") return FORM_TRIGGER_OUTPUTS;
  return PROVIDER_OUTPUTS[type] ?? [];
}
