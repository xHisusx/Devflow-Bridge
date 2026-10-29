import { describe, test, expect, mock } from "bun:test";
import {
  extractTaigaFacts,
  matchesTaigaCondition,
  milestoneName,
  normalizeTags,
} from "../../../src/modules/taiga/domain/services/taiga-trigger";
import { ProcessTaigaTriggerUseCase } from "../../../src/modules/taiga/application/use-cases/process-taiga-trigger";
import { ProviderRegistry } from "../../../src/core/provider-registry";
import type { Config, Provider } from "../../../src/core/config";
import type { Rule } from "../../../src/modules/messenger/domain/entities/notification";
import type { TaigaWebhookPayload } from "../../../src/modules/taiga/domain/entities/taiga-webhook-payload";
import { taigaClientMock } from "../../mocks";

/**
 * Taiga *tasks* as the trigger: the shapes here mirror a real `task:change` payload — the parent
 * user story is serialized inline, and that is where a task's sprint comes from.
 */

function taskPayload(over: {
  sprint?: unknown;
  usSprint?: unknown;
  assignedTo?: unknown;
  diff?: Record<string, unknown>;
  tags?: string[];
} = {}): TaigaWebhookPayload {
  return {
    action: "change",
    type: "task",
    by: { id: 7, full_name_display: "Алексей Махов" },
    data: {
      id: 827,
      ref: 270,
      subject: "Исправить расчёт НМЦК при пустом справочнике",
      permalink: "https://tasks.test/project/med-20/task/270",
      project: { id: 19, permalink: "https://tasks.test/project/med-20", name: "Med-2.0" },
      status: { id: 94, name: "To do" },
      assigned_to:
        over.assignedTo === undefined
          ? { id: 27, username: "konovnitsyndi", full_name_display: "Данила Коновницын" }
          : (over.assignedTo as TaigaWebhookPayload["data"] extends infer _ ? never : never),
      tags: over.tags ?? [],
      milestone: over.sprint ?? null,
      user_story: {
        id: 681,
        ref: 250,
        subject: "ЭФ: формирование PDF-формы расчёта НМЦК",
        permalink: "https://tasks.test/project/med-20/us/250",
        milestone: over.usSprint ?? null,
      },
    },
    change: { diff: over.diff ?? { assigned_to: { from: null, to: "Данила Коновницын" } } },
  };
}

describe("task facts", () => {
  test("the sprint comes from the parent user story when the task has none of its own", () => {
    const facts = extractTaigaFacts(
      taskPayload({ usSprint: { id: 92, name: "Спринт 12", slug: "sprint-12-2" } }),
    );

    expect(facts.entity).toBe("task");
    expect(facts.sprint).toBe("Спринт 12");
    expect(facts.hasSprint).toBe(true);
    expect(facts.firstAssignment).toBe(true);
  });

  test("the task's own sprint wins", () => {
    const facts = extractTaigaFacts(
      taskPayload({ sprint: { name: "Спринт 13" }, usSprint: { name: "Спринт 12" } }),
    );

    expect(facts.sprint).toBe("Спринт 13");
  });

  test("no sprint anywhere reads as not planned", () => {
    const facts = extractTaigaFacts(taskPayload());

    expect(facts.sprint).toBe("");
    expect(facts.hasSprint).toBe(false);
  });

  test("milestoneName copes with an object, a bare id and null", () => {
    expect(milestoneName({ id: 92, name: "Спринт 12" })).toBe("Спринт 12");
    expect(milestoneName({ id: 92, slug: "sprint-12-2" })).toBe("sprint-12-2");
    expect(milestoneName(92)).toBe("92");
    expect(milestoneName(null)).toBe("");
    expect(milestoneName(undefined)).toBe("");
  });
});

describe("the sprint condition", () => {
  const planned = extractTaigaFacts(taskPayload({ usSprint: { name: "Спринт 12" } }));
  const unplanned = extractTaigaFacts(taskPayload());

  test('"any" keeps only tasks whose story is in a sprint', () => {
    expect(matchesTaigaCondition({ sprint: "any", content: {} }, planned)).toBe(true);
    expect(matchesTaigaCondition({ sprint: "any", content: {} }, unplanned)).toBe(false);
  });

  test('"none" is the mirror image', () => {
    expect(matchesTaigaCondition({ sprint: "none", content: {} }, unplanned)).toBe(true);
    expect(matchesTaigaCondition({ sprint: "none", content: {} }, planned)).toBe(false);
  });

  test("a name (or a list) pins the pipeline to that sprint", () => {
    expect(matchesTaigaCondition({ sprint: "Спринт 12", content: {} }, planned)).toBe(true);
    expect(matchesTaigaCondition({ sprint: "спринт 12", content: {} }, planned)).toBe(true);
    expect(matchesTaigaCondition({ sprint: ["Спринт 12", "Спринт 13"], content: {} }, planned)).toBe(true);
    expect(matchesTaigaCondition({ sprint: "Спринт 13", content: {} }, planned)).toBe(false);
  });

  test("without the condition both kinds of task pass", () => {
    expect(matchesTaigaCondition({ assigned: "first", content: {} }, planned)).toBe(true);
    expect(matchesTaigaCondition({ assigned: "first", content: {} }, unplanned)).toBe(true);
  });
});

describe("parent user story in the trigger outputs", () => {
  const PROVIDERS: Provider[] = [
    {
      type: "taiga",
      alias: "med2",
      baseUrl: "https://tasks.test",
      project: "med-20",
      entity: "task",
    },
    { type: "gitlab", alias: "med2", baseUrl: "https://git.test", project: "wonder-tist/med-2.0" },
  ];

  const PIPELINE: Rule[] = [
    {
      from: "taiga:med2",
      to: "gitlab:med2",
      on: {
        action: "change",
        assigned: "first",
        sprint: "any",
        content: { branch: "{{branchType}}/{{assigneeInitials}}/{{slug}}" },
      },
    },
  ];

  function run(payload: TaigaWebhookPayload, pipeline: Rule[] = PIPELINE) {
    const config: Config = { providers: PROVIDERS, rules: [pipeline] };
    const seen: Record<string, unknown>[] = [];
    const runner = {
      run: mock((_p: Rule[], outputs: Record<string, unknown>) => {
        seen.push(outputs);
        return Promise.resolve(null);
      }),
    };
    const taiga = taigaClientMock({
      getMemberEmailById: mock(() => Promise.resolve("konovnitsyndi@develop.mos.ru")),
    });
    const useCase = new ProcessTaigaTriggerUseCase(
      config,
      new ProviderRegistry(PROVIDERS),
      new Map([["taiga:med2", taiga]]),
      runner,
    );
    return useCase.execute(payload).then((r) => ({ result: r, outputs: seen[0] }));
  }

  test("a planned task fires and exposes both the task and its story", async () => {
    const { result, outputs } = await run(
      taskPayload({ usSprint: { id: 92, name: "Спринт 12" } }),
    );

    expect(result.triggered).toBe(1);
    expect(outputs).toMatchObject({
      entity: "task",
      issueId: "827",
      seq: 270,
      identifier: "#270",
      name: "Исправить расчёт НМЦК при пустом справочнике",
      issueUrl: "https://tasks.test/project/med-20/task/270",
      sprint: "Спринт 12",
      parentId: "681",
      parentSeq: 250,
      parentIdentifier: "#250",
      parentName: "ЭФ: формирование PDF-формы расчёта НМЦК",
      parentUrl: "https://tasks.test/project/med-20/us/250",
      assignee: "Данила Коновницын",
      assigneeEmail: "konovnitsyndi@develop.mos.ru",
      assigneeInitials: "dk",
      slug: "ispravit-raschet-nmck-pri-pustom-spravochnike",
    });
  });

  test("a task outside a sprint does not fire", async () => {
    const { result } = await run(taskPayload());

    expect(result.triggered).toBe(0);
  });

  test("the tag gate keeps the pipeline to code tasks", async () => {
    const tagged: Rule[] = [
      { ...PIPELINE[0]!, on: { ...PIPELINE[0]!.on, tags: ["фронт", "бэк", "ядро", "прокси"] } },
    ];
    const sprint = { usSprint: { id: 92, name: "Спринт 12" } };

    expect((await run(taskPayload({ ...sprint, tags: ["прокси"] }), tagged)).result.triggered).toBe(1);
    // design and analysis tasks live in the same sprint and must be left alone
    expect((await run(taskPayload({ ...sprint, tags: ["дизайн"] }), tagged)).result.triggered).toBe(0);
    expect((await run(taskPayload(sprint), tagged)).result.triggered).toBe(0);
  });
});

describe("the tags condition", () => {
  const proxy = extractTaigaFacts(taskPayload({ tags: ["прокси", "срочно"] }));
  const untagged = extractTaigaFacts(taskPayload());

  test("tags reach the facts, in both shapes Taiga uses", () => {
    expect(proxy.tags).toEqual(["прокси", "срочно"]);
    expect(normalizeTags([["прокси", "#ff0000"], ["баг", null]])).toEqual(["прокси", "баг"]);
    expect(normalizeTags(null)).toEqual([]);
  });

  test("any listed tag is enough, case-insensitively", () => {
    expect(matchesTaigaCondition({ tags: ["фронт", "прокси"], content: {} }, proxy)).toBe(true);
    expect(matchesTaigaCondition({ tags: "ПРОКСИ", content: {} }, proxy)).toBe(true);
  });

  test("an item without any of the tags is not this pipeline's business", () => {
    expect(matchesTaigaCondition({ tags: ["фронт", "бэк"], content: {} }, proxy)).toBe(false);
    expect(matchesTaigaCondition({ tags: ["прокси"], content: {} }, untagged)).toBe(false);
  });

  test("without the condition tags are ignored", () => {
    expect(matchesTaigaCondition({ content: {} }, untagged)).toBe(true);
  });
});
