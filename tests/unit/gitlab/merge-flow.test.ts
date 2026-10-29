import { describe, test, expect, mock, beforeEach } from "bun:test";
import { ProcessTaigaTriggerUseCase } from "../../../src/modules/taiga/application/use-cases/process-taiga-trigger";
import { ProcessGitLabTriggerUseCase } from "../../../src/modules/gitlab/application/use-cases/process-gitlab-trigger";
import { ProcessIntakePipelineUseCase } from "../../../src/modules/plane/application/use-cases/process-intake-pipeline";
import { PachkaUserDirectory } from "../../../src/modules/messenger/application/services/pachka-user-directory";
import { clearGitLabMemberCache } from "../../../src/modules/gitlab/application/services/gitlab-user-resolver";
import { ProviderRegistry } from "../../../src/core/provider-registry";
import { validateConfig } from "../../../src/core/config";
import type { Config, Provider } from "../../../src/core/config";
import type { Rule } from "../../../src/modules/messenger/domain/entities/notification";
import type { IPlaneApiClient } from "../../../src/modules/plane/application/ports/plane-api.port";
import type { ITaigaApiClient } from "../../../src/modules/taiga/application/ports/taiga-api.port";
import type { TaigaWebhookPayload } from "../../../src/modules/taiga/domain/entities/taiga-webhook-payload";
import type { GitLabWebhookPayload } from "../../../src/modules/gitlab/domain/entities/gitlab-webhook-payload";
import {
  gitlabClientMock,
  messageStoreMock,
  messengerClientMock,
  pachkaMessage,
  pipelineStateMock,
  taigaClientMock,
} from "../../mocks";

/**
 * The other half of the loop: a merged merge request moves the Taiga item on, found through the
 * task link the assignment pipeline recorded. Plus the `once` guard that keeps a re-assignment
 * from notifying the same person twice.
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
  },
  { type: "pachka", alias: "dev-dm", dm: true },
  { type: "pachka", alias: "team", chatId: 555 },
];

/** 1. first assignment -> branch + draft MR, then one DM (and only ever one). */
const ASSIGN: Rule[] = [
  {
    from: "taiga:dev",
    to: "gitlab:backend",
    on: {
      action: "change",
      assigned: "first",
      content: { branch: "feat/{{assigneeInitials}}/{{slug}}", mr: {} },
    },
  },
  {
    from: "gitlab:backend",
    to: "pachka:dev-dm",
    on: {
      once: true,
      content: {
        recipient: "{{assigneeEmail}}",
        message: "🆕 {{taskIdentifier}} {{taskName}} — ветка `{{branch}}`",
      },
    },
  },
];

/** 2. the MR is merged -> the item moves to Done and the team hears about it. */
const MERGE: Rule[] = [
  {
    from: "gitlab:backend",
    to: "taiga:dev",
    on: {
      event: "merge_request",
      action: "merge",
      target: "master",
      content: {
        item: "{{taskId}}",
        status: "Done",
        comment: "MR {{mrUrl}} влит в {{target}} ({{author}})",
      },
    },
  },
  {
    from: "gitlab:backend",
    to: "pachka:team",
    on: { content: { message: "✅ {{taskIdentifier}} {{taskName}} — MR влит в {{target}}" } },
  },
];

const ASSIGNED: TaigaWebhookPayload = {
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
  },
  change: { diff: { assigned_to: { from: null, to: "Алексей Махов" } } },
};

const MERGED: GitLabWebhookPayload = {
  object_kind: "merge_request",
  user: { id: 55, name: "Алексей Махов", username: "amakhov" },
  project: { id: 1, path_with_namespace: "team/backend", web_url: "https://git.test/team/backend" },
  object_attributes: {
    iid: 7,
    title: "Draft: #42 Исправить баг в отчётах",
    state: "merged",
    action: "merge",
    source_branch: "feat/am/ispravit-bag-v-otchetah",
    target_branch: "master",
    url: "https://git.test/team/backend/-/merge_requests/7",
    last_commit: { id: "abc1234", title: "Fix the report" },
  },
};

function build() {
  const config: Config = { providers: PROVIDERS, rules: [ASSIGN, MERGE] };
  const registry = new ProviderRegistry(PROVIDERS);
  const state = pipelineStateMock();

  const taiga = taigaClientMock({
    getProjectBySlug: mock(() => Promise.resolve({ id: 5, slug: "dev", name: "Dev" })),
    getMemberEmailById: mock(() => Promise.resolve("a.makhov@example.com")),
    getItemStatuses: mock(() =>
      Promise.resolve([{ id: 1, name: "New" }, { id: 9, name: "Done" }]),
    ),
    getItem: mock(() =>
      Promise.resolve({
        id: 777, ref: 42, subject: "Исправить баг в отчётах", description: "", tags: [],
        version: 3, status: 1, statusName: "New", assigneeName: "Алексей Махов",
        typeId: null, priorityId: null,
      }),
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

  const taigaClients = new Map<string, ITaigaApiClient>([["taiga:dev", taiga]]);

  const engine = new ProcessIntakePipelineUseCase(
    config,
    registry,
    new Map<string, IPlaneApiClient>(),
    messenger,
    messageStoreMock(),
    taigaClients,
    new Map([["gitlab:backend", gitlab]]),
    new PachkaUserDirectory(messenger),
    state,
  );

  return {
    config,
    registry,
    state,
    taiga,
    gitlab,
    messenger,
    assignTrigger: () => new ProcessTaigaTriggerUseCase(config, registry, taigaClients, engine),
    mergeTrigger: () => new ProcessGitLabTriggerUseCase(config, registry, state, engine),
  };
}

describe("MR merged -> status in Taiga", () => {
  beforeEach(clearGitLabMemberCache);

  test("the assignment records which task the branch and MR belong to", async () => {
    const { assignTrigger, state } = build();

    await assignTrigger().execute(ASSIGNED);

    expect(state.links).toEqual([
      {
        repo: "team/backend",
        branch: "feat/am/ispravit-bag-v-otchetah",
        mrIid: 7,
        mrUrl: "https://git.test/team/backend/-/merge_requests/7",
        tracker: "taiga:dev",
        taskId: "777",
        taskUrl: "https://taiga.test/project/dev/us/42",
        taskIdentifier: "#42",
        taskName: "Исправить баг в отчётах",
      },
    ]);
  });

  test("merging the MR moves the item to Done and tells the team", async () => {
    const { assignTrigger, mergeTrigger, taiga, messenger } = build();

    await assignTrigger().execute(ASSIGNED);
    const result = await mergeTrigger().execute(MERGED);

    expect(result.triggered).toBe(1);

    // the item was found through the task link, not through anything in the GitLab payload
    expect(taiga.updateItem).toHaveBeenCalledWith(
      "user_story",
      777,
      {
        status: 9,
        comment: "MR https://git.test/team/backend/-/merge_requests/7 влит в master (Алексей Махов)",
      },
      3,
    );

    expect(messenger.sendMessage).toHaveBeenCalledWith(
      555,
      "✅ #42 Исправить баг в отчётах — MR влит в master",
      { buttons: undefined },
    );
  });

  test("an MR nobody linked to a task leaves Taiga alone", async () => {
    const { mergeTrigger, taiga, messenger } = build();

    // no assignment ran first, so there is no task link for this branch
    const result = await mergeTrigger().execute(MERGED);

    expect(result.triggered).toBe(1);
    expect(taiga.updateItem).not.toHaveBeenCalled();
    expect(taiga.createItem).not.toHaveBeenCalled();
    // the notification still goes out, with the task fields empty
    expect(messenger.sendMessage).toHaveBeenCalledWith(
      555,
      "✅   — MR влит в master",
      { buttons: undefined },
    );
  });

  test("a merge into another branch does not match the pipeline", async () => {
    const { assignTrigger, mergeTrigger, taiga } = build();

    await assignTrigger().execute(ASSIGNED);
    const result = await mergeTrigger().execute({
      ...MERGED,
      object_attributes: { ...MERGED.object_attributes, target_branch: "develop" },
    });

    expect(result.triggered).toBe(0);
    expect(taiga.updateItem).not.toHaveBeenCalled();
  });

  test("an event from a repository the provider does not cover is ignored", async () => {
    const { mergeTrigger } = build();

    const result = await mergeTrigger().execute({
      ...MERGED,
      project: { path_with_namespace: "other/service" },
    });

    expect(result.triggered).toBe(0);
  });
});

describe("the same task assigned twice notifies once", () => {
  beforeEach(clearGitLabMemberCache);

  test("the second assignment reuses the branch and sends no DM", async () => {
    const { assignTrigger, gitlab, messenger, state } = build();

    await assignTrigger().execute(ASSIGNED);
    expect(messenger.sendMessage).toHaveBeenCalledTimes(1);

    // The branch now exists, as it would on a second run.
    (gitlab.getBranch as ReturnType<typeof mock>).mockImplementation((project: string, branch: string) =>
      Promise.resolve({ name: branch, webUrl: `https://git.test/${project}/-/tree/${branch}`, commitSha: "abc", protected: false }),
    );

    // A fresh trigger instance: a later event, past the in-memory webhook de-duplication.
    await assignTrigger().execute(ASSIGNED);

    expect(gitlab.createBranch).toHaveBeenCalledTimes(1);
    expect(messenger.sendMessage).toHaveBeenCalledTimes(1);
    expect(state.keys.size).toBe(1);
  });

  test("handing the task to someone else does notify the new person", async () => {
    const { assignTrigger, messenger, taiga } = build();

    await assignTrigger().execute(ASSIGNED);

    (taiga.getMemberEmailById as ReturnType<typeof mock>).mockImplementation(() =>
      Promise.resolve("i.petrov@example.com"),
    );
    (messenger.listUsers as ReturnType<typeof mock>).mockImplementation(() =>
      Promise.resolve([
        {
          id: 202,
          email: "petrov@corp.test",
          custom_properties: [
            { id: 1, name: "Рабочая почта", data_type: "string", value: "i.petrov@example.com" },
          ],
        },
      ]),
    );

    await assignTrigger().execute({
      ...ASSIGNED,
      data: {
        ...ASSIGNED.data,
        assigned_to: { id: 10, username: "ipetrov", full_name: "Иван Петров" },
      },
      change: { diff: { assigned_to: { from: null, to: "Иван Петров" } } },
    });

    expect(messenger.sendMessage).toHaveBeenCalledTimes(2);
    const [chatId] = (messenger.sendMessage as ReturnType<typeof mock>).mock.calls[1];
    expect(chatId).toBe(202);
  });

  test("a failed DM releases the guard so the next event can retry", async () => {
    const { assignTrigger, messenger, state } = build();

    (messenger.sendMessage as ReturnType<typeof mock>).mockImplementationOnce(() =>
      Promise.reject(new Error("503 Service Unavailable")),
    );

    await assignTrigger().execute(ASSIGNED);
    expect(state.keys.size).toBe(0);

    await assignTrigger().execute(ASSIGNED);
    expect(messenger.sendMessage).toHaveBeenCalledTimes(2);
    expect(state.keys.size).toBe(1);
  });
});

describe("both pipelines validate", () => {
  test("every template only uses fields its trigger or step exposes", () => {
    const { config, registry } = build();
    const warnings: string[] = [];

    validateConfig(config, registry, { warn: (msg) => warnings.push(msg) });

    expect(warnings).toEqual([]);
  });
});
