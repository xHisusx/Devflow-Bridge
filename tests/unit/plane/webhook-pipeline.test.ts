import { describe, test, expect, mock } from "bun:test";
import { ProcessPlaneWebhookUseCase } from "../../../src/modules/plane/application/use-cases/process-plane-webhook";
import type { IMessengerClient } from "../../../src/modules/messenger/application/ports/messenger-client.port";
import type { IMessageStore } from "../../../src/modules/messenger/application/ports/message-store.port";
import type { Config, Provider } from "../../../src/core/config";
import type { Rule } from "../../../src/modules/messenger/domain/entities/notification";
import type { PlaneWebhookPayload } from "../../../src/modules/plane/domain/entities/webhook-payload";
import { ProviderRegistry } from "../../../src/core/provider-registry";

const PROVIDERS: Provider[] = [
  { type: "plane", alias: "dev", baseUrl: "http://plane.test", workspace: "team", project: "Backend" },
  { type: "pachka", alias: "releases", chatId: 111 },
  { type: "pachka", alias: "second", chatId: 222 },
];

const PROJECT_ID = "proj-uuid-1";

function createMockMessengerClient(): IMessengerClient {
  return {
    sendMessage: mock(() => Promise.resolve({ id: 1 })),
    editMessage: mock(() => Promise.resolve()),
    addReaction: mock(() => Promise.resolve()),
    getOrCreateThread: mock(() => Promise.resolve({ id: 1, chat_id: 1, message_id: 1 })),
    sendThreadMessage: mock(() => Promise.resolve({ id: 1000 })),
  } as unknown as IMessengerClient;
}

function createMockMessageStore(): IMessageStore {
  const store = new Map<string, number>();
  return {
    get: mock((issueId: string, target: string) => store.get(`${issueId}:${target}`) ?? null),
    set: mock((issueId: string, target: string, msgId: number) => {
      store.set(`${issueId}:${target}`, msgId);
    }),
    getByPachkaMessageId: mock(() => null),
    delete: mock(() => {}),
  } as unknown as IMessageStore;
}

function makeUseCase(rules: Rule[][], messenger: IMessengerClient, store: IMessageStore) {
  const config: Config = { providers: PROVIDERS, rules };
  const registry = new ProviderRegistry(PROVIDERS);
  return new ProcessPlaneWebhookUseCase(
    config,
    registry,
    messenger,
    store,
    new Map([[`team:Backend`, PROJECT_ID]]),
    new Map([[PROJECT_ID, "DEV"]]),
    new Map(),
  );
}

function payload(overrides: Partial<PlaneWebhookPayload["data"]> = {}): PlaneWebhookPayload {
  return {
    event: "issue",
    action: "updated",
    webhook_id: "wh-1",
    workspace_id: "ws-1",
    activity: { field: "state", old_value: "Todo", new_value: "Review", verb: "updated" },
    data: {
      id: "issue-1",
      name: "Fix the bug",
      state: { id: "s1", name: "Review", color: "#fff", group: "started" },
      priority: "high",
      sequence_id: 7,
      project: PROJECT_ID,
      workspace: "team",
      assignees: [],
      labels: [],
      created_at: "2026-01-01",
      updated_at: "2026-01-01T00:00:00Z",
      ...overrides,
    },
  };
}

describe("ProcessPlaneWebhookUseCase — single-step pipeline (unchanged behavior)", () => {
  test("sends a matching plane-triggered notification with rendered trigger vars", async () => {
    const messenger = createMockMessengerClient();
    const store = createMockMessageStore();
    const rule: Rule = {
      from: "plane:dev",
      to: "pachka:releases",
      on: { action: "update", state: "Review", content: { message: "#{{seq}} {{title}} [{{identifier}}]({{issueUrl}})" } },
    };
    const useCase = makeUseCase([[rule]], messenger, store);

    const result = await useCase.execute({ entity: "issue", action: "updated", payload: payload() });

    expect(result.sent).toBe(1);
    expect(messenger.sendMessage).toHaveBeenCalledWith(
      111,
      "#7 Fix the bug [DEV-7](http://plane.test/team/browse/DEV-7/)",
      { buttons: undefined },
    );
  });

  test("does not send when trigger conditions do not match", async () => {
    const messenger = createMockMessengerClient();
    const store = createMockMessageStore();
    const rule: Rule = {
      from: "plane:dev",
      to: "pachka:releases",
      on: { action: "update", state: "Done", content: { message: "x" } },
    };
    const useCase = makeUseCase([[rule]], messenger, store);

    const result = await useCase.execute({ entity: "issue", action: "updated", payload: payload() });

    expect(result.sent).toBe(0);
    expect(messenger.sendMessage).not.toHaveBeenCalled();
  });
});

describe("ProcessPlaneWebhookUseCase — multi-step pipeline (data flow)", () => {
  test("downstream step reads the upstream notify step's outputs", async () => {
    const messenger = createMockMessengerClient();
    let nextId = 900;
    (messenger.sendMessage as ReturnType<typeof mock>).mockImplementation(() => Promise.resolve({ id: nextId++ }));
    const store = createMockMessageStore();

    const first: Rule = {
      from: "plane:dev",
      to: "pachka:releases",
      on: { action: "update", state: "Review", content: { message: "first {{title}}" } },
    };
    const chained: Rule = {
      from: "pachka:releases",
      to: "pachka:second",
      on: { content: { message: "echo channel={{channel}} msg={{messageId}}" } },
    };
    const useCase = makeUseCase([[first, chained]], messenger, store);

    const result = await useCase.execute({ entity: "issue", action: "updated", payload: payload() });

    expect(result.sent).toBe(2);
    expect(messenger.sendMessage).toHaveBeenLastCalledWith(
      222,
      "echo channel=releases msg=900",
      { buttons: undefined },
    );
  });

  test("whole pipeline is skipped when the trigger step does not match", async () => {
    const messenger = createMockMessengerClient();
    const store = createMockMessageStore();
    const first: Rule = {
      from: "plane:dev",
      to: "pachka:releases",
      on: { action: "update", state: "Done", content: { message: "first" } },
    };
    const chained: Rule = {
      from: "pachka:releases",
      to: "pachka:second",
      on: { content: { message: "echo {{channel}}" } },
    };
    const useCase = makeUseCase([[first, chained]], messenger, store);

    const result = await useCase.execute({ entity: "issue", action: "updated", payload: payload() });

    expect(result.sent).toBe(0);
    expect(messenger.sendMessage).not.toHaveBeenCalled();
  });
});

describe("ProcessPlaneWebhookUseCase — to:plane step (mirror/escalate)", () => {
  test("creates a Plane issue from the event and exposes its outputs downstream", async () => {
    const messenger = createMockMessengerClient();
    const store = createMockMessageStore();

    const mirrorClient = {
      getProjects: mock(() => Promise.resolve([{ id: "mir-proj", name: "Mirror", identifier: "MIR", workspace: "team2" }])),
      getMembers: mock(() => Promise.resolve([])),
      getStates: mock(() => Promise.resolve([])),
      getLabels: mock(() => Promise.resolve([])),
      createIntakeIssue: mock(() => Promise.resolve({ id: "x", issue_id: "mir-1", sequence_id: 9 })),
      getWorkItem: mock(() => Promise.resolve({ id: "mir-1", sequence_id: 9, name: "n" })),
      getUploadCredentials: mock(() => Promise.resolve({ upload_data: { url: "", fields: {} }, asset_id: "a" })),
      uploadToStorage: mock(() => Promise.resolve()),
      completeUpload: mock(() => Promise.resolve()),
      updateWorkItem: mock(() => Promise.resolve()),
    } as unknown as import("../../../src/modules/plane/application/ports/plane-api.port").IPlaneApiClient;

    const providers: Provider[] = [
      { type: "plane", alias: "dev", baseUrl: "http://plane.test", workspace: "team", project: "Backend" },
      { type: "plane", alias: "mirror", baseUrl: "http://mirror.test", workspace: "team2", project: "Mirror" },
      { type: "pachka", alias: "second", chatId: 222 },
    ];
    const registry = new ProviderRegistry(providers);
    const config: Config = {
      providers,
      rules: [[
        { from: "plane:dev", to: "plane:mirror", on: { action: "update", state: "Review", content: { name: "{{title}}" } } },
        { from: "plane:mirror", to: "pachka:second", on: { content: { message: "mirrored: {{issueUrl}}" } } },
      ]],
    };
    const useCase = new ProcessPlaneWebhookUseCase(
      config, registry, messenger, store,
      new Map([["team:Backend", PROJECT_ID]]),
      new Map([[PROJECT_ID, "DEV"]]),
      new Map(),
      new Map([["plane:mirror", mirrorClient]]),
    );

    const result = await useCase.execute({ entity: "issue", action: "updated", payload: payload() });

    expect(mirrorClient.createIntakeIssue).toHaveBeenCalledWith("team2", "mir-proj", { name: "Fix the bug" });
    // only the notify counts as "sent"; the created issue URL flowed downstream
    expect(result.sent).toBe(1);
    expect(messenger.sendMessage).toHaveBeenCalledWith(
      222,
      "mirrored: http://mirror.test/team2/browse/MIR-9/",
      { buttons: undefined },
    );
  });
});
