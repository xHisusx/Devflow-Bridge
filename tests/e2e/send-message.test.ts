import { describe, test, expect, afterAll, beforeAll } from "bun:test";
import { createTestApp, createWebhookPayload, postWebhook, waitForMessage, cleanupTestMessages, getTestEnv, getTestClient } from "../helpers";
import type { PachkaClient } from "../../src/modules/messenger/infrastructure/clients/pachka-api-client";

describe("E2E: Send Message", () => {
  let elysiaApp: ReturnType<typeof createTestApp>["app"];
  let baseUrl: string;
  let verifyClient: PachkaClient;
  let chatId: number;

  beforeAll(() => {
    const env = getTestEnv();
    chatId = env.chatId;
    verifyClient = getTestClient();
    const { app } = createTestApp(chatId);
    elysiaApp = app;
    app.listen(0);
    baseUrl = `http://localhost:${app.server!.port}`;
  });

  afterAll(async () => {
    await cleanupTestMessages(verifyClient, chatId);
    await elysiaApp.stop();
  });

  test("health check", async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test("sends message to Pachka when rule matches", async () => {
    const seq = Math.floor(Math.random() * 9000) + 1000;
    const title = `E2E-send-${Date.now()}`;
    const payload = createWebhookPayload({
      action: "created",
      issueName: title,
      sequenceId: seq,
    });

    const res = await postWebhook(baseUrl, payload);
    const body = await res.json();
    expect(body).toEqual({ ok: true, sent: 1 });

    const msg = await waitForMessage(
      verifyClient,
      chatId,
      (m) => m.content.includes(`[E2E-TEST] #${seq} ${title}`),
    );
    expect(msg.content).toContain(`[E2E-TEST] #${seq} ${title}`);
  });

  test("does not send when no rule matches (wrong action)", async () => {
    const payload = createWebhookPayload({
      action: "deleted",
      issueName: `E2E-no-match-${Date.now()}`,
    });

    const res = await postWebhook(baseUrl, payload);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.sent).toBe(0);
  });
});
