import { describe, test, expect, mock } from "bun:test";
import {
  extractTaigaFacts,
  matchesTaigaCondition,
  normalizeTaigaEntity,
} from "../../../src/modules/taiga/domain/services/taiga-trigger";
import { ProcessTaigaTriggerUseCase } from "../../../src/modules/taiga/application/use-cases/process-taiga-trigger";
import type { TaigaWebhookPayload } from "../../../src/modules/taiga/domain/entities/taiga-webhook-payload";
import type { ITaigaApiClient } from "../../../src/modules/taiga/application/ports/taiga-api.port";
import type { Config, Provider } from "../../../src/core/config";
import type { Rule } from "../../../src/modules/messenger/domain/entities/notification";
import { ProviderRegistry } from "../../../src/core/provider-registry";

const PROVIDERS: Provider[] = [
  {
    type: "taiga",
    alias: "dev",
    baseUrl: "https://taiga.test",
    project: "dev",
    entity: "user_story",
  },
  { type: "gitlab", alias: "backend", baseUrl: "https://git.test", project: "team/backend" },
];

const registry = new ProviderRegistry(PROVIDERS);

const GITLAB_RULE: Rule = {
  from: "taiga:dev",
  to: "gitlab:backend",
  on: {
    action: "change",
    changed: "assigned_to",
    assigned: "first",
    content: { branch: "feat/{{assigneeInitials}}/{{slug}}", mr: {} },
  },
};

function assignedPayload(overrides: Partial<TaigaWebhookPayload> = {}): TaigaWebhookPayload {
  return {
    action: "change",
    type: "userstory",
    by: { id: 1, full_name: "Project Owner" },
    data: {
      id: 777,
      ref: 42,
      subject: "Исправить баг в отчётах",
      description: "Шаги воспроизведения",
      project: { id: 5, permalink: "https://taiga.test/project/dev", name: "Dev" },
      status: { name: "New" },
      assigned_to: { id: 9, username: "amakhov", full_name: "Алексей Махов" },
      tags: ["backend"],
    },
    change: { diff: { assigned_to: { from: null, to: "Алексей Махов" } } },
    ...overrides,
  };
}

function createMockTaigaClient(): ITaigaApiClient {
  return {
    getProjectBySlug: mock(() => Promise.resolve({ id: 5, slug: "dev", name: "Dev" })),
    createItem: mock(() => Promise.resolve({} as never)),
    getItem: mock(() => Promise.resolve({} as never)),
    getItemStatuses: mock(() => Promise.resolve([])),
    getIssueTypes: mock(() => Promise.resolve([])),
    getPriorities: mock(() => Promise.resolve([])),
    updateItem: mock(() => Promise.resolve()),
    getMemberIdByEmail: mock(() => Promise.resolve(null)),
    getMemberEmailById: mock(() => Promise.resolve("a.makhov@example.com")),
    getCustomAttributes: mock(() => Promise.resolve([])),
    getCustomAttributeValues: mock(() => Promise.resolve({ values: {}, version: 1 })),
    setCustomAttributeValues: mock(() => Promise.resolve()),
  };
}

function makeUseCase(pipeline: Rule[], client: ITaigaApiClient = createMockTaigaClient()) {
  const config: Config = { providers: PROVIDERS, rules: [pipeline] };
  const runner = { run: mock(() => Promise.resolve({ ok: true })) };
  const useCase = new ProcessTaigaTriggerUseCase(
    config,
    registry,
    new Map([["taiga:dev", client]]),
    runner,
  );
  return { useCase, runner, client };
}

describe("normalizeTaigaEntity", () => {
  test("maps Taiga's payload types to provider entity names", () => {
    expect(normalizeTaigaEntity("userstory")).toBe("user_story");
    expect(normalizeTaigaEntity("user_story")).toBe("user_story");
    expect(normalizeTaigaEntity("task")).toBe("task");
    expect(normalizeTaigaEntity("issue")).toBe("issue");
  });
});

describe("matchesTaigaCondition", () => {
  const on = GITLAB_RULE.on;

  test('"first" matches an assignee changing from empty', () => {
    expect(matchesTaigaCondition(on, extractTaigaFacts(assignedPayload()))).toBe(true);
  });

  test('"first" matches an item created with an assignee', () => {
    const facts = extractTaigaFacts(
      assignedPayload({ action: "create", change: undefined }),
    );
    // `changed` cannot match a create event (there is no diff), so check the assignment alone
    expect(matchesTaigaCondition({ assigned: "first", content: { message: "" } }, facts)).toBe(true);
  });

  test('"first" does not match a reassignment', () => {
    const facts = extractTaigaFacts(
      assignedPayload({
        change: { diff: { assigned_to: { from: "Иван Петров", to: "Алексей Махов" } } },
      }),
    );
    expect(matchesTaigaCondition(on, facts)).toBe(false);
  });

  test('"first" does not match an assignee being cleared', () => {
    const facts = extractTaigaFacts(
      assignedPayload({
        data: { ...assignedPayload().data, assigned_to: null },
        change: { diff: { assigned_to: { from: "Алексей Махов", to: null } } },
      }),
    );
    expect(matchesTaigaCondition(on, facts)).toBe(false);
  });

  test("changed filters on the event's diff fields", () => {
    const facts = extractTaigaFacts(
      assignedPayload({ change: { diff: { status: { from: "New", to: "In progress" } } } }),
    );
    expect(matchesTaigaCondition({ changed: "assigned_to", content: { message: "" } }, facts)).toBe(false);
    expect(matchesTaigaCondition({ changed: ["status", "assigned_to"], content: { message: "" } }, facts)).toBe(true);
  });

  test("status, type and priority match case-insensitively", () => {
    const facts = extractTaigaFacts(
      assignedPayload({
        data: {
          ...assignedPayload().data,
          status: { name: "In progress" },
          type: { name: "Ошибка" },
          priority: { name: "High" },
        },
      }),
    );
    expect(matchesTaigaCondition({ status: "in progress", content: { message: "" } }, facts)).toBe(true);
    expect(matchesTaigaCondition({ type: ["Вопрос", "ошибка"], content: { message: "" } }, facts)).toBe(true);
    expect(matchesTaigaCondition({ priority: "low", content: { message: "" } }, facts)).toBe(false);
  });

  test("assigned none/any", () => {
    const assigned = extractTaigaFacts(assignedPayload());
    const unassigned = extractTaigaFacts(
      assignedPayload({ data: { ...assignedPayload().data, assigned_to: null } }),
    );
    expect(matchesTaigaCondition({ assigned: "any", content: { message: "" } }, assigned)).toBe(true);
    expect(matchesTaigaCondition({ assigned: "none", content: { message: "" } }, assigned)).toBe(false);
    expect(matchesTaigaCondition({ assigned: "none", content: { message: "" } }, unassigned)).toBe(true);
  });
});

describe("ProcessTaigaTriggerUseCase", () => {
  test("runs the matching pipeline with trigger outputs, resolving the assignee email", async () => {
    const { useCase, runner, client } = makeUseCase([GITLAB_RULE]);

    const result = await useCase.execute(assignedPayload());

    expect(result.triggered).toBe(1);
    expect(client.getMemberEmailById).toHaveBeenCalledWith(5, 9);

    const [pipeline, outputs] = (runner.run as ReturnType<typeof mock>).mock.calls[0];
    expect(pipeline).toEqual([GITLAB_RULE]);
    expect(outputs).toMatchObject({
      action: "change",
      entity: "user_story",
      issueId: "777",
      issueUrl: "https://taiga.test/project/dev/us/42",
      seq: 42,
      identifier: "#42",
      name: "Исправить баг в отчётах",
      project: "Dev",
      status: "New",
      labels: ["backend"],
      assignee: "Алексей Махов",
      assigneeEmail: "a.makhov@example.com",
      assigneeUsername: "amakhov",
      assigneeInitials: "am",
      slug: "ispravit-bag-v-otchetah",
      author: "Project Owner",
      changedFields: ["assigned_to"],
    });
  });

  test("ignores events from another project", async () => {
    const { useCase, runner } = makeUseCase([GITLAB_RULE]);

    const result = await useCase.execute(
      assignedPayload({
        data: {
          ...assignedPayload().data,
          project: { id: 6, permalink: "https://taiga.test/project/other", name: "Other" },
        },
      }),
    );

    expect(result.triggered).toBe(0);
    expect(runner.run).not.toHaveBeenCalled();
  });

  test("ignores an entity kind the provider is not configured for", async () => {
    const { useCase, runner } = makeUseCase([GITLAB_RULE]);

    // provider entity is user_story; this is an issue event of the same project
    const result = await useCase.execute(assignedPayload({ type: "issue" }));

    expect(result.triggered).toBe(0);
    expect(runner.run).not.toHaveBeenCalled();
  });

  test("an explicit on.entity overrides the provider's entity gate", async () => {
    const rule: Rule = { ...GITLAB_RULE, on: { ...GITLAB_RULE.on, entity: "issue" } };
    const { useCase, runner } = makeUseCase([rule]);

    const result = await useCase.execute(assignedPayload({ type: "issue" }));

    expect(result.triggered).toBe(1);
    expect(runner.run).toHaveBeenCalled();
  });

  test("a repeated delivery of the same event is skipped", async () => {
    const { useCase, runner } = makeUseCase([GITLAB_RULE]);

    await useCase.execute(assignedPayload());
    const second = await useCase.execute(assignedPayload());

    expect(second.triggered).toBe(0);
    expect((runner.run as ReturnType<typeof mock>).mock.calls.length).toBe(1);
  });

  test("test pings and non-matching events do nothing", async () => {
    const { useCase, runner } = makeUseCase([GITLAB_RULE]);

    expect((await useCase.execute({ action: "test", type: "test" })).triggered).toBe(0);
    expect(
      (
        await useCase.execute(
          assignedPayload({ change: { diff: { subject: { from: "a", to: "b" } } } }),
        )
      ).triggered,
    ).toBe(0);
    expect(runner.run).not.toHaveBeenCalled();
  });

  test("a failing pipeline is logged, not thrown", async () => {
    const config: Config = { providers: PROVIDERS, rules: [[GITLAB_RULE]] };
    const useCase = new ProcessTaigaTriggerUseCase(
      config,
      registry,
      new Map([["taiga:dev", createMockTaigaClient()]]),
      { run: mock(() => Promise.reject(new Error("GitLab down"))) },
    );

    const result = await useCase.execute(assignedPayload());

    expect(result.ok).toBe(true);
    expect(result.triggered).toBe(0);
  });
});
