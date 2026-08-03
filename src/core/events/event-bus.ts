type Handler<T = unknown> = (data: T) => void | Promise<void>;

export class EventBus {
  private handlers = new Map<string, Handler[]>();

  on<T>(event: string, handler: Handler<T>): void {
    const list = this.handlers.get(event) ?? [];
    list.push(handler as Handler);
    this.handlers.set(event, list);
  }

  off<T>(event: string, handler: Handler<T>): void {
    const list = this.handlers.get(event);
    if (!list) return;
    const idx = list.indexOf(handler as Handler);
    if (idx !== -1) list.splice(idx, 1);
  }

  async emit<T>(event: string, data: T): Promise<void> {
    const list = this.handlers.get(event);
    if (!list) return;
    for (const handler of list) {
      await handler(data);
    }
  }
}
