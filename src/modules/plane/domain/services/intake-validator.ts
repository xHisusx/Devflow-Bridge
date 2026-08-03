import type { ApiFieldSpec } from "../../../../core/config";

/**
 * Validate an intake request body against the api provider's declarative field schema.
 * Returns human-readable error messages; an empty array means the body is valid.
 */
export function validateIntakeBody(
  fields: Record<string, ApiFieldSpec>,
  body: Record<string, unknown>,
): string[] {
  const errors: string[] = [];

  for (const [name, spec] of Object.entries(fields)) {
    const value = body[name];
    const blank = value == null || (typeof value === "string" && value.trim() === "");

    if (blank) {
      if (spec.required) {
        errors.push(`Field "${name}" is required`);
      } else if (spec.requiredIf && String(body[spec.requiredIf.field] ?? "") === spec.requiredIf.value) {
        errors.push(
          `Field "${name}" is required when "${spec.requiredIf.field}" is "${spec.requiredIf.value}"`,
        );
      }
      continue;
    }

    if (spec.values && spec.values.length > 0 && !spec.values.includes(String(value))) {
      errors.push(
        `Field "${name}": invalid value "${String(value)}". Allowed: ${spec.values.join(", ")}`,
      );
    }
  }

  return errors;
}
