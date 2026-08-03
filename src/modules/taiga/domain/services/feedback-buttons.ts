import type { TaigaFeedbackButton, TaigaEntity, TaigaProvider } from "../../../../core/config";
import type { PachkaButton } from "../../../messenger/domain/entities/message";

export const TAIGA_CALLBACK_PREFIX = "taiga:";

/** Build Pachka callback buttons for a Taiga item: data = "taiga:<alias>:<action>:<itemId>". */
export function buildFeedbackButtons(
  alias: string,
  itemId: number,
  defs: TaigaFeedbackButton[],
): PachkaButton[] {
  return defs.map((b) => ({
    text: b.text,
    data: `${TAIGA_CALLBACK_PREFIX}${alias}:${b.action}:${itemId}`,
  }));
}

/** Display label for a Taiga status ("In progress" -> "В процессе 🚀"), falling back to the raw name. */
export function statusLabel(
  labels: Record<string, string> | undefined,
  statusName: string | null,
): string {
  if (!statusName) return "";
  if (!labels) return statusName;
  const key = Object.keys(labels).find((k) => k.toLowerCase() === statusName.toLowerCase());
  return key ? labels[key] : statusName;
}

const WEB_PATH_BY_ENTITY: Record<TaigaEntity, string> = {
  issue: "issue",
  user_story: "us",
  task: "task",
};

/** Web UI URL of a Taiga item: <webRoot>/project/<slug>/<issue|us|task>/<ref>. */
export function buildItemUrl(provider: TaigaProvider, projectSlug: string, ref: number): string {
  const entity = provider.entity ?? "issue";
  const webRoot = (provider.webUrl ?? provider.baseUrl).replace(/\/$/, "");
  return `${webRoot}/project/${projectSlug}/${WEB_PATH_BY_ENTITY[entity]}/${ref}`;
}
