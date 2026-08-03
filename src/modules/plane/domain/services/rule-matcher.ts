import type { RuleOn } from "../../../messenger/domain/entities/notification";
import type { PlaneStateInline } from "../entities/issue";
import type { PlaneWebhookPayload } from "../entities/webhook-payload";

export function asArray<T>(val: T | T[] | undefined): T[] {
  if (val === undefined) return [];
  return Array.isArray(val) ? val : [val];
}

export function matchesCondition(
  cond: RuleOn,
  entity: string,
  action: string,
  state: PlaneStateInline | null,
  priority: string,
  activity?: PlaneWebhookPayload["activity"],
): boolean {
  const entities = asArray(cond.entity);
  if (entities.length > 0 && !entities.includes(entity as any)) return false;

  // Normalize: webhook sends "created"/"updated"/"deleted", rules use "create"/"update"/"delete"
  if (cond.action && action.replace(/d$/, "") !== cond.action) return false;

  const states = asArray(cond.state);
  const groups = asArray(cond.stateGroup);
  const hasStateFilter = states.length > 0 || groups.length > 0;

  // For "updated" events with state/stateGroup filter, only match if state actually changed
  if (hasStateFilter && action === "updated" && activity?.field !== "state" && activity?.field !== "state_id") return false;

  if (states.length > 0 && (!state || !states.includes(state.name))) return false;
  if (groups.length > 0 && (!state || !groups.includes(state.group))) return false;

  const priorities = asArray(cond.priority);
  if (priorities.length > 0 && !priorities.includes(priority)) return false;

  return true;
}
