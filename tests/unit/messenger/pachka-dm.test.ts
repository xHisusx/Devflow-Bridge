import { describe, test, expect, mock } from "bun:test";
import {
  PachkaUserDirectory,
  workEmailOf,
} from "../../../src/modules/messenger/application/services/pachka-user-directory";
import { resolvePachkaTarget } from "../../../src/modules/messenger/application/services/resolve-pachka-target";
import { ProcessIntakePipelineUseCase } from "../../../src/modules/plane/application/use-cases/process-intake-pipeline";
import type { IMessengerClient } from "../../../src/modules/messenger/application/ports/messenger-client.port";
import type { IMessageStore } from "../../../src/modules/messenger/application/ports/message-store.port";
import type { IPlaneApiClient } from "../../../src/modules/plane/application/ports/plane-api.port";
import type { PachkaUser } from "../../../src/modules/messenger/domain/entities/message";
import type { Config, PachkaProvider, Provider } from "../../../src/core/config";
import type { Rule } from "../../../src/modules/messenger/domain/entities/notification";
import { ProviderRegistry } from "../../../src/core/provider-registry";

const USERS: PachkaUser[] = [
  {
    id: 101,
    email: "login@corp.test",
    first_name: "Алексей",
    last_name: "Махов",
    custom_properties: [
      { id: 1, name: "Рабочая почта", data_type: "string", value: "a.makhov@example.com" },
    ],
  },
  { id: 102, email: "other@corp.test", custom_properties: [] },
];

function createMockMessengerClient(overrides: Partial<IMessengerClient> = {}): IMessengerClient {
  return {
    sendMessage: mock(() => Promise.resolve({ id: 999 })),
    editMessage: mock(() => Promise.resolve()),
    getUser: mock(() => Promise.resolve(USERS[0])),
    listUsers: mock((opts?: { query?: string }) =>
      // Pachka's `query` searches the login email/name, not custom fields
      Promise.resolve(opts?.query ? USERS.filter((u) => u.email === opts.query) : USERS),
    ),
    deleteMessage: mock(() => Promise.resolve()),
    getMessage: mock(() => Promise.resolve({ id: 1, content: "" })),
    getMessages: mock(() => Promise.resolve([])),
    addReaction: mock(() => Promise.resolve()),
    removeReaction: mock(() => Promise.resolve()),
    getOrCreateThread: mock(() => Promise.resolve({ id: 1, chat_id: 1, message_id: 1 })),
    sendThreadMessage: mock(() => Promise.resolve({ id: 2 })),
    openView: mock(() => Promise.resolve()),
    ...overrides,
  } as IMessengerClient;
}

function createMockMessageStore(): IMessageStore {
  const store = new Map<string, number>();
  return {
    get: mock((id: string, target: string) => store.get(`${id}:${target}`) ?? null),
    set: mock((id: string, target: string, msgId: number) => {
      store.set(`${id}:${target}`, msgId);
    }),
    delete: mock(() => {}),
    getByPachkaMessageId: mock(() => null),
  };
}

describe("workEmailOf", () => {
  test("prefers the work-email custom field over the login email", () => {
    expect(workEmailOf(USERS[0])).toBe("a.makhov@example.com");
  });

  test("falls back to the profile email, then to empty", () => {
    expect(workEmailOf(USERS[1])).toBe("other@corp.test");
    expect(workEmailOf({ id: 3 })).toBe("");
  });
});

describe("PachkaUserDirectory", () => {
  test("finds a user by the work-email custom field and caches the hit", async () => {
    const client = createMockMessengerClient();
    const directory = new PachkaUserDirectory(client);

    expect(await directory.findIdByEmail("A.Makhov@example.com")).toBe(101);
    expect(await directory.findIdByEmail("a.makhov@example.com")).toBe(101);

    // second call served from the cache: only the first lookup hit the API
    expect((client.listUsers as ReturnType<typeof mock>).mock.calls.length).toBe(2); // query + full scan
  });

  test("finds a user whose login email matches via the targeted query", async () => {
    const client = createMockMessengerClient();
    const directory = new PachkaUserDirectory(client);

    expect(await directory.findIdByEmail("other@corp.test")).toBe(102);
    expect(client.listUsers).toHaveBeenCalledWith({ query: "other@corp.test", limit: 20 });
  });

  test("returns null for an unknown email", async () => {
    const directory = new PachkaUserDirectory(createMockMessengerClient());

    expect(await directory.findIdByEmail("nobody@example.com")).toBeNull();
  });

  test("honours a custom work-email field name", async () => {
    const client = createMockMessengerClient({
      listUsers: mock(() =>
        Promise.resolve([
          {
            id: 7,
            custom_properties: [{ id: 2, name: "Work email", data_type: "string", value: "w@x.test" }],
          },
        ]),
      ),
    });
    const directory = new PachkaUserDirectory(client);

    expect(await directory.findIdByEmail("w@x.test", "Work email")).toBe(7);
  });
});

describe("resolvePachkaTarget", () => {
  const dm: PachkaProvider = { type: "pachka", alias: "dev-dm", dm: true };

  test("a chat provider targets its chat as a discussion", async () => {
    const target = await resolvePachkaTarget(
      { type: "pachka", alias: "team", chatId: 555 },
      { message: "hi" },
      {},
      null,
    );
    expect(target).toEqual({ entityId: 555, entityType: "discussion" });
  });

  test("a DM provider resolves the recipient template to a user", async () => {
    const directory = new PachkaUserDirectory(createMockMessengerClient());

    const target = await resolvePachkaTarget(
      dm,
      { message: "hi", recipient: "{{assigneeEmail}}" },
      { assigneeEmail: "a.makhov@example.com" },
      directory,
    );

    expect(target).toEqual({ entityId: 101, entityType: "user" });
  });

  test("a numeric recipient is used as the user id directly", async () => {
    const target = await resolvePachkaTarget(dm, { message: "hi", recipient: "42" }, {}, null);
    expect(target).toEqual({ entityId: 42, entityType: "user" });
  });

  test("an unresolved recipient skips the step", async () => {
    const directory = new PachkaUserDirectory(createMockMessengerClient());

    expect(await resolvePachkaTarget(dm, { message: "hi" }, {}, directory)).toBeNull();
    expect(
      await resolvePachkaTarget(
        dm,
        { message: "hi", recipient: "{{assigneeEmail}}" },
        { assigneeEmail: "nobody@example.com" },
        directory,
      ),
    ).toBeNull();
  });
});

describe("pipeline DM step", () => {
  const PROVIDERS: Provider[] = [
    { type: "api", alias: "intake", endpoint: "/api/intake" },
    { type: "pachka", alias: "dev-dm", dm: true },
  ];

  const DM_RULE: Rule = {
    from: "api:intake",
    to: "pachka:dev-dm",
    on: {
      content: {
        recipient: "{{body.email}}",
        message: "Новая задача: {{body.name}}",
        actions: [{ type: "buttons", buttons: [{ text: "Открыть", url: "https://taiga.test/1" }] }],
      },
    },
  };

  test("sends the message to the person's personal chat", async () => {
    const config: Config = { providers: PROVIDERS, rules: [[DM_RULE]] };
    const client = createMockMessengerClient();
    const pipeline = new ProcessIntakePipelineUseCase(
      config,
      new ProviderRegistry(PROVIDERS),
      new Map<string, IPlaneApiClient>(),
      client,
      createMockMessageStore(),
      new Map(),
      new Map(),
      new PachkaUserDirectory(client),
    );

    const result = await pipeline.execute({
      body: { email: "a.makhov@example.com", name: "Исправить баг" },
    });

    expect(result.ok).toBe(true);
    expect(result.notifications_sent).toBe(1);
    expect(client.sendMessage).toHaveBeenCalledWith(101, "Новая задача: Исправить баг", {
      buttons: [{ text: "Открыть", url: "https://taiga.test/1" }],
      entityType: "user",
    });
  });

  test("an unknown recipient does not send anything", async () => {
    const config: Config = { providers: PROVIDERS, rules: [[DM_RULE]] };
    const client = createMockMessengerClient();
    const pipeline = new ProcessIntakePipelineUseCase(
      config,
      new ProviderRegistry(PROVIDERS),
      new Map<string, IPlaneApiClient>(),
      client,
      createMockMessageStore(),
      new Map(),
      new Map(),
      new PachkaUserDirectory(client),
    );

    const result = await pipeline.execute({ body: { email: "ghost@example.com", name: "X" } });

    expect(result.ok).toBe(false);
    expect(client.sendMessage).not.toHaveBeenCalled();
  });
});
