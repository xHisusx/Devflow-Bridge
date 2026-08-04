import type { PachkaMessage, PachkaButton, PachkaThread, PachkaUser } from "../../domain/entities/message";
import type { FormViewPayload } from "../../domain/entities/form";
import type { IMessengerClient } from "../../application/ports/messenger-client.port";

export class PachkaClient implements IMessengerClient {
  private baseUrl: string;
  private token: string;

  constructor(token: string, baseUrl = "https://api.pachca.com/api/shared/v1") {
    this.token = token;
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        "Authorization": `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (res.status === 429) {
      const retryAfter = Number(res.headers.get("retry-after") || "5");
      await new Promise((r) => setTimeout(r, retryAfter * 1000));
      return this.request<T>(method, path, body);
    }

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Pachka API ${method} ${path}: ${res.status} ${text}`);
    }

    if (res.status === 204) return undefined as T;
    // Some endpoints (e.g. /views/open) return 201 with an empty body.
    const text = await res.text();
    if (!text) return undefined as T;
    return (JSON.parse(text) as any).data as T;
  }

  private async requestRaw<T>(method: string, path: string): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        "Authorization": `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
    });

    if (res.status === 429) {
      const retryAfter = Number(res.headers.get("retry-after") || "5");
      await new Promise((r) => setTimeout(r, retryAfter * 1000));
      return this.requestRaw<T>(method, path);
    }

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Pachka API ${method} ${path}: ${res.status} ${text}`);
    }

    return res.json() as Promise<T>;
  }

  async sendMessage(
    chatId: number,
    content: string,
    opts?: { buttons?: PachkaButton[]; entityType?: "discussion" | "thread" }
  ): Promise<PachkaMessage> {
    const body: Record<string, unknown> = {
      message: {
        entity_type: opts?.entityType ?? "discussion",
        entity_id: chatId,
        content,
      },
    };

    if (opts?.buttons && opts.buttons.length > 0) {
      (body.message as any).buttons = this.formatButtons(opts.buttons);
    }

    return this.request<PachkaMessage>("POST", "/messages", body);
  }

  async getOrCreateThread(messageId: number): Promise<PachkaThread> {
    return this.request<PachkaThread>("POST", `/messages/${messageId}/thread`);
  }

  async sendThreadMessage(threadChatId: number, content: string): Promise<PachkaMessage> {
    return this.sendMessage(threadChatId, content, { entityType: "thread" });
  }

  async editMessage(
    messageId: number,
    content: string,
    opts?: { buttons?: PachkaButton[] }
  ): Promise<PachkaMessage> {
    const body: Record<string, unknown> = {
      message: { content },
    };

    // An explicitly passed array (even empty) is sent as-is so buttons can be cleared.
    if (opts?.buttons) {
      (body.message as any).buttons = this.formatButtons(opts.buttons);
    }

    return this.request<PachkaMessage>("PUT", `/messages/${messageId}`, body);
  }

  async getUser(userId: number): Promise<PachkaUser> {
    return this.request<PachkaUser>("GET", `/users/${userId}`);
  }

  async deleteMessage(messageId: number): Promise<void> {
    await this.request<void>("DELETE", `/messages/${messageId}`);
  }

  async getMessage(messageId: number): Promise<PachkaMessage> {
    return this.request<PachkaMessage>("GET", `/messages/${messageId}`);
  }

  async getMessages(chatId: number, limit = 50): Promise<PachkaMessage[]> {
    const raw = await this.requestRaw<{ data: PachkaMessage[] }>(
      "GET",
      `/messages?chat_id=${chatId}&per=${limit}&sort[id]=desc`
    );
    return raw.data;
  }

  private formatButtons(buttons: PachkaButton[]): PachkaButton[][] {
    return buttons.map((b) => [{ text: b.text, ...(b.url ? { url: b.url } : {}), ...(b.data ? { data: b.data } : {}) }]);
  }

  async addReaction(messageId: number, emoji: string): Promise<void> {
    await this.request<void>("POST", `/messages/${messageId}/reactions`, {
      code: emoji,
    });
  }

  async removeReaction(messageId: number, emoji: string): Promise<void> {
    await this.request<void>("DELETE", `/messages/${messageId}/reactions`, {
      code: emoji,
    });
  }

  /**
   * Establish the DNS/TLS connection to the Pachka API ahead of time. Form opens race a 3-second
   * trigger_id TTL — a cold first request after startup can eat half of that budget.
   */
  async warmup(): Promise<void> {
    try {
      await fetch(this.baseUrl, { method: "HEAD" });
    } catch {
      // Best-effort: warmup failures are irrelevant, real calls will surface real errors.
    }
  }

  async openView(
    triggerId: string,
    view: FormViewPayload,
    opts?: { callbackId?: string; privateMetadata?: string }
  ): Promise<void> {
    await this.request<void>("POST", "/views/open", {
      type: "modal",
      trigger_id: triggerId,
      ...(opts?.callbackId ? { callback_id: opts.callbackId } : {}),
      ...(opts?.privateMetadata ? { private_metadata: opts.privateMetadata } : {}),
      view,
    });
  }
}
