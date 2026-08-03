import type { RuleAction, ButtonDef, PachkaButton } from "../entities";
import { buildFormOpenData } from "../entities/form";
import { renderMessage } from "../../../plane/domain/services/template-renderer";

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
