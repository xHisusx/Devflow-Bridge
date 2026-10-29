import type { Rule } from "../modules/messenger/domain/entities/notification";
import { isNotifyContent } from "../modules/messenger/domain/entities/notification";
import { renderMessage } from "../modules/plane/domain/services/template-renderer";

/**
 * Key under which a step declared `once` is remembered, or null when the step has no guard (or
 * when nothing identifies the event, in which case guarding would silence the step forever).
 *
 * `once: true` keys on the step plus the item it is about and, for a DM, the recipient — so the
 * same task assigned to the same person twice notifies once, while a hand-off to someone else
 * still reaches them. `once: "<template>"` keys on the rendered template instead.
 */
export function onceKey(step: Rule, source: Record<string, unknown>): string | null {
  const { once } = step.on;
  if (!once) return null;

  const prefix = `${step.from}->${step.to}`;
  if (typeof once === "string") {
    const rendered = renderMessage(once, source).trim();
    return rendered ? `${prefix}:${rendered}` : null;
  }

  const correlation = String(source.issueId ?? source.taskId ?? "");
  const content = step.on.content;
  const recipient = isNotifyContent(content) && content.recipient
    ? renderMessage(content.recipient, source).trim()
    : "";

  if (!correlation && !recipient) return null;
  return `${prefix}:${correlation}:${recipient}`;
}

/**
 * Filter a step's produced outputs by its `outputs` declaration before exposing them
 * to subsequent pipeline steps. If `allowed` is undefined, the full output set is exposed.
 * Shared by every pipeline engine so the runtime context matches what `validateConfig` checks.
 */
export function filterOutputs(
  outputs: Record<string, unknown>,
  allowed?: string[],
): Record<string, unknown> {
  if (!allowed) return outputs;
  const filtered: Record<string, unknown> = {};
  for (const key of allowed) {
    if (key in outputs) filtered[key] = outputs[key];
  }
  return filtered;
}
