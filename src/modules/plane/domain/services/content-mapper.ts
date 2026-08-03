import type { PlaneContent } from "../../../messenger/domain/entities/notification";

export interface MappedContent {
  name?: string;
  description?: string;
  labels?: string[];
  priority?: string;
  [key: string]: unknown;
}

export function getByPath(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/**
 * Conditional blocks:
 * - {{#path=value}}...{{/path}} — body kept only when the source value equals `value` (as strings)
 * - {{#path}}...{{/path}} — body kept only when the source value is present and non-empty
 */
export function renderConditionals(template: string, source: Record<string, unknown>): string {
  return template.replace(
    /\{\{#([\w.]+)(?:=([^}]*))?\}\}([\s\S]*?)\{\{\/\1\}\}/g,
    (match, path, value, body) => {
      const v = getByPath(source, path);
      if (value !== undefined) return String(v ?? "") === value ? body : "";
      return v != null && v !== "" ? body : "";
    },
  );
}

/**
 * Resolve a content value against a source of outputs.
 * - "{{path}}" — whole-value template, returns raw value (string, array, object)
 * - "text {{path}} text" — string interpolation; supports conditional blocks (renderConditionals)
 * - Array — each element resolved; array results are flattened, empty/missing values dropped
 * - Non-string or plain string — literal (passed through)
 */
export function resolve(spec: unknown, source: Record<string, unknown>): unknown {
  if (Array.isArray(spec)) {
    return spec
      .map((item) => resolve(item, source))
      .flatMap((v) => (Array.isArray(v) ? v : [v]))
      .filter((v) => v != null && v !== "");
  }
  if (typeof spec !== "string") return spec;

  if (spec.includes("{{#")) spec = renderConditionals(spec, source);

  const fullMatch = spec.match(/^\{\{([\w.]+)\}\}$/);
  if (fullMatch) return getByPath(source, fullMatch[1]);

  if (spec.includes("{{")) {
    return spec.replace(/\{\{([\w.]+)\}\}/g, (_, path) => {
      const v = getByPath(source, path);
      return v == null ? "" : String(v);
    });
  }

  return spec;
}

export function mapContent(
  mapping: PlaneContent,
  source: Record<string, unknown>,
): MappedContent {
  const result: MappedContent = {};
  for (const [field, spec] of Object.entries(mapping)) {
    result[field] = resolve(spec, source);
  }
  return result;
}
