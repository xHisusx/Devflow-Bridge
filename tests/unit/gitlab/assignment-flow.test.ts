import { describe, test, expect, mock } from "bun:test";
import { ProcessTaigaTriggerUseCase } from "../../../src/modules/taiga/application/use-cases/process-taiga-trigger";
import { ProcessIntakePipelineUseCase } from "../../../src/modules/plane/application/use-cases/process-intake-pipeline";
import { PachkaUserDirectory } from "../../../src/modules/messenger/application/services/pachka-user-directory";
import { ProviderRegistry } from "../../../src/core/provider-registry";
import { validateConfig } from "../../../src/core/config";
import type { Config, Provider } from "../../../src/core/config";
import type { Rule } from "../../../src/modules/messenger/domain/entities/notification";
import type { IPlaneApiClient } from "../../../src/modules/plane/application/ports/plane-api.port";
import type { TaigaWebhookPayload } from "../../../src/modules/taiga/domain/entities/taiga-webhook-payload";
import { gitlabClientMock, messageStoreMock, messengerClientMock, pachkaMessage, taigaClientMock } from "../../mocks";

/**
 * The full "a task got its first assignee" flow: branch + draft MR in GitLab, the MR link written
 * back into a Taiga custom field, a DM to the assignee and a note in the team chat.
 */

const PROVIDERS: Provider[] = [
  {
    type: "taiga",
    alias: "dev",
    baseUrl: "https://taiga.test",
    project: "dev",
    entity: "user_story",
    feedback: { statuses: { accept: "In progress" } },
  },
  {
    type: "gitlab",
    alias: "backend",
    baseUrl: "https://git.test",
    project: "team/backend",
    defaultBranch: "master",
    repoByTag: { backend: "team/api" },
  },
  { type: "pachka", alias: "dev-dm", dm: true },
  { type: "pachka", alias: "team", chatId: 555 },
];

const PIPELINE: Rule[] = [
  {
    from: "taiga:dev",
    to: "gitlab:backend",
    on: {
      action: "change",
      changed: "assigned_to",
      assigned: "first",
      content: {
        branch: "feat/{{assigneeInitials}}/{{slug}}",
        mr: { title: "{{taskIdentifier}} {{taskName}}", description: "Taiga: {{taskUrl}}" },
      },
    },
  },
  {
    from: "gitlab:backend",
    to: "taiga:dev",
    on: {
      content: {
        item: "{{taskId}}",
        customFields: { MR: "{{mrUrl}}", Ветка: "{{branch}}" },
      },
    },
  },
  {
    from: "gitlab:backend",
    to: "pachka:dev-dm",
    on: {
      content: {
        recipient: "{{assigneeEmail}}",
        message: "🆕 На вас задача: [{{taskName}}]({{taskUrl}})\nВетка: `{{branch}}`",
        actions: [
          {
            type: "buttons",
            buttons: [
              { text: "Задача", url: "{{taskUrl}}" },
              { text: "MR", url: "{{mrUrl}}" },
              { text: "👍 Взять в работу", callbackData: "taiga:dev:accept:{{taskId}}" },
            ],
          },
        ],
      },
    },
  },
  {
    from: "gitlab:backend",
    to: "pachka:team",
    on: { content: { message: "{{assignee}} взял(а) {{taskIdentifier}}, MR: {{mrUrl}}" } },
  },
];

const PAYLOAD: TaigaWebhookPayload = {
  action: "change",
  type: "userstory",
  by: { id: 1, full_name: "Project Owner" },
  data: {
    id: 777,
    ref: 42,
    subject: "Исправить баг в отчётах",
    project: { id: 5, permalink: "https://taiga.test/project/dev", name: "Dev" },
    status: { name: "New" },
    assigned_to: { id: 9, username: "amakhov", full_name: "Алексей Махов" },
    tags: ["backend"],
  },
  change: { diff: { assigned_to: { from: null, to: "Алексей Махов" } } },
};

function build() {
  const config: Config = { providers: PROVIDERS, rules: [PIPELINE] };
  const registry = new ProviderRegistry(PROVIDERS);

  const taiga = taigaClientMock({
    getProjectBySlug: mock(() => Promise.resolve({ id: 5, slug: "dev", name: "Dev" })),
    getMemberEmailById: mock(() => Promise.resolve("a.makhov@example.com")),
    getItem: mock(() =>
      Promise.resolve({
        id: 777, ref: 42, subject: "Исправить баг в отчётах", description: "", tags: ["backend"],
        version: 3, status: 1, statusName: "New", assigneeName: "Алексей Махов",
        typeId: null, priorityId: null,
      }),
    ),
    getCustomAttributes: mock(() =>
      Promise.resolve([{ id: 4, name: "MR" }, { id: 5, name: "Ветка" }]),
    ),
  });

  const gitlab = gitlabClientMock();

  const messenger = messengerClientMock({
    sendMessage: mock((entityId: number) => Promise.resolve(pachkaMessage({ id: 1000 + entityId }))),
    listUsers: mock(() =>
      Promise.resolve([
        {
          id: 101,
          email: "login@corp.test",
          custom_properties: [
            { id: 1, name: "Рабочая почта", data_type: "string", value: "a.makhov@example.com" },
          ],
        },
      ]),
    ),
  });

  const pipelineEngine = new ProcessIntakePipelineUseCase(
    config,
    registry,
    new Map<string, IPlaneApiClient>(),
    messenger,
    messageStoreMock(),
    new Map([["taiga:dev", taiga]]),
    new Map([["gitlab:backend", gitlab]]),
    new PachkaUserDirectory(messenger),
  );

  const trigger = new ProcessTaigaTriggerUseCase(
    config,
    registry,
    new Map([["taiga:dev", taiga]]),
    pipelineEngine,
  );

  return { trigger, taiga, gitlab, messenger, config, registry };
}

describe("first assignment -> branch + draft MR + DM", () => {
  test("the whole pipeline runs off one Taiga webhook", async () => {
    const { trigger, taiga, gitlab, messenger } = build();

    const result = await trigger.execute(PAYLOAD);

    expect(result.triggered).toBe(1);

    // 1. repository chosen by tag, branch named after the assignee's initials and the title
    expect(gitlab.getProject).toHaveBeenCalledWith("team/api");
    expect(gitlab.createBranch).toHaveBeenCalledWith(
      "team/api",
      "feat/am/ispravit-bag-v-otchetah",
      "master",
    );

    // 2. draft MR into master, assigned to the GitLab user matched by email
    const [, mrPayload] = (gitlab.createMergeRequest as ReturnType<typeof mock>).mock.calls[0];
    expect(mrPayload).toMatchObject({
      sourceBranch: "feat/am/ispravit-bag-v-otchetah",
      targetBranch: "master",
      title: "Draft: #42 Исправить баг в отчётах",
      description: "Taiga: https://taiga.test/project/dev/us/42",
      assigneeIds: [55],
    });

    // 3. MR link and branch written back into the Taiga custom fields
    expect(taiga.setCustomAttributeValues).toHaveBeenCalledWith(
      "user_story",
      777,
      { "4": "https://git.test/team/api/-/merge_requests/7", "5": "feat/am/ispravit-bag-v-otchetah" },
      1,
    );

    // 4. DM to the assignee's personal chat, resolved through the work-email profile field
    expect(messenger.sendMessage).toHaveBeenCalledWith(
      101,
      "🆕 На вас задача: [Исправить баг в отчётах](https://taiga.test/project/dev/us/42)\n" +
        "Ветка: `feat/am/ispravit-bag-v-otchetah`",
      {
        entityType: "user",
        buttons: [
          { text: "Задача", url: "https://taiga.test/project/dev/us/42" },
          { text: "MR", url: "https://git.test/team/api/-/merge_requests/7" },
          { text: "👍 Взять в работу", data: "taiga:dev:accept:777" },
        ],
      },
    );

    // 5. and a line in the team chat
    expect(messenger.sendMessage).toHaveBeenCalledWith(
      555,
      "Алексей Махов взял(а) #42, MR: https://git.test/team/api/-/merge_requests/7",
      { buttons: undefined },
    );
  });

  test("the pipeline's templates only use fields its steps expose", () => {
    const { config, registry } = build();
    const warnings: string[] = [];

    validateConfig(config, registry, { warn: (msg) => warnings.push(msg) });

    expect(warnings).toEqual([]);
  });
});
