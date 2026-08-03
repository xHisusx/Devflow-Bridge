import { describe, test, expect, mock } from "bun:test";
import { ProcessIntakePipelineUseCase, IntakePipelineError } from "../../../src/modules/plane/application/use-cases/process-intake-pipeline";
import { TaigaWriteError } from "../../../src/modules/taiga/application/services/create-taiga-issue";
import type { ITaigaApiClient } from "../../../src/modules/taiga/application/ports/taiga-api.port";
import type { IPlaneApiClient } from "../../../src/modules/plane/application/ports/plane-api.port";
import type { IMessengerClient } from "../../../src/modules/messenger/application/ports/messenger-client.port";
import type { IMessageStore } from "../../../src/modules/messenger/application/ports/message-store.port";
import type { Config, Provider } from "../../../src/core/config";
import type { Rule } from "../../../src/modules/messenger/domain/entities/notification";
import { ProviderRegistry } from "../../../src/core/provider-registry";

const PROVIDERS: Provider[] = [
  { type: "taiga", alias: "support", baseUrl: "https://taiga.test", project: "support-desk" },
  { type: "pachka", alias: "helpdesk", chatId: 54321 },
  { type: "api", alias: "intake-support", endpoint: "/api/taiga/intake-support" },
];

const TAIGA_RULE: Rule = {
  from: "api:intake-support",
  to: "taiga:support",
  on: {
    action: "create",
    content: {
      name: "{{body.name}}",
      description: "{{body.description}}",
      labels: "{{body.labels}}",
    },
  },
};

const NOTIFY_RULE: Rule = {
  from: "taiga:support",
  to: "pachka:helpdesk",
  on: {
    action: "create",
    content: {
      message: "New: {{name}}",
      actions: [{ type: "buttons", buttons: [{ text: "Open", url: "{{issueUrl}}" }] }],
    },
  },
};

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
        id: 777, ref: 13, subject: "S", version: 1, status: 1,
        statusName: null, assigneeName: null, typeId: null,
      }),
    ),
    getItemStatuses: mock(() => Promise.resolve([])),
    getIssueTypes: mock(() => Promise.resolve([])),
    updateItem: mock(() => Promise.resolve()),
    getMemberIdByEmail: mock(() => Promise.resolve(null)),
  };
}

function createMockMessengerClient(): IMessengerClient {
  return {
    sendMessage: mock(() => Promise.resolve({ id: 999 })),
    editMessage: mock(() => Promise.resolve()),
    addReaction: mock(() => Promise.resolve()),
    getOrCreateThread: mock(() => Promise.resolve({ id: 1, chat_id: 1, message_id: 1 })),
    sendThreadMessage: mock(() => Promise.resolve({ id: 1000 })),
  };
}

function createMockMessageStore(): IMessageStore {
  const store = new Map<string, number>();
  return {
    get: mock((issueId: string, target: string) => store.get(`${issueId}:${target}`) ?? null),
    set: mock((issueId: string, target: string, msgId: number) => {
      store.set(`${issueId}:${target}`, msgId);
    }),
    getByPachkaMessageId: mock(() => null),
  };
}

function makeConfig(pipeline: Rule[], providers = PROVIDERS): Config {
  return { providers, rules: [pipeline] };
}

const noPlaneClients = new Map<string, IPlaneApiClient>();

/** Wrap a single mock Taiga client as the per-provider client map (alias "support"). */
function clients(taigaClient: ITaigaApiClient): Map<string, ITaigaApiClient> {
  return new Map([["taiga:support", taigaClient]]);
}

const registry = new ProviderRegistry(PROVIDERS);

function makePipeline(
  config: Config,
  taigaClient: ITaigaApiClient,
  messengerClient: IMessengerClient | null = null,
  messageStore: IMessageStore | null = null,
  reg: ProviderRegistry = registry,
) {
  return new ProcessIntakePipelineUseCase(config, reg, noPlaneClients, messengerClient, messageStore, clients(taigaClient));
}

describe("ProcessIntakePipelineUseCase (taiga target)", () => {
  test("creates issue in the slug-resolved project using content mapping", async () => {
    const taigaClient = createMockTaigaClient();
    const pipeline = makePipeline(makeConfig([TAIGA_RULE]), taigaClient);

    const result = await pipeline.execute({ body: { name: "Broken login", description: "Steps..." } });

    expect(result.ok).toBe(true);
    expect(result.id).toBe("777");
    expect(result.issue_id).toBe("777");
    expect(taigaClient.getProjectBySlug).toHaveBeenCalledWith("support-desk");
    expect(taigaClient.createItem).toHaveBeenCalledWith("issue", {
      project: 42,
      subject: "Broken login",
      description: "Steps...",
    });
  });

  test("passes labels as tags", async () => {
    const taigaClient = createMockTaigaClient();
    const pipeline = makePipeline(makeConfig([TAIGA_RULE]), taigaClient);

    await pipeline.execute({ body: { name: "Tagged", labels: ["support", "bug"] } });

    expect(taigaClient.createItem).toHaveBeenCalledWith("issue", {
      project: 42,
      subject: "Tagged",
      tags: ["support", "bug"],
    });
  });

  test("creates the entity kind configured on the provider", async () => {
    const providers: Provider[] = [
      { type: "taiga", alias: "support", baseUrl: "https://taiga.test", project: "support-desk", entity: "user_story" },
      ...PROVIDERS.slice(1),
    ];
    const taigaClient = createMockTaigaClient();
    const pipeline = makePipeline(makeConfig([TAIGA_RULE], providers), taigaClient, null, null, new ProviderRegistry(providers));

    await pipeline.execute({ body: { name: "As a user..." } });

    expect(taigaClient.createItem).toHaveBeenCalledWith("user_story", {
      project: 42,
      subject: "As a user...",
    });
  });

  test("exposes receivedAt to the description template (meta block)", async () => {
    const taigaClient = createMockTaigaClient();
    const rule: Rule = {
      ...TAIGA_RULE,
      on: {
        ...TAIGA_RULE.on,
        content: {
          name: "{{body.name}}",
          description: "{{body.description}}\n\nДата обнаружения: {{receivedAt}}\nАвтор: {{body.email}}",
        },
      },
    };
    const pipeline = makePipeline(makeConfig([rule]), taigaClient);

    await pipeline.execute({ body: { name: "Meta", description: "Text", email: "user@example.com" } });

    const [, payload] = (taigaClient.createItem as ReturnType<typeof mock>).mock.calls[0];
    expect(payload.description).toMatch(
      /^Text\n\nДата обнаружения: \d{2}\.\d{2}\.\d{4} \d{2}:\d{2}\nАвтор: user@example\.com$/,
    );
  });

  test("resolves the requested issue type by name (case-insensitive)", async () => {
    const taigaClient = createMockTaigaClient();
    (taigaClient.getIssueTypes as ReturnType<typeof mock>).mockImplementation(() =>
      Promise.resolve([{ id: 7, name: "Ошибка" }, { id: 8, name: "Вопрос" }]),
    );
    const rule: Rule = {
      ...TAIGA_RULE,
      on: { ...TAIGA_RULE.on, content: { name: "{{body.name}}", type: "{{body.type}}" } },
    };
    const pipeline = makePipeline(makeConfig([rule]), taigaClient);

    await pipeline.execute({ body: { name: "Typed", type: "ошибка" } });

    expect(taigaClient.createItem).toHaveBeenCalledWith("issue", {
      project: 42,
      subject: "Typed",
      typeId: 7,
    });
  });

  test("throws TaigaWriteError for an unknown issue type", async () => {
    const taigaClient = createMockTaigaClient();
    (taigaClient.getIssueTypes as ReturnType<typeof mock>).mockImplementation(() =>
      Promise.resolve([{ id: 7, name: "Ошибка" }]),
    );
    const rule: Rule = {
      ...TAIGA_RULE,
      on: { ...TAIGA_RULE.on, content: { name: "{{body.name}}", type: "{{body.type}}" } },
    };
    const pipeline = makePipeline(makeConfig([rule]), taigaClient);

    expect(pipeline.execute({ body: { name: "Bad", type: "Несуществующий" } })).rejects.toThrow(
      TaigaWriteError,
    );
  });

  test("throws TaigaWriteError when mapped name is empty", async () => {
    const taigaClient = createMockTaigaClient();
    const pipeline = makePipeline(makeConfig([TAIGA_RULE]), taigaClient);

    expect(pipeline.execute({ body: {} })).rejects.toThrow(TaigaWriteError);
  });

  test("throws IntakePipelineError when no client is configured for the provider", async () => {
    const config = makeConfig([TAIGA_RULE]);
    const pipeline = new ProcessIntakePipelineUseCase(config, registry, noPlaneClients, null, null);

    expect(pipeline.execute({ body: { name: "Hi" } })).rejects.toThrow(IntakePipelineError);
  });

  test("notifies Pachka using the taiga step outputs", async () => {
    const taigaClient = createMockTaigaClient();
    const messengerClient = createMockMessengerClient();
    const messageStore = createMockMessageStore();
    const pipeline = makePipeline(makeConfig([TAIGA_RULE, NOTIFY_RULE]), taigaClient, messengerClient, messageStore);

    const result = await pipeline.execute({ body: { name: "Support request" } });

    expect(result.notifications_sent).toBe(1);
    expect(messengerClient.sendMessage).toHaveBeenCalledWith(
      54321,
      "New: Support request",
      { buttons: [{ text: "Open", url: "https://taiga.test/project/support-desk/issue/13" }] },
    );
  });

  test("respects the outputs declaration between steps", async () => {
    const taigaClient = createMockTaigaClient();
    const messengerClient = createMockMessengerClient();
    const messageStore = createMockMessageStore();
    const taigaRule: Rule = {
      ...TAIGA_RULE,
      on: { ...TAIGA_RULE.on, outputs: ["name"] },
    };
    const notifyRule: Rule = {
      ...NOTIFY_RULE,
      on: { ...NOTIFY_RULE.on, content: { message: "{{name}} url={{issueUrl}}" } },
    };
    const pipeline = makePipeline(makeConfig([taigaRule, notifyRule]), taigaClient, messengerClient, messageStore);

    await pipeline.execute({ body: { name: "Narrowed" } });

    // issueUrl is not exposed by the upstream step, so it renders empty
    expect(messengerClient.sendMessage).toHaveBeenCalledWith(54321, "Narrowed url=", { buttons: undefined });
  });
});
