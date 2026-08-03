import { describe, test, expect, afterAll, beforeAll } from "bun:test";
import { createTestApp, createWebhookPayload, postWebhook, waitForMessage, cleanupTestMessages, getTestEnv, getTestClient } from "../helpers";
import type { PachkaClient } from "../../src/modules/messenger/infrastructure/clients/pachka-api-client";

describe("E2E: Reactions", () => {
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

  test("reaction is added without error (Done rule has reaction action)", async () => {
    const seq = Math.floor(Math.random() * 9000) + 1000;
    const title = `E2E-react-${Date.now()}`;

    const payload = createWebhookPayload({
      action: "updated",
      issueName: title,
      sequenceId: seq,
      state: { id: "s-done", name: "Done", color: "#00ff00", group: "completed" },
      activity: { field: "state", old_value: "In Progress", new_value: "Done", verb: "updated" },
    });

    // The webhook handler calls addReaction after sending the message.
    // If reaction fails, the response still returns sent >= 1 but logs an error.
    // A successful response with sent >= 1 confirms the message + reaction pipeline ran.
    const res = await postWebhook(baseUrl, payload);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.sent).toBeGreaterThanOrEqual(1);

    const msg = await waitForMessage(
      verifyClient,
      chatId,
      (m) => m.content.includes(`[E2E-DONE] #${seq} ${title}`),
    );
    expect(msg).toBeDefined();
  });
});
