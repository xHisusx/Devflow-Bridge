import { describe, test, expect, mock } from "bun:test";
import { pachkaCallbackRoute } from "../../../src/modules/messenger/infrastructure/webhooks/pachka-callback.route";
import type { PachkaCallbackRouteDeps } from "../../../src/modules/messenger/infrastructure/webhooks/pachka-callback.route";
import type { IMessengerClient } from "../../../src/modules/messenger/application/ports/messenger-client.port";
import type { IMessageStore } from "../../../src/modules/messenger/application/ports/message-store.port";
import type { OpenFormViewUseCase } from "../../../src/modules/messenger/application/use-cases/open-form-view";
import type { ProcessFormSubmissionUseCase } from "../../../src/modules/messenger/application/use-cases/process-form-submission";
import type { HandleTaigaFeedbackUseCase } from "../../../src/modules/taiga/application/use-cases/handle-taiga-feedback";

function createMockMessengerClient(): IMessengerClient {
  return {} as unknown as IMessengerClient;
}

function createMockMessageStore(): IMessageStore {
  return {
    get: mock(() => null),
    set: mock(() => {}),
    delete: mock(() => {}),
    getByPachkaMessageId: mock(() => null),
  };
}

function createApp(overrides: Partial<PachkaCallbackRouteDeps> = {}) {
  return pachkaCallbackRoute({
    messengerClient: createMockMessengerClient(),
    messageStore: createMockMessageStore(),
    ...overrides,
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function post(app: any, body: Record<string, unknown>) {
  return app.handle(
    new Request("http://localhost/webhook/pachka", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

const nextTick = () => new Promise((r) => setTimeout(r, 0));

describe("POST /webhook/pachka — form submission (view submit)", () => {
  test("returns empty 200 immediately and runs the pipeline in background", async () => {
    const formSubmission = {
      execute: mock(() => Promise.resolve({ ok: true })),
    } as unknown as ProcessFormSubmissionUseCase;
    const app = createApp({ formSubmission });

    const res = await post(app, {
      type: "view",
      event: "submit",
      callback_id: "form:support",
      data: { summary: "Сломалось" },
      user_id: 9,
      chat_id: 555,
      private_metadata: '{"formRef":"form:support"}',
    });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");

    await nextTick();
    const call = (formSubmission.execute as ReturnType<typeof mock>).mock.calls[0][0];
    expect(call).toEqual({
      callbackId: "form:support",
      data: { summary: "Сломалось" },
      userId: 9,
      chatId: 555,
      privateMetadata: '{"formRef":"form:support"}',
    });
  });

  test("a submit with an unknown callback_id prefix falls through to the ok fallback", async () => {
    const formSubmission = {
      execute: mock(() => Promise.resolve({ ok: true })),
    } as unknown as ProcessFormSubmissionUseCase;
    const app = createApp({ formSubmission });

    const res = await post(app, { type: "view", event: "submit", callback_id: "custom:thing", data: {} });

    expect((await res.json()).ok).toBe(true);
    expect((formSubmission.execute as ReturnType<typeof mock>).mock.calls.length).toBe(0);
  });

  test("submit without a configured handler does not crash (object data ignored)", async () => {
    const app = createApp();

    const res = await post(app, { type: "view", event: "submit", callback_id: "form:support", data: { a: 1 } });

    expect((await res.json()).ok).toBe(true);
  });
});

describe("POST /webhook/pachka — form open button", () => {
  test("dispatches form-open callback data with trigger context, awaited", async () => {
    const openFormView = {
      execute: mock(() => Promise.resolve({ ok: true })),
    } as unknown as OpenFormViewUseCase;
    const app = createApp({ openFormView });

    const res = await post(app, {
      type: "button",
      event: "click",
      data: "form:support:open",
      trigger_id: "trig-1",
      message_id: 100,
      chat_id: 555,
      user_id: 9,
    });

    expect((await res.json()).ok).toBe(true);
    const call = (openFormView.execute as ReturnType<typeof mock>).mock.calls[0][0];
    expect(call).toEqual({ data: "form:support:open", triggerId: "trig-1", messageId: 100, chatId: 555 });
  });

  test("propagates the open error in the response", async () => {
    const openFormView = {
      execute: mock(() => Promise.resolve({ ok: false, error: "trigger_expired" })),
    } as unknown as OpenFormViewUseCase;
    const app = createApp({ openFormView });

    const res = await post(app, { data: "form:support:open", trigger_id: "trig-old" });

    const json = await res.json();
    expect(json.ok).toBe(false);
    expect(json.error).toContain("trigger_expired");
  });
});

describe("POST /webhook/pachka — backward compatibility", () => {
  test("legacy taiga callback (no type field) still dispatches to taiga feedback", async () => {
    const taigaFeedback = {
      execute: mock(() => Promise.resolve({ ok: true })),
    } as unknown as HandleTaigaFeedbackUseCase;
    const app = createApp({ taigaFeedback });

    const res = await post(app, { data: "taiga:support:accept:42", user_id: 9, message_id: 100 });

    expect((await res.json()).ok).toBe(true);
    const call = (taigaFeedback.execute as ReturnType<typeof mock>).mock.calls[0][0];
    expect(call).toEqual({ data: "taiga:support:accept:42", pachkaUserId: 9, messageId: 100 });
  });

  test("unknown button data falls through to the ok fallback", async () => {
    const app = createApp();

    const res = await post(app, { data: "vote_yes", user_id: 9, message_id: 100 });

    expect((await res.json()).ok).toBe(true);
  });

  test("errors when the Pachka API is not configured", async () => {
    const app = pachkaCallbackRoute({ messengerClient: null, messageStore: null });

    const res = await post(app, { data: "form:support:open" });

    expect((await res.json()).ok).toBe(false);
  });
});
