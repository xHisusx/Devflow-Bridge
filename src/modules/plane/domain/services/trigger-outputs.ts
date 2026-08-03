/**
 * Assemble the canonical `plane` *trigger* outputs (the fields a webhook pipeline's first step
 * exposes to its templates). Keeping the key set in one place lets a drift-guard test assert it
 * matches PLANE_TRIGGER_OUTPUTS in provider-schema.ts.
 */
export interface PlaneTriggerFields {
  project: string;
  seq: string | number;
  title: string;
  state: string;
  stateGroup: string;
  priority: string;
  action: string;
  entity: string;
  issueId: string;
  issueUrl: string;
  identifier: string;
  assignee: string;
}

export function buildPlaneTriggerOutputs(f: PlaneTriggerFields): Record<string, unknown> {
  return {
    project: f.project,
    seq: f.seq,
    title: f.title,
    state: f.state,
    stateGroup: f.stateGroup,
    priority: f.priority,
    action: f.action,
    entity: f.entity,
    issueId: f.issueId,
    issueUrl: f.issueUrl,
    identifier: f.identifier,
    assignee: f.assignee,
  };
}
