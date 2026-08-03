import type { RuleAction } from "../../domain/entities/notification";
import type { IMessengerClient } from "../ports/messenger-client.port";
import type { IMessageStore } from "../ports/message-store.port";
import { renderMessage } from "../../../plane/domain/services/template-renderer";
import { log } from "../../../../core/logger";

export interface ActionContext {
  client: IMessengerClient;
  store: IMessageStore;
  chatId: number;
  target: string;
  /** Generic key correlating messages about the same upstream entity (e.g. a Plane issue id). */
  correlationId: string;
  source: Record<string, unknown>;
  currentMessageId: number;
  previousMessageId: number | null;
}

/** Execute post-send actions (reaction, editPrevious, threadReply, pin). */
export async function executeActions(
  actions: RuleAction[],
  ctx: ActionContext
): Promise<void> {
  for (const action of actions) {
    try {
      switch (action.type) {
        case "buttons":
          // Handled at send-time via extractButtons, skip here
          break;

        case "reaction": {
          const targetMsgId =
            ctx.store.get(ctx.correlationId, ctx.target) ?? ctx.currentMessageId;
          await ctx.client.addReaction(targetMsgId, action.emoji);
          log.debug(`action: reaction :${action.emoji}: on message ${targetMsgId}`);
          break;
        }

        case "editPrevious": {
          const prevMsgId = ctx.previousMessageId;
          if (!prevMsgId || prevMsgId === ctx.currentMessageId) {
            log.debug("action: editPrevious skipped (no previous message)");
            break;
          }
          const text = action.message
            ? renderMessage(action.message, ctx.source)
            : (ctx.source._currentMessage as string) ?? "";
          await ctx.client.editMessage(prevMsgId, text);
          log.debug(`action: editPrevious on message ${prevMsgId}`);
          break;
        }

        case "threadReply": {
          const parentMsgId =
            ctx.store.get(ctx.correlationId, ctx.target) ?? ctx.currentMessageId;
          const thread = await ctx.client.getOrCreateThread(parentMsgId);
          const text = renderMessage(action.message, ctx.source);
          log.debug(`action: threadReply thread data`, { threadId: thread.id, chatId: thread.chat_id, messageId: thread.message_id });
          await ctx.client.sendThreadMessage(thread.id, text);
          log.debug(`action: threadReply in thread ${thread.id} of message ${parentMsgId}`);
          break;
        }

        case "pin": {
          // Reserved for future implementation
          log.debug("action: pin (not yet implemented)");
          break;
        }
      }
    } catch (e) {
      log.error(`action: ${action.type} FAILED`, { error: String(e) });
    }
  }
}
