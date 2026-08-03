import { describe, test, expect, mock } from "bun:test";
import { createHmac } from "node:crypto";
import { verifyTaigaSignature } from "../../../src/modules/taiga/infrastructure/services/taiga-webhook-verifier";
import { ProcessTaigaWebhookUseCase, type TaigaWebhookPayload } from "../../../src/modules/taiga/application/use-cases/process-taiga-webhook";
import type { IMessengerClient } from "../../../src/modules/messenger/application/ports/messenger-client.port";
import type { IMessageStore } from "../../../src/modules/messenger/application/ports/message-store.port";
import type { Config, Provider } from "../../../src/core/config";
import { ProviderRegistry } from "../../../src/core/provider-registry";

const PROVIDERS: Provider[] = [
  {
    type: "taiga",
    alias: "support",
    baseUrl: "https://taiga.test",
    project: "support-desk",
    feedback: {
      statuses: { accept: "In progress", pause: "On pause", close: "Closed" },
      buttons: {
        "In progress": [
          { text: "⏹️ Поставить на паузу", action: "pause" },
          { text: "✅ Завершить", action: "close" },
        ],
      },
    },
  },
  { type: "pachka", alias: "helpdesk", chatId: 54321 },
];

function createMockMessengerClient(): IMessengerClient {
  return {
    sendMessage: mock(() => Promise.resolve({ id: 999 })),
    editMessage: mock(() => Promise.resolve()),
    addReaction: mock(() => Promise.resolve()),
    getOrCreateThread: mock(() => Promise.resolve({ id: 1, chat_id: 1, message_id: 1 })),
    sendThreadMessage: mock(() => Promise.resolve({ id: 1000 })),
    getMessage: mock(() => Promise.resolve({ id: 100, content: "original text" })),
    getUser: mock(() => Promise.resolve({ id: 9 })),
  };
}

function createMockMessageStore(entries: Record<string, number> = {}): IMessageStore {
  return {
    get: mock((issueId: string, target: string) => entries[`${issueId}:${target}`] ?? null),
    set: mock(() => {}),
    delete: mock(() => {}),
    getByPachkaMessageId: mock(() => null),
  };
}

function changePayload(overrides: Partial<TaigaWebhookPayload> = {}): TaigaWebhookPayload {
  return {
    action: "change",
    type: "issue",
    data: {
      id: 777,
      subject: "Broken login",
      project: { permalink: "https://taiga.test/project/support-desk" },
      status: { name: "In progress" },
    },
    change: { diff: { status: { from: "New", to: "In progress" } } },
    ...overrides,
  };
}

const registry = new ProviderRegistry(PROVIDERS);

describe("verifyTaigaSignature", () => {
  test("accepts a valid HMAC-SHA1 hex signature", async () => {
    const body = '{"action":"test"}';
    const secret = "my-webhook-secret";
    const signature = createHmac("sha1", secret).update(body).digest("hex");

    expect(await verifyTaigaSignature(body, signature, secret)).toBe(true);
  });

  test("rejects an invalid signature", async () => {
    expect(await verifyTaigaSignature('{"action":"test"}', "deadbeef", "my-webhook-secret")).toBe(false);
  });
});

describe("ProcessTaigaWebhookUseCase", () => {
  test("status change syncs the tracked message's buttons", async () => {
    const messengerClient = createMockMessengerClient();
    const messageStore = createMockMessageStore({ "777:helpdesk": 100 });
    const useCase = new ProcessTaigaWebhookUseCase(registry, messengerClient, messageStore);

    const result = await useCase.execute(changePayload());

    expect(result.updated).toBe(1);
    expect(messengerClient.editMessage).toHaveBeenCalledWith(100, "original text", {
      buttons: [
        { text: "⏹️ Поставить на паузу", data: "taiga:support:pause:777" },
        { text: "✅ Завершить", data: "taiga:support:close:777" },
      ],
    });
  });

  test("status without configured buttons clears the message buttons", async () => {
    const messengerClient = createMockMessengerClient();
    const messageStore = createMockMessageStore({ "777:helpdesk": 100 });
    const useCase = new ProcessTaigaWebhookUseCase(registry, messengerClient, messageStore);

    await useCase.execute(
      changePayload({
        data: {
          id: 777,
          project: { permalink: "https://taiga.test/project/support-desk" },
          status: { name: "Closed" },
        },
        change: { diff: { status: { from: "In progress", to: "Closed" } } },
      }),
    );

    expect(messengerClient.editMessage).toHaveBeenCalledWith(100, "original text", { buttons: [] });
  });

  test("re-renders the message from the pipeline rule template using payload data", async () => {
    const messengerClient = createMockMessengerClient();
    const messageStore = createMockMessageStore({ "777:helpdesk": 100 });
    const config: Config = {
      providers: PROVIDERS,
      rules: [[
        {
          from: "taiga:support",
          to: "pachka:helpdesk",
          on: { content: { message: "{{name}} | {{type}} | {{assignee}} | {{status}}" } },
        },
      ]],
    };
    const useCase = new ProcessTaigaWebhookUseCase(registry, messengerClient, messageStore, config);

    await useCase.execute(
      changePayload({
        data: {
          id: 777,
          ref: 13,
          subject: "Broken login",
          project: { permalink: "https://taiga.test/project/support-desk" },
          status: { name: "In progress" },
          assigned_to: { full_name_display: "Иван Петров" },
          type: { name: "Ошибка" },
        },
      }),
    );

    expect(messengerClient.editMessage).toHaveBeenCalledWith(
      100,
      "Broken login | Ошибка | Иван Петров | In progress",
      {
        buttons: [
          { text: "⏹️ Поставить на паузу", data: "taiga:support:pause:777" },
          { text: "✅ Завершить", data: "taiga:support:close:777" },
        ],
      },
    );
    expect(messengerClient.getMessage).not.toHaveBeenCalled();
  });

  test("assignee-only change also re-syncs the message", async () => {
    const messengerClient = createMockMessengerClient();
    const messageStore = createMockMessageStore({ "777:helpdesk": 100 });
    const useCase = new ProcessTaigaWebhookUseCase(registry, messengerClient, messageStore);

    const result = await useCase.execute(
      changePayload({
        change: { diff: { assigned_to: { from: null, to: "Иван Петров" } } },
      }),
    );

    expect(result.updated).toBe(1);
  });

  test("test event is acknowledged without any edits", async () => {
    const messengerClient = createMockMessengerClient();
    const useCase = new ProcessTaigaWebhookUseCase(registry, messengerClient, createMockMessageStore());

    const result = await useCase.execute({ action: "test", type: "test" });

    expect(result.ok).toBe(true);
    expect(messengerClient.editMessage).not.toHaveBeenCalled();
  });

  test("change without a status diff is ignored", async () => {
    const messengerClient = createMockMessengerClient();
    const messageStore = createMockMessageStore({ "777:helpdesk": 100 });
    const useCase = new ProcessTaigaWebhookUseCase(registry, messengerClient, messageStore);

    const result = await useCase.execute(
      changePayload({ change: { diff: { subject: { from: "a", to: "b" } } } }),
    );

    expect(result.updated).toBe(0);
    expect(messengerClient.editMessage).not.toHaveBeenCalled();
  });

  test("event from an unknown project is ignored", async () => {
    const messengerClient = createMockMessengerClient();
    const messageStore = createMockMessageStore({ "777:helpdesk": 100 });
    const useCase = new ProcessTaigaWebhookUseCase(registry, messengerClient, messageStore);

    const result = await useCase.execute(
      changePayload({
        data: {
          id: 777,
          project: { permalink: "https://taiga.test/project/other-project" },
          status: { name: "In progress" },
        },
      }),
    );

    expect(result.updated).toBe(0);
    expect(messengerClient.editMessage).not.toHaveBeenCalled();
  });

  test("item without a tracked message is ignored", async () => {
    const messengerClient = createMockMessengerClient();
    const useCase = new ProcessTaigaWebhookUseCase(registry, messengerClient, createMockMessageStore());

    const result = await useCase.execute(changePayload());

    expect(result.updated).toBe(0);
    expect(messengerClient.editMessage).not.toHaveBeenCalled();
  });
});
