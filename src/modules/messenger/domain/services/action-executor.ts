import type { RuleAction, ButtonDef, PachkaButton } from "../entities";
import { buildFormOpenData } from "../entities/form";
import { renderMessage } from "../../../plane/domain/services/template-renderer";

/**
 * Link buttons of a message, as Pachka returns them (rows of buttons).
 *
 * A card that is superseded or has moved on keeps where it leads, not what it can do: a DM whose
 * "Задача" and "MR" buttons vanish the moment the person takes the task leaves them with no way
 * back to either. So links are carried over and only the callback buttons are dropped.
 */
export function keepLinkButtons(rows: PachkaButton[][] | undefined): PachkaButton[] {
  return (rows ?? []).flat().filter((b) => b.url && !b.data);
}

/** Extract buttons from actions (handled at send-time, not post-send). */
export function extractButtons(
  actions: RuleAction[] | undefined,
  source: Record<string, unknown>,
): PachkaButton[] | undefined {
  if (!actions) return undefined;

  const buttonAction = actions.find((a) => a.type === "buttons") as
    | { type: "buttons"; buttons: ButtonDef[] }
    | undefined;

  if (!buttonAction) return undefined;

  return buttonAction.buttons.map((b) => {
    if (b.form) {
      return { text: renderMessage(b.text, source), data: buildFormOpenData(b.form) };
    }
    return {
      text: renderMessage(b.text, source),
      ...(b.url ? { url: renderMessage(b.url, source) } : {}),
      ...(b.callbackData ? { data: renderMessage(b.callbackData, source) } : {}),
    };
  });
}
