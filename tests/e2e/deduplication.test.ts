import { describe, test, expect, afterAll, beforeAll } from "bun:test";
import { createTestApp, createWebhookPayload, postWebhook, getTestEnv, getTestClient, cleanupTestMessages, waitForMessage } from "../helpers";
import type { PachkaClient } from "../../src/modules/messenger/infrastructure/clients/pachka-api-client";

describe("E2E: Deduplication", () => {
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

  test("duplicate webhooks do not create multiple messages", async () => {
    const seq = Math.floor(Math.random() * 9000) + 1000;
    const title = `E2E-dedup-${Date.now()}`;
    const payload = createWebhookPayload({
      action: "created",
      issueName: title,
      sequenceId: seq,
    });

    // Send the same payload twice
    const res1 = await postWebhook(baseUrl, payload);
    const body1 = await res1.json();
    expect(body1.sent).toBe(1);

    const res2 = await postWebhook(baseUrl, payload);
    const body2 = await res2.json();
    expect(body2.sent).toBe(0); // duplicate, should be skipped

    // Verify only one message in Pachka
    const msg = await waitForMessage(
      verifyClient,
      chatId,
      (m) => m.content.includes(`[E2E-TEST] #${seq} ${title}`),
    );
    expect(msg).toBeDefined();

    // Check there is not a second one
    await Bun.sleep(1000);
    const allMessages = await verifyClient.getMessages(chatId, 20);
    const matching = allMessages.filter((m) => m.content.includes(`[E2E-TEST] #${seq} ${title}`));
    expect(matching.length).toBe(1);
  });
});
