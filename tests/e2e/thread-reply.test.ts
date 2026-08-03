import { describe, test, expect, afterAll, beforeAll } from "bun:test";
import { createTestApp, createWebhookPayload, postWebhook, waitForMessage, cleanupTestMessages, getTestEnv, getTestClient } from "../helpers";
import type { PachkaClient } from "../../src/modules/messenger/infrastructure/clients/pachka-api-client";

describe("E2E: Thread Reply", () => {
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

  test("creates thread reply on 'Done' update", async () => {
    const seq = Math.floor(Math.random() * 9000) + 1000;
    const title = `E2E-thread-${Date.now()}`;
    const issueId = crypto.randomUUID();

    const payload = createWebhookPayload({
      issueId,
      action: "updated",
      issueName: title,
      sequenceId: seq,
      state: { id: "s-done", name: "Done", color: "#00ff00", group: "completed" },
      activity: { field: "state", old_value: "In Progress", new_value: "Done", verb: "updated" },
    });

    const res = await postWebhook(baseUrl, payload);
    const body = await res.json();
    expect(body.sent).toBeGreaterThanOrEqual(1);

    // Find the main message
    const msg = await waitForMessage(
      verifyClient,
      chatId,
      (m) => m.content.includes(`[E2E-DONE] #${seq} ${title}`),
    );

    // Wait a bit for thread to be created
    await Bun.sleep(1000);

    // Verify thread exists on the message
    const fullMsg = await verifyClient.getMessage(msg.id);
    expect(fullMsg.thread).toBeDefined();
    expect(fullMsg.thread).not.toBeNull();

    // Read thread messages
    if (fullMsg.thread) {
      const threadMessages = await verifyClient.getMessages(fullMsg.thread.chat_id, 10);
      const threadReply = threadMessages.find((m) => m.content.includes("State: Done"));
      expect(threadReply).toBeDefined();
    }
  });
});
