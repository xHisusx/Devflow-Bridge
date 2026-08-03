import { describe, test, expect, mock } from "bun:test";
import { HandleTaigaFeedbackUseCase } from "../../../src/modules/taiga/application/use-cases/handle-taiga-feedback";
import type { ITaigaApiClient } from "../../../src/modules/taiga/application/ports/taiga-api.port";
import type { IMessengerClient } from "../../../src/modules/messenger/application/ports/messenger-client.port";
import type { Config, Provider } from "../../../src/core/config";
import { ProviderRegistry } from "../../../src/core/provider-registry";

const PROVIDERS: Provider[] = [
  {
    type: "taiga",
    alias: "support",
    baseUrl: "https://taiga.test",
    project: "support-desk",
    feedback: {
      statuses: {
        accept: "In progress",
        pause: "On pause",
        close: "Closed",
        resume: "In progress",
      },
      buttons: {
        "In progress": [
          { text: "⏹️ Поставить на паузу", action: "pause" },
          { text: "✅ Завершить", action: "close" },
        ],
        "On pause": [{ text: "🚀 Возобновить", action: "resume" }],
      },
      statusLabels: { "In progress": "В процессе 🚀" },
      workEmailField: "Рабочая почта",
    },
  },
  { type: "pachka", alias: "helpdesk", chatId: 54321 },
];

const STATUSES = [
  { id: 1, name: "New" },
  { id: 2, name: "In progress" },
  { id: 3, name: "On pause" },
  { id: 4, name: "Closed" },
];

function createMockTaigaClient(): ITaigaApiClient {
  return {
    getProjectBySlug: mock(() =>
      Promise.resolve({ id: 42, slug: "support-desk", name: "Support Desk" }),
    ),
    createItem: mock(() =>
      Promise.resolve({
        id: 777, ref: 13, subject: "S", description: "", tags: [],
        status: null, statusName: null, typeId: null,
      }),
    ),
    getItem: mock(() =>
      Promise.resolve({
        id: 777, ref: 13, subject: "Broken login", version: 5, status: 1,
        statusName: "In progress", assigneeName: "Иван Петров", typeId: 7,
      }),
    ),
    getItemStatuses: mock(() => Promise.resolve(STATUSES)),
    getIssueTypes: mock(() => Promise.resolve([{ id: 7, name: "Ошибка" }])),
    updateItem: mock(() => Promise.resolve()),
    getMemberIdByEmail: mock(() => Promise.resolve(314)),
  };
}

function createMockMessengerClient(): IMessengerClient {
  return {
    sendMessage: mock(() => Promise.resolve({ id: 999 })),
    editMessage: mock(() => Promise.resolve()),
    addReaction: mock(() => Promise.resolve()),
    getOrCreateThread: mock(() => Promise.resolve({ id: 1, chat_id: 1, message_id: 1 })),
    sendThreadMessage: mock(() => Promise.resolve({ id: 1000 })),
    getMessage: mock(() => Promise.resolve({ id: 100, content: "original text" })),
    getUser: mock(() =>
      Promise.resolve({
        id: 9,
        email: "profile@example.com",
        custom_properties: [
          { id: 1, name: "Рабочая почта", data_type: "string", value: "dev@example.com" },
        ],
      }),
    ),
  };
}

const registry = new ProviderRegistry(PROVIDERS);

function makeUseCase(taigaClient: ITaigaApiClient, messengerClient: IMessengerClient | null) {
  return new HandleTaigaFeedbackUseCase(
    registry,
    new Map([["taiga:support", taigaClient]]),
    messengerClient,
  );
}

describe("HandleTaigaFeedbackUseCase", () => {
  test("matches() detects taiga callback data", () => {
    expect(HandleTaigaFeedbackUseCase.matches("taiga:support:accept:777")).toBe(true);
    expect(HandleTaigaFeedbackUseCase.matches("other:data")).toBe(false);
    expect(HandleTaigaFeedbackUseCase.matches(undefined)).toBe(false);
  });

  test("accept: moves item to In progress and assigns the clicker by work email", async () => {
    const taigaClient = createMockTaigaClient();
    const messengerClient = createMockMessengerClient();
    const useCase = makeUseCase(taigaClient, messengerClient);

    const result = await useCase.execute({
      data: "taiga:support:accept:777",
      pachkaUserId: 9,
      messageId: 100,
    });

    expect(result.ok).toBe(true);
    expect(result.status).toBe("In progress");
    expect(taigaClient.getMemberIdByEmail).toHaveBeenCalledWith(42, "dev@example.com");
    expect(taigaClient.updateItem).toHaveBeenCalledWith(
      "issue",
      777,
      { status: 2, assigned_to: 314 },
      5,
    );
  });

  test("accept: swaps message buttons to the In progress set", async () => {
    const taigaClient = createMockTaigaClient();
    const messengerClient = createMockMessengerClient();
    const useCase = makeUseCase(taigaClient, messengerClient);

    await useCase.execute({ data: "taiga:support:accept:777", pachkaUserId: 9, messageId: 100 });

    expect(messengerClient.editMessage).toHaveBeenCalledWith(100, "original text", {
      buttons: [
        { text: "⏹️ Поставить на паузу", data: "taiga:support:pause:777" },
        { text: "✅ Завершить", data: "taiga:support:close:777" },
      ],
    });
  });

  test("close: changes status without assignment and clears buttons", async () => {
    const taigaClient = createMockTaigaClient();
    const messengerClient = createMockMessengerClient();
    const useCase = makeUseCase(taigaClient, messengerClient);

    const result = await useCase.execute({
      data: "taiga:support:close:777",
      pachkaUserId: 9,
      messageId: 100,
    });

    expect(result.ok).toBe(true);
    expect(messengerClient.getUser).not.toHaveBeenCalled();
    expect(taigaClient.updateItem).toHaveBeenCalledWith("issue", 777, { status: 4 }, 5);
    expect(messengerClient.editMessage).toHaveBeenCalledWith(100, "original text", { buttons: [] });
  });

  test("falls back to profile email when the custom field is missing", async () => {
    const taigaClient = createMockTaigaClient();
    const messengerClient = createMockMessengerClient();
    (messengerClient.getUser as ReturnType<typeof mock>).mockImplementation(() =>
      Promise.resolve({ id: 9, email: "profile@example.com", custom_properties: [] }),
    );
    const useCase = makeUseCase(taigaClient, messengerClient);

    await useCase.execute({ data: "taiga:support:accept:777", pachkaUserId: 9 });

    expect(taigaClient.getMemberIdByEmail).toHaveBeenCalledWith(42, "profile@example.com");
  });

  test("still applies the transition when no Taiga member matches the email", async () => {
    const taigaClient = createMockTaigaClient();
    (taigaClient.getMemberIdByEmail as ReturnType<typeof mock>).mockImplementation(() =>
      Promise.resolve(null),
    );
    const messengerClient = createMockMessengerClient();
    const useCase = makeUseCase(taigaClient, messengerClient);

    const result = await useCase.execute({ data: "taiga:support:accept:777", pachkaUserId: 9 });

    expect(result.ok).toBe(true);
    expect(taigaClient.updateItem).toHaveBeenCalledWith("issue", 777, { status: 2 }, 5);
  });

  test("unknown action is rejected without touching Taiga", async () => {
    const taigaClient = createMockTaigaClient();
    const useCase = makeUseCase(taigaClient, createMockMessengerClient());

    const result = await useCase.execute({ data: "taiga:support:explode:777" });

    expect(result.ok).toBe(false);
    expect(taigaClient.updateItem).not.toHaveBeenCalled();
  });

  test("re-renders the message from the pipeline rule template after a transition", async () => {
    const taigaClient = createMockTaigaClient();
    const messengerClient = createMockMessengerClient();
    const messageStore = {
      get: mock(() => 100),
      set: mock(() => {}),
      delete: mock(() => {}),
      getByPachkaMessageId: mock(() => ({ correlationId: "777", target: "helpdesk" })),
    };
    const config: Config = {
      providers: PROVIDERS,
      rules: [[
        {
          from: "taiga:support",
          to: "pachka:helpdesk",
          on: {
            content: {
              message: "🔔 [{{name}}]({{issueUrl}})\n💥 {{type}}\n🦸‍♂️ {{assignee}}\n📋 {{status}}",
            },
          },
        },
      ]],
    };
    const useCase = new HandleTaigaFeedbackUseCase(
      registry,
      new Map([["taiga:support", taigaClient]]),
      messengerClient,
      config,
      messageStore,
    );

    await useCase.execute({ data: "taiga:support:accept:777", pachkaUserId: 9, messageId: 100 });

    expect(messengerClient.editMessage).toHaveBeenCalledWith(
      100,
      "🔔 [Broken login](https://taiga.test/project/support-desk/issue/13)\n💥 Ошибка\n🦸‍♂️ Иван Петров\n📋 В процессе 🚀",
      {
        buttons: [
          { text: "⏹️ Поставить на паузу", data: "taiga:support:pause:777" },
          { text: "✅ Завершить", data: "taiga:support:close:777" },
        ],
      },
    );
    // content came from the template, not from the old message
    expect(messengerClient.getMessage).not.toHaveBeenCalled();
  });

  test("unknown status name is rejected without patching", async () => {
    const taigaClient = createMockTaigaClient();
    (taigaClient.getItemStatuses as ReturnType<typeof mock>).mockImplementation(() =>
      Promise.resolve([{ id: 1, name: "Somewhere else" }]),
    );
    const useCase = makeUseCase(taigaClient, createMockMessengerClient());

    const result = await useCase.execute({ data: "taiga:support:accept:777" });

    expect(result.ok).toBe(false);
    expect(taigaClient.updateItem).not.toHaveBeenCalled();
  });
});
