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

/**
 * Link buttons of a message, as Pachka returns them (rows of buttons).
 *
 * A status transition replaces what can be *done* next, not where the task lives: a DM whose
 * "Задача" and "MR" buttons vanish the moment the person takes the task leaves them with no way
 * back to either. So the links are carried over and only the callback buttons are swapped.
 */
export function keepLinkButtons(rows: PachkaButton[][] | undefined): PachkaButton[] {
  return (rows ?? []).flat().filter((b) => b.url && !b.data);
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

/**
 * Web UI URL of a Taiga item: <webRoot>/project/<slug>/<issue|us|task>/<ref>.
 * `entityOverride` is for webhook events, whose entity comes from the payload rather than
 * from the provider (one project can emit issue and user-story events alike).
 */
export function buildItemUrl(
  provider: TaigaProvider,
  projectSlug: string,
  ref: number,
  entityOverride?: TaigaEntity,
): string {
  const entity = entityOverride ?? provider.entity ?? "issue";
  const webRoot = (provider.webUrl ?? provider.baseUrl).replace(/\/$/, "");
  return `${webRoot}/project/${projectSlug}/${WEB_PATH_BY_ENTITY[entity]}/${ref}`;
}
