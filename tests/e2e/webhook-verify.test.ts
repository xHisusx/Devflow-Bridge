import { describe, test, expect, afterAll, beforeAll } from "bun:test";
import { createApp, type AppDependencies } from "../../src/app";
import { MessageStore } from "../../src/modules/messenger/infrastructure/persistence/sqlite-message-store";
import { PachkaClient } from "../../src/modules/messenger/infrastructure/clients/pachka-api-client";
import { ProviderRegistry } from "../../src/core/provider-registry";
import { createWebhookPayload, getTestEnv } from "../helpers";

describe("E2E: Webhook Signature Verification", () => {
  const secret = "test-webhook-secret-12345";
  let elysiaApp: ReturnType<typeof createApp>;
  let baseUrl: string;

  beforeAll(() => {
    const env = getTestEnv();
    const providers = [
      { type: "pachka" as const, alias: "test-target", chatId: env.chatId },
    ];
    const deps: AppDependencies = {
      config: { providers, rules: [] },
      registry: new ProviderRegistry(providers),
      pachkaClient: new PachkaClient(env.token),
      messageStore: new MessageStore(":memory:"),
      projectIdMap: new Map(),
      projectIdentifierMap: new Map(),
      memberMap: new Map(),
      webhookSecret: secret,
    };

    elysiaApp = createApp(deps);
    elysiaApp.listen(0);
    baseUrl = `http://localhost:${elysiaApp.server!.port}`;
  });

  afterAll(async () => {
    await elysiaApp.stop();
  });

  async function sign(payload: string): Promise<string> {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
    return Array.from(new Uint8Array(sig))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  test("rejects request with invalid signature", async () => {
    const payload = JSON.stringify(createWebhookPayload());
    const res = await fetch(`${baseUrl}/webhook/plane`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-plane-event": "issue",
        "x-plane-signature": "invalid-signature",
      },
      body: payload,
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("invalid signature");
  });

  test("rejects request with no signature", async () => {
    const payload = JSON.stringify(createWebhookPayload());
    const res = await fetch(`${baseUrl}/webhook/plane`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-plane-event": "issue",
      },
      body: payload,
    });
    expect(res.status).toBe(401);
  });

  test("accepts request with valid signature", async () => {
    const payload = JSON.stringify(createWebhookPayload());
    const signature = await sign(payload);
    const res = await fetch(`${baseUrl}/webhook/plane`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-plane-event": "issue",
        "x-plane-signature": signature,
      },
      body: payload,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });
});
