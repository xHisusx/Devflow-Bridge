import type { PachkaMessage, PachkaButton, PachkaThread, PachkaUser } from "../../domain/entities/message";
import type { FormViewPayload } from "../../domain/entities/form";

export interface IMessengerClient {
  sendMessage(chatId: number, content: string, opts?: { buttons?: PachkaButton[]; entityType?: "discussion" | "thread" }): Promise<PachkaMessage>;
  /** Edit a message. An explicitly empty `buttons` array clears the message's buttons. */
  editMessage(messageId: number, content: string, opts?: { buttons?: PachkaButton[] }): Promise<PachkaMessage>;
  getUser(userId: number): Promise<PachkaUser>;
  deleteMessage(messageId: number): Promise<void>;
  getMessage(messageId: number): Promise<PachkaMessage>;
  getMessages(chatId: number, limit?: number): Promise<PachkaMessage[]>;
  addReaction(messageId: number, emoji: string): Promise<void>;
  removeReaction(messageId: number, emoji: string): Promise<void>;
  getOrCreateThread(messageId: number): Promise<PachkaThread>;
  sendThreadMessage(threadChatId: number, content: string): Promise<PachkaMessage>;
  /** Open a modal view (form). `triggerId` comes from a button-click webhook and lives ~3 seconds. */
  openView(triggerId: string, view: FormViewPayload, opts?: { callbackId?: string; privateMetadata?: string }): Promise<void>;
}
