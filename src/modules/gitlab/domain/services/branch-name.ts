import type { GitLabProvider } from "../../../../core/config";
import { getByPath } from "../../../plane/domain/services/content-mapper";
import { renderMessage } from "../../../plane/domain/services/template-renderer";

/** Branch notation the bridge ships with: feat/<initials>/<transliterated-task-name>. */
export const DEFAULT_BRANCH_PATTERN = "{{branchType}}/{{assigneeInitials}}/{{slug}}";
export const DEFAULT_BRANCH_TYPE = "feat";
export const DEFAULT_SLUG_LENGTH = 60;
export const DRAFT_PREFIX = "Draft: ";

/**
 * Pick the repository for this step: an explicit `content.repo` wins, then the first of `tags`
 * present in the provider's `repoByTag` map (compared case-insensitively), then `provider.project`.
 */
export function resolveRepo(
  provider: GitLabProvider,
  repo: string | undefined,
  tags: string[] = [],
): string {
  if (repo) return repo;

  const map = provider.repoByTag ?? {};
  const keys = Object.keys(map);
  for (const tag of tags) {
    const key = keys.find((k) => k.toLowerCase() === String(tag).toLowerCase());
    if (key) return map[key];
  }
  return provider.project;
}

/**
 * Render a branch-name pattern and make the result a valid git ref: invalid characters become
 * "-", separators are collapsed, and leading/trailing separators are dropped.
 */
/**
 * Branch type for `{{branchType}}`: an explicit value from the rule wins, then the provider's
 * `branch.typeByTag` matched against the item's tags (in their order), then against the item's
 * type name (so a Taiga issue of type "Bug" becomes "fix" with no tagging), then the provider's
 * `branch.type`, then "feat".
 */
export function resolveBranchType(
  provider: GitLabProvider,
  explicit: string | undefined,
  tags: string[] = [],
  itemType = "",
): string {
  if (explicit) return explicit;

  const map = provider.branch?.typeByTag;
  if (map) {
    const lookup = new Map(Object.entries(map).map(([k, v]) => [k.trim().toLowerCase(), v]));
    for (const candidate of [...tags, itemType]) {
      const hit = lookup.get(String(candidate).trim().toLowerCase());
      if (hit) return hit;
    }
  }
  return provider.branch?.type || DEFAULT_BRANCH_TYPE;
}

export function buildBranchName(pattern: string, vars: Record<string, unknown>): string {
  const rendered = renderMessage(pattern, vars);
  return sanitizeBranchName(rendered);
}

/**
 * Placeholders of a branch pattern that resolve to nothing. A half-rendered name would silently
 * collapse into something like "feat" and collide across tasks, so callers treat this as an error.
 */
export function missingBranchVars(pattern: string, vars: Record<string, unknown>): string[] {
  const missing: string[] = [];
  for (const match of pattern.matchAll(/\{\{([\w.]+)\}\}/g)) {
    const value = getByPath(vars, match[1]);
    if (value == null || String(value).trim() === "") missing.push(match[1]);
  }
  return missing;
}

/** Strip everything git refuses in a ref name (spaces, ~^:?*[\, .., @{, double slashes). */
export function sanitizeBranchName(name: string): string {
  return name
    .replace(/[\s~^:?*[\]\\]+/g, "-")
    .replace(/\.\.+/g, ".")
    .replace(/@\{/g, "-")
    .replace(/\/{2,}/g, "/")
    .replace(/-{2,}/g, "-")
    .replace(/(^[-/.]+)|([-/.]+$)/g, "")
    .replace(/\.lock$/i, "");
}

/** GitLab has no `draft` flag on create — a draft MR is one whose title starts with "Draft: ". */
export function draftTitle(title: string, draft: boolean): string {
  const stripped = title.replace(/^\s*(draft:|wip:)\s*/i, "");
  return draft ? `${DRAFT_PREFIX}${stripped}` : stripped;
}

/** Tag list from a content value that may be a single string, an array, or missing. */
export function asTagList(value: unknown): string[] {
  if (value == null || value === "") return [];
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  return String(value)
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}
