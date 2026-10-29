import type { PachkaProvider } from "../../../../core/config";
import type { NotifyContent } from "../../domain/entities/notification";
import type { PachkaEntityType } from "../ports/messenger-client.port";
import type { PachkaUserDirectory } from "./pachka-user-directory";
import { renderMessage } from "../../../plane/domain/services/template-renderer";
import { log } from "../../../../core/logger";

export interface PachkaTarget {
  /** Chat id for a channel message, user id for a direct message. */
  entityId: number;
  entityType: PachkaEntityType;
}

/**
 * Where a notify step should send its message: the provider's chat, or — for a `dm: true`
 * provider — the personal chat of the person named by `content.recipient` (a work email or a
 * numeric user id, templated against the step's source). Returns null when the recipient cannot
 * be resolved, which skips the step instead of sending the message to the wrong place.
 */
export async function resolvePachkaTarget(
  provider: PachkaProvider,
  content: NotifyContent,
  source: Record<string, unknown>,
  directory: PachkaUserDirectory | null,
): Promise<PachkaTarget | null> {
  if (!provider.dm) {
    if (provider.chatId == null) {
      log.warn(`pachka:${provider.alias}: no "chatId" configured`);
      return null;
    }
    return { entityId: provider.chatId, entityType: "discussion" };
  }

  const recipient = renderMessage(content.recipient ?? "", source).trim();
  if (!recipient) {
    log.warn(`pachka:${provider.alias}: DM step without a resolved "recipient"`);
    return null;
  }

  if (/^\d+$/.test(recipient)) {
    return { entityId: Number(recipient), entityType: "user" };
  }

  if (!directory) {
    log.warn(`pachka:${provider.alias}: DM needs the Pachka API (users:read) to resolve an email`, {
      recipient,
    });
    return null;
  }

  const userId = await directory.findIdByEmail(recipient, provider.workEmailField);
  if (!userId) {
    log.warn(`pachka:${provider.alias}: no Pachka user for recipient`, { recipient });
    return null;
  }
  return { entityId: userId, entityType: "user" };
}
