import { describe, test, expect, mock } from "bun:test";
import { ProcessIntakePipelineUseCase } from "../../../src/modules/plane/application/use-cases/process-intake-pipeline";
import { PlaneWriteError } from "../../../src/modules/plane/application/services/create-plane-issue";
import type { IPlaneApiClient } from "../../../src/modules/plane/application/ports/plane-api.port";
import type { IMessengerClient } from "../../../src/modules/messenger/application/ports/messenger-client.port";
import type { IMessageStore } from "../../../src/modules/messenger/application/ports/message-store.port";
import type { Config, Provider } from "../../../src/core/config";
import type { Rule } from "../../../src/modules/messenger/domain/entities/notification";
import { ProviderRegistry } from "../../../src/core/provider-registry";

const MOCK_LABELS = [
  { id: "label-aaa", name: "Bug", color: "#ff0000" },
  { id: "label-bbb", name: "Urgent", color: "#ff8800" },
];

const PROVIDERS: Provider[] = [
  { type: "plane", alias: "dev", baseUrl: "http://plane.test", workspace: "team", project: "Backend" },
  { type: "pachka", alias: "support", chatId: 12345 },
  { type: "api", alias: "intake", endpoint: "/api/plane/intake-issues" },
];

const PLANE_RULE: Rule = {
  from: "api:intake",
  to: "plane:dev",
  on: {
    action: "create",
    entity: "task",
    content: {
      name: "{{body.name}}",
      description: "{{body.description}}",
      labels: "{{body.labels}}",
    },
  },
};

const NOTIFY_RULE: Rule = {
  from: "plane:dev",
  to: "pachka:support",
  on: {
    action: "create",
    entity: "task",
    content: {
      message: "New: {{name}}",
      actions: [{ type: "buttons", buttons: [{ text: "Open", url: "{{issueUrl}}" }] }],
    },
  },
};

function createMockPlaneClient(): IPlaneApiClient {
  return {
    getProjects: mock(() => Promise.resolve([{ id: "proj-1", name: "Backend", identifier: "DEV", workspace: "team" }])),
    getMembers: mock(() => Promise.resolve([])),
    getStates: mock(() => Promise.resolve([])),
    getLabels: mock(() => Promise.resolve(MOCK_LABELS)),
    createIntakeIssue: mock(() => Promise.resolve({ id: "intake-123", issue_id: "issue-456", sequence_id: 42 })),
    getWorkItem: mock(() => Promise.resolve({ id: "issue-456", sequence_id: 42, name: "Test" })),
    getUploadCredentials: mock(() =>
      Promise.resolve({
        upload_data: { url: "http://storage.test/upload", fields: { key: "val" } },
        asset_id: "asset-789",
      }),
    ),
    uploadToStorage: mock(() => Promise.resolve()),
    completeUpload: mock(() => Promise.resolve()),
    updateWorkItem: mock(() => Promise.resolve()),
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
  return {
    providers,
    rules: [pipeline],
  };
}

/** Wrap a single mock Plane client as the per-provider client map (alias "dev"). */
function clients(planeClient: IPlaneApiClient): Map<string, IPlaneApiClient> {
  return new Map([["plane:dev", planeClient]]);
}

const registry = new ProviderRegistry(PROVIDERS);

describe("ProcessIntakePipelineUseCase", () => {
  test("creates issue using content mapping", async () => {
    const planeClient = createMockPlaneClient();
    const config = makeConfig([PLANE_RULE]);
    const pipeline = new ProcessIntakePipelineUseCase(config, registry, clients(planeClient), null, null);

    const result = await pipeline.execute({ body: { name: "Test issue" } });

    expect(result.ok).toBe(true);
    expect(result.id).toBe("intake-123");
    expect(planeClient.createIntakeIssue).toHaveBeenCalledWith("team", "proj-1", { name: "Test issue" });
  });

  test("maps description from body", async () => {
    const planeClient = createMockPlaneClient();
    const config = makeConfig([PLANE_RULE]);
    const pipeline = new ProcessIntakePipelineUseCase(config, registry, clients(planeClient), null, null);

    await pipeline.execute({ body: { name: "Test", description: "<p>Details</p>" } });

    expect(planeClient.createIntakeIssue).toHaveBeenCalledWith("team", "proj-1", {
      name: "Test",
      description_html: "<p>Details</p>",
    });
  });

  test("resolves and assigns labels", async () => {
    const planeClient = createMockPlaneClient();
    const config = makeConfig([PLANE_RULE]);
    const pipeline = new ProcessIntakePipelineUseCase(config, registry, clients(planeClient), null, null);

    await pipeline.execute({ body: { name: "Labeled", labels: ["Bug", "Urgent"] } });

    expect(planeClient.updateWorkItem).toHaveBeenCalledWith("team", "proj-1", "issue-456", {
      labels: ["label-aaa", "label-bbb"],
    });
  });

  test("throws when mapped name is empty", async () => {
    const planeClient = createMockPlaneClient();
    const config = makeConfig([PLANE_RULE]);
    const pipeline = new ProcessIntakePipelineUseCase(config, registry, clients(planeClient), null, null);

    expect(pipeline.execute({ body: {} })).rejects.toThrow("name is required");
  });

  test("throws for unknown labels", async () => {
    const planeClient = createMockPlaneClient();
    const config = makeConfig([PLANE_RULE]);
    const pipeline = new ProcessIntakePipelineUseCase(config, registry, clients(planeClient), null, null);

    expect(pipeline.execute({ body: { name: "Bad", labels: ["NonExistent"] } })).rejects.toThrow(PlaneWriteError);
  });

  test("supports static labels in content", async () => {
    const planeClient = createMockPlaneClient();
    const rule: Rule = {
      ...PLANE_RULE,
      on: { action: "create", entity: "task", content: { name: "{{body.name}}", labels: ["Bug"] } },
    };
    const config = makeConfig([rule]);
    const pipeline = new ProcessIntakePipelineUseCase(config, registry, clients(planeClient), null, null);

    await pipeline.execute({ body: { name: "Static labels" } });

    expect(planeClient.updateWorkItem).toHaveBeenCalledWith("team", "proj-1", "issue-456", {
      labels: ["label-aaa"],
    });
  });

  test("supports field remapping (body.title → name)", async () => {
    const planeClient = createMockPlaneClient();
    const rule: Rule = {
      ...PLANE_RULE,
      on: { action: "create", entity: "task", content: { name: "{{body.title}}", description: "{{body.details}}" } },
    };
    const config = makeConfig([rule]);
    const pipeline = new ProcessIntakePipelineUseCase(config, registry, clients(planeClient), null, null);

    await pipeline.execute({ body: { title: "Remapped", details: "<p>X</p>" } });

    expect(planeClient.createIntakeIssue).toHaveBeenCalledWith("team", "proj-1", {
      name: "Remapped",
      description_html: "<p>X</p>",
    });
  });

  test("sends notification with content.message", async () => {
    const planeClient = createMockPlaneClient();
    const messengerClient = createMockMessengerClient();
    const messageStore = createMockMessageStore();
    const config = makeConfig([PLANE_RULE, NOTIFY_RULE]);
    const pipeline = new ProcessIntakePipelineUseCase(config, registry, clients(planeClient), messengerClient, messageStore);

    const result = await pipeline.execute({ body: { name: "Support request" } });

    expect(result.notifications_sent).toBe(1);
    expect(messengerClient.sendMessage).toHaveBeenCalledWith(
      12345,
      "New: Support request",
      { buttons: [{ text: "Open", url: "http://plane.test/team/browse/DEV-42/" }] },
    );
  });

  test("notification failure does not fail the pipeline", async () => {
    const planeClient = createMockPlaneClient();
    const messengerClient = createMockMessengerClient();
    (messengerClient.sendMessage as ReturnType<typeof mock>).mockImplementation(() => {
      throw new Error("Pachka down");
    });
    const messageStore = createMockMessageStore();
    const notifyRule: Rule = {
      ...NOTIFY_RULE,
      on: { ...NOTIFY_RULE.on, content: { message: "hi" } },
    };
    const config = makeConfig([PLANE_RULE, notifyRule]);
    const pipeline = new ProcessIntakePipelineUseCase(config, registry, clients(planeClient), messengerClient, messageStore);

    const result = await pipeline.execute({ body: { name: "Test" } });

    expect(result.ok).toBe(true);
    expect(result.notifications_sent).toBe(0);
  });

  test("webhook rules in separate pipeline are not triggered", async () => {
    const planeClient = createMockPlaneClient();
    const messengerClient = createMockMessengerClient();
    const messageStore = createMockMessageStore();
    const webhookRule: Rule = {
      from: "plane:dev",
      to: "pachka:support",
      on: { action: "create", content: { message: "webhook msg" } },
    };
    const config: Config = {
      providers: PROVIDERS,
      rules: [
        [PLANE_RULE],     // intake pipeline
        [webhookRule],     // separate webhook pipeline
      ],
    };
    const pipeline = new ProcessIntakePipelineUseCase(config, registry, clients(planeClient), messengerClient, messageStore);

    const result = await pipeline.execute({ body: { name: "Test" } });

    expect(result.ok).toBe(true);
    expect(result.notifications_sent).toBe(0);
    expect(messengerClient.sendMessage).not.toHaveBeenCalled();
  });

  test("notify step exposes its outputs to a downstream notify step", async () => {
    const planeClient = createMockPlaneClient();
    const messengerClient = createMockMessengerClient();
    // distinct message ids per call so we can assert the downstream reads the upstream's
    let nextId = 500;
    (messengerClient.sendMessage as ReturnType<typeof mock>).mockImplementation(() =>
      Promise.resolve({ id: nextId++ }),
    );
    const messageStore = createMockMessageStore();

    const providers: Provider[] = [
      ...PROVIDERS,
      { type: "pachka", alias: "second", chatId: 67890 },
    ];
    const registry2 = new ProviderRegistry(providers);

    const firstNotify: Rule = {
      from: "plane:dev",
      to: "pachka:support",
      on: { content: { message: "first: {{name}}" } },
    };
    const chained: Rule = {
      from: "pachka:support",
      to: "pachka:second",
      on: { content: { message: "echo channel={{channel}} msg={{messageId}}" } },
    };
    const config: Config = { providers, rules: [[PLANE_RULE, firstNotify, chained]] };
    const pipeline = new ProcessIntakePipelineUseCase(config, registry2, clients(planeClient), messengerClient, messageStore);

    const result = await pipeline.execute({ body: { name: "Chained" } });

    expect(result.notifications_sent).toBe(2);
    // downstream step rendered using the upstream pachka step's outputs (channel + messageId)
    expect(messengerClient.sendMessage).toHaveBeenLastCalledWith(
      67890,
      "echo channel=support msg=500",
      { buttons: undefined },
    );
  });

  test("selects the pipeline whose first step matches the given apiRef", async () => {
    const planeClient = createMockPlaneClient();
    const providers: Provider[] = [
      ...PROVIDERS,
      { type: "api", alias: "other", endpoint: "/api/plane/other" },
    ];
    const registry2 = new ProviderRegistry(providers);

    const intakePipelineRule: Rule = {
      from: "api:intake",
      to: "plane:dev",
      on: { action: "create", entity: "task", content: { name: "intake: {{body.name}}" } },
    };
    const otherPipelineRule: Rule = {
      from: "api:other",
      to: "plane:dev",
      on: { action: "create", entity: "task", content: { name: "other: {{body.name}}" } },
    };
    const config: Config = { providers, rules: [[intakePipelineRule], [otherPipelineRule]] };
    const pipeline = new ProcessIntakePipelineUseCase(config, registry2, clients(planeClient), null, null);

    await pipeline.execute({ body: { name: "Hi" } }, "api:other");

    expect(planeClient.createIntakeIssue).toHaveBeenCalledWith("team", "proj-1", { name: "other: Hi" });
  });

  test("returns ok:false when no pipeline matches the apiRef", async () => {
    const planeClient = createMockPlaneClient();
    const config = makeConfig([PLANE_RULE]); // only api:intake pipeline
    const pipeline = new ProcessIntakePipelineUseCase(config, registry, clients(planeClient), null, null);

    const result = await pipeline.execute({ body: { name: "Hi" } }, "api:missing");

    expect(result.ok).toBe(false);
    expect(planeClient.createIntakeIssue).not.toHaveBeenCalled();
  });

  test("uses default intake template when message not specified", async () => {
    const planeClient = createMockPlaneClient();
    const messengerClient = createMockMessengerClient();
    const messageStore = createMockMessageStore();
    const notifyRule: Rule = {
      from: "plane:dev",
      to: "pachka:support",
      on: { content: { message: "" } },
    };
    const config = makeConfig([PLANE_RULE, notifyRule]);
    const pipeline = new ProcessIntakePipelineUseCase(config, registry, clients(planeClient), messengerClient, messageStore);

    await pipeline.execute({ body: { name: "My request" } });

    expect(messengerClient.sendMessage).toHaveBeenCalledWith(
      12345,
      "[Backend] Новая заявка: My request",
      { buttons: undefined },
    );
  });
});
