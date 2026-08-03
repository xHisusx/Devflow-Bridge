import { describe, test, expect, mock } from "bun:test";
import { OpenFormViewUseCase } from "../../../src/modules/messenger/application/use-cases/open-form-view";
import { ProviderRegistry } from "../../../src/core/provider-registry";
import type { Provider } from "../../../src/core/config";
import type { IMessengerClient } from "../../../src/modules/messenger/application/ports/messenger-client.port";
import type { IMessageStore } from "../../../src/modules/messenger/application/ports/message-store.port";

const PROVIDERS: Provider[] = [
  {
    type: "form",
    alias: "support",
    title: "Заявка",
    submitText: "Отправить",
    blocks: [{ type: "input", name: "summary", label: "Кратко", required: true }],
  },
];

const registry = new ProviderRegistry(PROVIDERS);

function createMockMessengerClient(overrides: Partial<IMessengerClient> = {}): IMessengerClient {
  return {
    openView: mock(() => Promise.resolve()),
    ...overrides,
  } as unknown as IMessengerClient;
}

function createMockMessageStore(
  ctx: { correlationId: string; target: string } | null = null,
): IMessageStore {
  return {
    get: mock(() => null),
    set: mock(() => {}),
    delete: mock(() => {}),
    getByPachkaMessageId: mock(() => ctx),
  };
}

describe("OpenFormViewUseCase.matches", () => {
  test("matches form open callback data", () => {
    expect(OpenFormViewUseCase.matches("form:support:open")).toBe(true);
  });

  test("rejects taiga callback data, non-open form data and non-strings", () => {
    expect(OpenFormViewUseCase.matches("taiga:support:accept:42")).toBe(false);
    expect(OpenFormViewUseCase.matches("form:support")).toBe(false);
    expect(OpenFormViewUseCase.matches("form::open")).toBe(false);
    expect(OpenFormViewUseCase.matches(undefined)).toBe(false);
    expect(OpenFormViewUseCase.matches({ summary: "x" })).toBe(false);
  });
});

describe("OpenFormViewUseCase.execute", () => {
  test("opens the view with rendered payload, callback_id and correlation metadata", async () => {
    const client = createMockMessengerClient();
    const store = createMockMessageStore({ correlationId: "issue-42", target: "helpdesk" });
    const useCase = new OpenFormViewUseCase(registry, client, store);

    const result = await useCase.execute({
      data: "form:support:open",
      triggerId: "trig-1",
      messageId: 100,
      chatId: 555,
    });

    expect(result.ok).toBe(true);
    const call = (client.openView as ReturnType<typeof mock>).mock.calls[0];
    expect(call[0]).toBe("trig-1");
    expect(call[1]).toEqual({
      title: "Заявка",
      submit_text: "Отправить",
      blocks: [{ type: "input", name: "summary", label: "Кратко", required: true }],
    });
    expect(call[2].callbackId).toBe("form:support");
    const meta = JSON.parse(call[2].privateMetadata);
    expect(meta).toEqual({
      formRef: "form:support",
      messageId: 100,
      chatId: 555,
      correlationId: "issue-42",
      target: "helpdesk",
    });
  });

  test("fails without trigger_id and does not call the API", async () => {
    const client = createMockMessengerClient();
    const useCase = new OpenFormViewUseCase(registry, client, createMockMessageStore());

    const result = await useCase.execute({ data: "form:support:open" });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("trigger_id");
    expect((client.openView as ReturnType<typeof mock>).mock.calls.length).toBe(0);
  });

  test("fails when the form provider is unknown", async () => {
    const client = createMockMessengerClient();
    const useCase = new OpenFormViewUseCase(registry, client, createMockMessageStore());

    const result = await useCase.execute({ data: "form:ghost:open", triggerId: "trig-1" });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("form:ghost");
  });

  test("returns ok: false when /views/open fails (e.g. trigger expired)", async () => {
    const client = createMockMessengerClient({
      openView: mock(() => Promise.reject(new Error("trigger_expired"))),
    });
    const useCase = new OpenFormViewUseCase(registry, client, createMockMessageStore());

    const result = await useCase.execute({ data: "form:support:open", triggerId: "trig-old" });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("trigger_expired");
  });

  test("works without a message store (no correlation in metadata)", async () => {
    const client = createMockMessengerClient();
    const useCase = new OpenFormViewUseCase(registry, client, null);

    const result = await useCase.execute({ data: "form:support:open", triggerId: "t", messageId: 7 });

    expect(result.ok).toBe(true);
    const meta = JSON.parse((client.openView as ReturnType<typeof mock>).mock.calls[0][2].privateMetadata);
    expect(meta).toEqual({ formRef: "form:support", messageId: 7 });
  });
});
