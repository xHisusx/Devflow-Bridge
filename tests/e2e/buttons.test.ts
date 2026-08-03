import { describe, test, expect, afterAll, beforeAll } from "bun:test";
import { createTestApp, createWebhookPayload, postWebhook, waitForMessage, cleanupTestMessages, getTestEnv, getTestClient } from "../helpers";
import type { PachkaClient } from "../../src/modules/messenger/infrastructure/clients/pachka-api-client";

describe("E2E: Buttons", () => {
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

  test("message has buttons when rule has buttons action", async () => {
    const seq = Math.floor(Math.random() * 9000) + 1000;
    const title = `E2E-btn-${Date.now()}`;
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

    const msg = await waitForMessage(
      verifyClient,
      chatId,
      (m) => m.content.includes(`[E2E-DONE] #${seq} ${title}`),
    );

    // Verify buttons via getMessage (returns full message with buttons)
    const fullMsg = await verifyClient.getMessage(msg.id);
    expect(fullMsg.buttons).toBeDefined();
    expect(fullMsg.buttons!.length).toBeGreaterThan(0);

    const flatButtons = fullMsg.buttons!.flat();
    const openButton = flatButtons.find((b) => b.text === "Open");
    expect(openButton).toBeDefined();
    expect(openButton!.url).toContain("plane.test.local");
  });
});
