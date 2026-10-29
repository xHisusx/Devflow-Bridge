import { describe, test, expect, mock } from "bun:test";
import { PROVIDER_OUTPUTS, getProviderOutputs } from "../../../src/core/provider-schema";
import { buildPlaneTriggerOutputs } from "../../../src/modules/plane/domain/services/trigger-outputs";
import { createPlaneIssueFromContent } from "../../../src/modules/plane/application/services/create-plane-issue";
import { createTaigaIssueFromContent } from "../../../src/modules/taiga/application/services/create-taiga-issue";
import { updateTaigaItemFromContent } from "../../../src/modules/taiga/application/services/update-taiga-item";
import { buildTaigaTriggerOutputs } from "../../../src/modules/taiga/domain/services/taiga-trigger";
import { runGitLabStep } from "../../../src/modules/gitlab/application/services/run-gitlab-step";
import type { GitLabProvider, PlaneProvider, TaigaProvider } from "../../../src/core/config";
import type { IPlaneApiClient } from "../../../src/modules/plane/application/ports/plane-api.port";
import type { ITaigaApiClient } from "../../../src/modules/taiga/application/ports/taiga-api.port";
import { gitlabClientMock, taigaClientMock } from "../../mocks";

const sorted = (xs: readonly string[]) => [...xs].sort();

describe("provider-schema drift guards", () => {
  test("PLANE trigger outputs (webhook) match the declared trigger schema", () => {
    const produced = buildPlaneTriggerOutputs({
      project: "P", seq: "1", title: "t", state: "s", stateGroup: "g",
      priority: "high", action: "update", entity: "issue", issueId: "i",
      issueUrl: "u", identifier: "DEV-1", assignee: "a",
    });
    expect(sorted(Object.keys(produced))).toEqual(sorted(getProviderOutputs("plane", "trigger")));
  });

  test("PLANE step outputs (intake/webhook create) match the declared step schema", async () => {
    const client: IPlaneApiClient = {
      getProjects: mock(() => Promise.resolve([{ id: "proj-1", name: "Backend", identifier: "DEV", workspace: "team" }])),
      getMembers: mock(() => Promise.resolve([])),
      getStates: mock(() => Promise.resolve([])),
      getLabels: mock(() => Promise.resolve([])),
      createIntakeIssue: mock(() => Promise.resolve({ id: "x", issue_id: "issue-1", sequence_id: 5 })),
      getWorkItem: mock(() => Promise.resolve({ id: "issue-1", sequence_id: 5, name: "n" })),
      getUploadCredentials: mock(() => Promise.resolve({ upload_data: { url: "", fields: {} }, asset_id: "a" })),
      uploadToStorage: mock(() => Promise.resolve()),
      completeUpload: mock(() => Promise.resolve()),
      updateWorkItem: mock(() => Promise.resolve()),
    };
    const provider: PlaneProvider = {
      type: "plane", alias: "dev", baseUrl: "http://plane.test", workspace: "team", project: "Backend",
    };

    const { outputs } = await createPlaneIssueFromContent(client, provider, { name: "Hi" });

    expect(sorted(Object.keys(outputs))).toEqual(sorted(getProviderOutputs("plane", "step")));
    // step schema is also the default PROVIDER_OUTPUTS.plane entry
    expect(sorted(getProviderOutputs("plane", "step"))).toEqual(sorted(PROVIDER_OUTPUTS.plane));
  });

  test("TAIGA step outputs (intake create) match the declared step schema", async () => {
    const client = taigaClientMock();
    const provider: TaigaProvider = {
      type: "taiga", alias: "support", baseUrl: "https://taiga.test", project: "desk",
    };

    const { outputs } = await createTaigaIssueFromContent(client, provider, { name: "Hi" });

    expect(sorted(Object.keys(outputs))).toEqual(sorted(getProviderOutputs("taiga")));
    expect(sorted(getProviderOutputs("taiga"))).toEqual(sorted(PROVIDER_OUTPUTS.taiga));
  });

  test("TAIGA step outputs (update) match the same step schema as create", async () => {
    const provider: TaigaProvider = {
      type: "taiga", alias: "support", baseUrl: "https://taiga.test", project: "desk",
    };

    const { outputs } = await updateTaigaItemFromContent(taigaClientMock(), provider, { item: "7" });

    expect(sorted(Object.keys(outputs))).toEqual(sorted(getProviderOutputs("taiga")));
  });

  test("TAIGA trigger outputs (webhook) match the declared trigger schema", () => {
    const produced = buildTaigaTriggerOutputs({
      action: "change", entity: "user_story", issueId: "1", issueUrl: "u", seq: 1,
      identifier: "#1", name: "n", description: "d", project: "P", status: "New",
      statusFrom: "", type: "", priority: "", labels: [], assignee: "a",
      assigneeEmail: "a@b.c", assigneeUsername: "a", assigneeInitials: "ab", slug: "n",
      author: "o", changedFields: ["assigned_to"], sprint: "Sprint 12",
      parentId: "681", parentSeq: 250, parentIdentifier: "#250", parentName: "US",
      parentUrl: "https://taiga.test/project/dev/us/250", receivedAt: "11.07.2026 08:03",
    });

    expect(sorted(Object.keys(produced))).toEqual(sorted(getProviderOutputs("taiga", "trigger")));
  });

  test("GITLAB step outputs match the declared step schema", async () => {
    const client = gitlabClientMock({ findUserByEmail: mock(() => Promise.resolve(null)) });
    const provider: GitLabProvider = {
      type: "gitlab", alias: "api", baseUrl: "https://git.test", project: "team/api",
    };

    const { outputs } = await runGitLabStep(client, provider, { mr: {} }, {
      name: "New task", issueId: "9", issueUrl: "https://taiga.test/1", identifier: "#1",
      assignee: "Alex Brown", assigneeEmail: "a.brown@example.com",
    });

    expect(sorted(Object.keys(outputs))).toEqual(sorted(getProviderOutputs("gitlab")));
    expect(sorted(getProviderOutputs("gitlab"))).toEqual(sorted(PROVIDER_OUTPUTS.gitlab));
  });
});
