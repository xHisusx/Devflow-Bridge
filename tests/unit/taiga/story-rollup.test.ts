import { describe, test, expect, mock } from "bun:test";
import { storyTaskProgress } from "../../../src/modules/taiga/application/services/story-progress";
import { ProcessTaigaTriggerUseCase } from "../../../src/modules/taiga/application/use-cases/process-taiga-trigger";
import { ProcessTaigaWebhookUseCase } from "../../../src/modules/taiga/application/use-cases/process-taiga-webhook";
import { HandleTaigaFeedbackUseCase } from "../../../src/modules/taiga/application/use-cases/handle-taiga-feedback";
import { ProcessIntakePipelineUseCase } from "../../../src/modules/plane/application/use-cases/process-intake-pipeline";
import { ProviderRegistry } from "../../../src/core/provider-registry";
import type { Config, Provider } from "../../../src/core/config";
import type { Rule } from "../../../src/modules/messenger/domain/entities/notification";
import type { TaigaWebhookPayload } from "../../../src/modules/taiga/domain/entities/taiga-webhook-payload";
import type { TaigaTaskSummary } from "../../../src/modules/taiga/application/ports/taiga-api.port";
import { messageStoreMock, messengerClientMock, pachkaMessage, taigaClientMock } from "../../mocks";

/**
 * Handing a user story over to the testers: a task moving to "Ready for Test" is progress, while
 * the *last* such task is what makes the story itself testable end to end. So the story is rolled
 * up to "Testing" and announced in the testers' channel, which carries buttons of its own.
 *
 * The statuses mirror the real Med-2.0 project, where tasks and stories have separate sets.
 */

const TASK_STATUSES = [
  { id: 93, name: "To do" },
  { id: 94, name: "In Progress" },
  { id: 97, name: "Review" },
  { id: 98, name: "Ready for Test" },
  { id: 96, name: "Done" },
];

const STORY_STATUSES = [
  { id: 110, name: "New" },
  { id: 112, name: "In Progress" },
  { id: 207, name: "Testing" },
  { id: 114, name: "Done" },
];

function task(id: number, status: number): TaigaTaskSummary {
  return { id, ref: id, subject: "task " + id, status, isClosed: status === 96 };
}

function storyClient(tasks: TaigaTaskSummary[]) {
  return taigaClientMock({
    getTasksOfUserStory: mock(() => Promise.resolve(tasks)),
    getItemStatuses: mock(() => Promise.resolve(TASK_STATUSES)),
  });
}

describe("storyTaskProgress", () => {
  test("a story is complete only once every one of its tasks is finished", async () => {
    const client = storyClient([task(1, 98), task(2, 98), task(3, 98)]);

    const progress = await storyTaskProgress(client, 19, 681, ["Ready for Test"]);

    expect(progress).toEqual({ total: 3, done: 3, complete: true });
  });

  test("one sibling still in progress leaves the story unfinished", async () => {
    const client = storyClient([task(1, 98), task(2, 94), task(3, 98)]);

    const progress = await storyTaskProgress(client, 19, 681, ["Ready for Test"]);

    expect(progress).toEqual({ total: 3, done: 2, complete: false });
  });

  test("a task finished earlier counts when its status is listed", async () => {
    const client = storyClient([task(1, 98), task(2, 96)]);

    // without "Done" on the list a story holding one closed task could never roll up
    expect(await storyTaskProgress(client, 19, 681, ["Ready for Test", "Done"])).toMatchObject({
      complete: true,
    });
    expect(await storyTaskProgress(client, 19, 681, ["Ready for Test"])).toMatchObject({
      complete: false,
      done: 1,
    });
  });

  test("a status name need not be spelled the way the project spells it", async () => {
    const client = storyClient([task(1, 98)]);

    expect(await storyTaskProgress(client, 19, 681, ["ready for test"])).toMatchObject({
      complete: true,
    });
  });

  test("a story with no tasks is never complete", async () => {
    const client = storyClient([]);

    const progress = await storyTaskProgress(client, 19, 681, ["Ready for Test"]);

    expect(progress).toEqual({ total: 0, done: 0, complete: false });
    expect(client.getItemStatuses).not.toHaveBeenCalled();
  });
});

// ── The roll-up as a trigger condition ──

const PROVIDERS: Provider[] = [
  {
    type: "taiga",
    alias: "med2",
    baseUrl: "https://tasks.test",
    project: "med-20",
    entity: "task",
    feedback: {
      statuses: { accept: "In Progress", ready: "Ready for Test", close: "Done" },
      buttons: { "In Progress": [{ text: "🧪 Готово к тесту", action: "ready" }] },
    },
  },
  {
    type: "taiga",
    alias: "med2-us",
    baseUrl: "https://tasks.test",
    project: "med-20",
    entity: "user_story",
    feedback: {
      statuses: { rework: "In Progress", close: "Done" },
      statusLabels: { Testing: "Тестирование 🧪", "In Progress": "В работе 🚀" },
    },
  },
  { type: "pachka", alias: "med2-team", chatId: 45922080 },
  { type: "pachka", alias: "med2-testing", chatId: 45932414 },
];

const ROLLUP: Rule[] = [
  {
    from: "taiga:med2",
    to: "taiga:med2-us",
    on: {
      entity: "task",
      changed: "status",
      status: "Ready for Test",
      allTasks: ["Ready for Test", "Done"],
      content: { item: "{{parentId}}", status: "Testing" },
    },
  },
];

function taskPayload(status = "Ready for Test"): TaigaWebhookPayload {
  return {
    action: "change",
    type: "task",
    by: { id: 27, full_name_display: "Данила Коновницын" },
    data: {
      id: 827,
      ref: 270,
      subject: "Исправить расчёт НМЦК при пустом справочнике",
      project: { id: 19, permalink: "https://tasks.test/project/med-20", name: "Med-2.0" },
      status: { name: status },
      assigned_to: { id: 27, full_name_display: "Данила Коновницын" },
      user_story: {
        id: 681,
        ref: 250,
        subject: "ЭФ: формирование PDF-формы расчёта НМЦК",
        permalink: "https://tasks.test/project/med-20/us/250",
      },
    },
    change: { diff: { status: { from: "In Progress", to: status } } },
  };
}

function runTrigger(
  payload: TaigaWebhookPayload,
  tasks: TaigaTaskSummary[],
  pipelines: Rule[][] = [ROLLUP],
) {
  const config: Config = { providers: PROVIDERS, rules: pipelines };
  const seen: Record<string, unknown>[] = [];
  const runner = {
    run: mock((_p: Rule[], outputs: Record<string, unknown>) => {
      seen.push(outputs);
      return Promise.resolve(null);
    }),
  };
  const client = storyClient(tasks);
  const useCase = new ProcessTaigaTriggerUseCase(
    config,
    new ProviderRegistry(PROVIDERS),
    new Map([
      ["taiga:med2", client],
      ["taiga:med2-us", client],
    ]),
    runner,
  );
  return useCase.execute(payload).then((result) => ({ result, outputs: seen[0], client }));
}

describe("allTasks roll-up gate", () => {
  test("the last task of the story starts the pipeline", async () => {
    const { result, outputs, client } = await runTrigger(taskPayload(), [
      task(1, 98),
      task(2, 96),
      task(827, 98),
    ]);

    expect(result.triggered).toBe(1);
    // the step writes to the story, so the story has to be addressable from the trigger
    expect(outputs).toMatchObject({ parentId: "681", parentSeq: 250, issueId: "827" });
    expect(client.getTasksOfUserStory).toHaveBeenCalledWith(681);
  });

  test("while a sibling is unfinished the story stays where it is", async () => {
    const { result } = await runTrigger(taskPayload(), [task(1, 94), task(827, 98)]);

    expect(result.triggered).toBe(0);
  });

  test("a task with no parent story cannot roll anything up", async () => {
    const payload = taskPayload();
    payload.data!.user_story = null;

    const { result, client } = await runTrigger(payload, [task(827, 98)]);

    expect(result.triggered).toBe(0);
    expect(client.getTasksOfUserStory).not.toHaveBeenCalled();
  });

  test("an event the cheap conditions reject costs no API call", async () => {
    const { result, client } = await runTrigger(taskPayload("Review"), [task(827, 98)]);

    expect(result.triggered).toBe(0);
    expect(client.getTasksOfUserStory).not.toHaveBeenCalled();
  });
});

// ── Taking a task back into work hands the story back ──

/**
 * The mirror image of the roll-up, and what makes it repeatable: while the story sits in testing,
 * a task re-entering work means the story is no longer testable, so it goes back to the
 * developers. Without this the story would stay in "Testing" for good and finishing that task
 * again would move nothing — leaving the testers with no new card (`parentStatus` guards it).
 */
const REOPEN: Rule[] = [
  {
    from: "taiga:med2",
    to: "taiga:med2-us",
    on: {
      entity: "task",
      changed: "status",
      status: ["To do", "In Progress", "Pause", "Review"],
      parentStatus: "Testing",
      content: { item: "{{parentId}}", status: "In Progress" },
    },
  },
];

function reopen(taskStatus: string, storyStatus: string | null) {
  const payload = taskPayload(taskStatus);
  if (storyStatus === null) payload.data!.user_story = null;
  else payload.data!.user_story!.status = { name: storyStatus };
  return runTrigger(payload, [], [REOPEN]);
}

describe("parentStatus gate", () => {
  test("a task re-entering work takes its story out of testing", async () => {
    const { result, outputs } = await reopen("In Progress", "Testing");

    expect(result.triggered).toBe(1);
    // the step writes to the story, so the story has to be addressable from the task's event
    expect(outputs).toMatchObject({ parentId: "681", entity: "task", status: "In Progress" });
  });

  test("a story that is not in testing is left where it is", async () => {
    // a task moving around while the story is still being built is ordinary progress, and
    // rewriting the story's status on every such move would comment on it each time
    expect((await reopen("In Progress", "In Progress")).result.triggered).toBe(0);
    expect((await reopen("Review", "New")).result.triggered).toBe(0);
  });

  test("a task finished rather than reopened does not concern the story", async () => {
    expect((await reopen("Ready for Test", "Testing")).result.triggered).toBe(0);
  });

  test("a task with no story has no parent status to match", async () => {
    expect((await reopen("In Progress", null)).result.triggered).toBe(0);
  });
});

// ── The card in the testers' channel ──

const STUB = "⤵️ Карточка устарела — актуальная ниже";

const TESTERS_CARD: Rule[] = [
  {
    from: "taiga:med2-us",
    to: "pachka:med2-testing",
    on: {
      changed: "status",
      status: "Testing",
      content: {
        message: "🧪 [{{identifier}} {{name}}]({{issueUrl}})\n🦸 {{assignee}}\n📋 {{status}}",
        actions: [
          {
            type: "buttons",
            buttons: [
              { text: "🌐 Перейти на сайт", url: "https://med2.test" },
              { text: "↩️ Вернуть в работу", callbackData: "taiga:med2-us:rework:{{issueId}}" },
              { text: "✅ Завершить", callbackData: "taiga:med2-us:close:{{issueId}}" },
            ],
          },
          { type: "editPrevious", message: STUB },
        ],
        buttonsByStatus: {
          Testing: [
            { text: "↩️ Вернуть в работу", action: "rework" },
            { text: "✅ Завершить", action: "close" },
          ],
        },
      },
    },
  },
];

function storyPayload(status = "Testing"): TaigaWebhookPayload {
  return {
    action: "change",
    type: "userstory",
    data: {
      id: 681,
      ref: 250,
      subject: "ЭФ: формирование PDF-формы расчёта НМЦК",
      project: { id: 19, permalink: "https://tasks.test/project/med-20", name: "Med-2.0" },
      status: { name: status },
      assigned_to: { id: 27, full_name_display: "Данила Коновницын" },
    },
    change: { diff: { status: { from: "In Progress", to: status } } },
  };
}

describe("story card in the testers' channel", () => {
  const SITE = { text: "🌐 Перейти на сайт", url: "https://med2.test" };

  function sync() {
    const messengerClient = messengerClientMock({
      getMessage: mock(() =>
        Promise.resolve(pachkaMessage({ id: 500, content: "старый текст", buttons: [[SITE]] })),
      ),
      editMessage: mock(() => Promise.resolve(pachkaMessage({ id: 500 }))),
    });
    const messageStore = messageStoreMock({
      get: mock((id: string, target: string) =>
        id === "681" && target === "med2-testing" ? 500 : null,
      ),
    });
    const useCase = new ProcessTaigaWebhookUseCase(
      new ProviderRegistry(PROVIDERS),
      messengerClient,
      messageStore,
      { providers: PROVIDERS, rules: [TESTERS_CARD] },
    );
    return { useCase, messengerClient, messageStore };
  }

  test("a story event re-renders the story's own card, with that step's buttons", async () => {
    const { useCase, messengerClient } = sync();

    const result = await useCase.execute(storyPayload());

    // one edit, not two: the task provider serves the same project but not this kind of item
    expect(result.updated).toBe(1);
    expect(messengerClient.editMessage).toHaveBeenCalledWith(
      500,
      "🧪 [#250 ЭФ: формирование PDF-формы расчёта НМЦК](https://tasks.test/project/med-20/us/250)\n🦸 Данила Коновницын\n📋 Тестирование 🧪",
      {
        buttons: [
          SITE,
          { text: "↩️ Вернуть в работу", data: "taiga:med2-us:rework:681" },
          { text: "✅ Завершить", data: "taiga:med2-us:close:681" },
        ],
      },
    );
  });

  test("the card's own set wins over the provider-wide one", async () => {
    // the task provider declares buttons for "In Progress"; this card declares none, so sending
    // the story back to the developers leaves the testers nothing to press
    const { useCase, messengerClient } = sync();

    await useCase.execute(storyPayload("In Progress"));

    expect(messengerClient.editMessage).toHaveBeenCalledWith(500, expect.any(String), {
      buttons: [SITE],
    });
  });

  test("a story that never left testing is not announced again", async () => {
    // Writing "Testing" over "Testing" changes nothing, and Taiga records such a write as its
    // comment alone — the event arrives without a status diff. So a story kept in testing while
    // its tasks go back and forth produces no card, which is what the parentStatus rule prevents.
    const payload = storyPayload();
    payload.change = { comment: "🧪 Все задачи истории готовы к тестированию", diff: {} };

    expect((await runTrigger(payload, [], [TESTERS_CARD])).result.triggered).toBe(0);
    expect((await runTrigger(storyPayload(), [], [TESTERS_CARD])).result.triggered).toBe(1);
  });
});

describe("testers' buttons write back to Taiga", () => {
  function click(data: string) {
    const client = taigaClientMock({
      getProjectBySlug: mock(() => Promise.resolve({ id: 19, slug: "med-20", name: "Med-2.0" })),
      getItemStatuses: mock(() => Promise.resolve(STORY_STATUSES)),
      getItem: mock(() =>
        Promise.resolve({
          id: 681,
          ref: 250,
          subject: "ЭФ: формирование PDF-формы расчёта НМЦК",
          description: "",
          tags: [],
          version: 11,
          status: 207,
          statusName: "In Progress",
          assigneeName: "Данила Коновницын",
          typeId: null,
          priorityId: null,
        }),
      ),
    });
    const messengerClient = messengerClientMock({
      getMessage: mock(() =>
        Promise.resolve(
          pachkaMessage({
            id: 500,
            content: "старый текст",
            buttons: [
              [{ text: "🌐 Перейти на сайт", url: "https://med2.test" }],
              [{ text: "✅ Завершить", data: "taiga:med2-us:close:681" }],
            ],
          }),
        ),
      ),
      editMessage: mock(() => Promise.resolve(pachkaMessage({ id: 500 }))),
      getUser: mock(() => Promise.resolve({ id: 9, email: "qa@example.com" })),
    });
    const messageStore = messageStoreMock({
      getByPachkaMessageId: mock(() => ({ correlationId: "681", target: "med2-testing" })),
    });
    const useCase = new HandleTaigaFeedbackUseCase(
      new ProviderRegistry(PROVIDERS),
      new Map([["taiga:med2-us", client]]),
      messengerClient,
      { providers: PROVIDERS, rules: [TESTERS_CARD] },
      messageStore,
    );
    return useCase
      .execute({ data, pachkaUserId: 9, messageId: 500 })
      .then((result) => ({ result, client, messengerClient }));
  }

  test("returning the story to work does not make the tester its assignee", async () => {
    const { result, client, messengerClient } = await click("taiga:med2-us:rework:681");

    expect(result).toMatchObject({ ok: true, status: "In Progress" });
    expect(client.updateItem).toHaveBeenCalledWith("user_story", 681, { status: 112 }, 11);
    // the tester is not the one who will do the work
    expect(messengerClient.getUser).not.toHaveBeenCalled();
  });

  test("the site link outlives the transition, the action buttons do not", async () => {
    const { messengerClient } = await click("taiga:med2-us:rework:681");

    expect(messengerClient.editMessage).toHaveBeenCalledWith(500, expect.any(String), {
      buttons: [{ text: "🌐 Перейти на сайт", url: "https://med2.test" }],
    });
  });

  test("finishing it closes the story", async () => {
    const { result, client } = await click("taiga:med2-us:close:681");

    expect(result).toMatchObject({ ok: true, status: "Done" });
    expect(client.updateItem).toHaveBeenCalledWith("user_story", 681, { status: 114 }, 11);
  });
});

// ── A story that comes back for testing ──

describe("a second hand-off of the same story", () => {
  const SITE = { text: "🌐 Перейти на сайт", url: "https://med2.test" };
  const ACTIONS = [
    { text: "↩️ Вернуть в работу", data: "taiga:med2-us:rework:681" },
    { text: "✅ Завершить", data: "taiga:med2-us:close:681" },
  ];

  const TRIGGER = {
    issueId: "681",
    identifier: "#250",
    name: "ЭФ: формирование PDF-формы расчёта НМЦК",
    issueUrl: "https://tasks.test/project/med-20/us/250",
    assignee: "Данила Коновницын",
    status: "Тестирование 🧪",
  };

  function harness() {
    let nextId = 500;
    const messengerClient = messengerClientMock({
      sendMessage: mock(() => Promise.resolve(pachkaMessage({ id: nextId++ }))),
      editMessage: mock(() => Promise.resolve(pachkaMessage({ id: 500 }))),
      getMessage: mock((id: number) =>
        Promise.resolve(
          pachkaMessage({ id, content: "карточка", buttons: [[SITE], ACTIONS] }),
        ),
      ),
    });
    const rows = new Map<string, number>();
    const messageStore = messageStoreMock({
      get: mock((id: string, target: string) => rows.get(`${id}:${target}`) ?? null),
      set: mock((id: string, target: string, msgId: number) => {
        rows.set(`${id}:${target}`, msgId);
      }),
    });
    const engine = new ProcessIntakePipelineUseCase(
      { providers: PROVIDERS, rules: [TESTERS_CARD] },
      new ProviderRegistry(PROVIDERS),
      new Map(),
      messengerClient,
      messageStore,
    );
    return { engine, messengerClient, messageStore };
  }

  test("posts a fresh card and retires the previous one", async () => {
    const { engine, messengerClient, messageStore } = harness();

    await engine.run(TESTERS_CARD, TRIGGER);
    await engine.run(TESTERS_CARD, TRIGGER);

    // the testers are pinged again — editing a message notifies nobody
    expect(messengerClient.sendMessage).toHaveBeenCalledTimes(2);
    // and the card they already have stops being a card: no live actions, link kept
    expect(messengerClient.editMessage).toHaveBeenCalledWith(500, STUB, { buttons: [SITE] });
    // tracking follows the new one, so later status changes re-render that
    expect(messageStore.get("681", "med2-testing")).toBe(501);
  });

  test("the first hand-off has no previous card to retire", async () => {
    const { engine, messengerClient } = harness();

    await engine.run(TESTERS_CARD, TRIGGER);

    expect(messengerClient.sendMessage).toHaveBeenCalledTimes(1);
    expect(messengerClient.editMessage).not.toHaveBeenCalled();
  });
});
