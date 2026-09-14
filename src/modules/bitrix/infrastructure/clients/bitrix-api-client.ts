import type { IBitrixClient } from "../../application/ports/bitrix-api.port";
import type { BitrixStatusRequest, BitrixStatusResponse } from "../../domain/entities";

export class BitrixApiClient implements IBitrixClient {
    private baseUrl: string;
    private token: string;

    constructor(token: string, baseUrl: string) {
        this.token = token;
        this.baseUrl = baseUrl.replace(/\/$/, "");
    }

    private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
        const res = await fetch(`${this.baseUrl}${path}`, {
            method,
            headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    if (res.status === 429) {
      const retryAfter = Number(res.headers.get("retry-after") || "5");
      await new Promise((r) => setTimeout(r, retryAfter * 1000));
      return this.request<T>(method, path, body);
    }

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Bitrix API ${method} ${path}: ${res.status} ${text}`);
    }

    if (res.status === 204) return undefined as T;
    const text = await res.text();
    if (!text) return undefined as T;
    return (JSON.parse(text) as any).data as T;
  }

  async updateStatus(request: BitrixStatusRequest): Promise<BitrixStatusResponse> {
    return this.request<BitrixStatusResponse>("PUT", "/support/appeal/status/", request);
  }
}
