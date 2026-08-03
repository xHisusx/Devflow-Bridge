export interface IMessageStore {
  get(correlationId: string, target: string): number | null;
  set(correlationId: string, target: string, messageId: number, chatId: number): void;
  delete(correlationId: string, target: string): void;
  getByPachkaMessageId(messageId: number): { correlationId: string; target: string } | null;
}
