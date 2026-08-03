import { getByPath, renderConditionals } from "./content-mapper";

export const DEFAULT_TEMPLATE = `[{{project}}] #{{seq}} «{{title}}» → {{state}} ({{priority}})`;
export const DEFAULT_INTAKE_TEMPLATE = `[{{project}}] Новая заявка: {{name}}`;

export function renderMessage(template: string, source: Record<string, unknown>): string {
  const resolved = renderConditionals(template, source);

  return resolved.replace(/\{\{([\w.]+)\}\}/g, (_, path) => {
    const v = getByPath(source, path);
    return v == null ? "" : String(v);
  });
}
