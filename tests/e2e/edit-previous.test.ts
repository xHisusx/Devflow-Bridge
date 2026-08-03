import { describe, test, expect, afterAll, beforeAll } from "bun:test";
import { createTestApp, createWebhookPayload, postWebhook, waitForMessage, cleanupTestMessages, getTestEnv, getTestClient } from "../helpers";
import type { PachkaClient } from "../../src/modules/messenger/infrastructure/clients/pachka-api-client";

describe("E2E: Edit Previous", () => {
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

  test("editPrevious updates the original message", async () => {
    const seq = Math.floor(Math.random() * 9000) + 1000;
    const title = `E2E-edit-${Date.now()}`;
    const issueId = crypto.randomUUID();

    // Step 1: create the initial message
    const createPayload = createWebhookPayload({
      issueId,
      action: "created",
      issueName: title,
      sequenceId: seq,
    });

    const createRes = await postWebhook(baseUrl, createPayload);
    expect((await createRes.json()).sent).toBe(1);

    const origMsg = await waitForMessage(
      verifyClient,
      chatId,
      (m) => m.content.includes(`[E2E-TEST] #${seq} ${title}`),
    );

    // Step 2: send update — triggers editPrevious (the 3rd rule matches non-completed updates)
    const updatePayload = createWebhookPayload({
      issueId,
      action: "updated",
      issueName: title,
      sequenceId: seq,
      state: { id: "s-review", name: "In Review", color: "#3b82f6", group: "started" },
      activity: { field: "state", old_value: "In Progress", new_value: "In Review", verb: "updated" },
      // Different updated_at to avoid dedup
      updatedAt: new Date(Date.now() + 1000).toISOString(),
    });

    const updateRes = await postWebhook(baseUrl, updatePayload);
    expect((await updateRes.json()).sent).toBeGreaterThanOrEqual(1);

    // Wait for edit to propagate
    await Bun.sleep(1500);

    // Step 3: verify original message was edited
    const editedMsg = await verifyClient.getMessage(origMsg.id);
    expect(editedMsg.content).toContain("[E2E-EDITED]");
    expect(editedMsg.content).toContain(title);
    expect(editedMsg.changed_at).not.toBeNull();
  });
});
