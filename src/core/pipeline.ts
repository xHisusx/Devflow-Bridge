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
