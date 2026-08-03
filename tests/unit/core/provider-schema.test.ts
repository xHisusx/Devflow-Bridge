import { describe, test, expect, mock } from "bun:test";
import { PROVIDER_OUTPUTS, getProviderOutputs } from "../../../src/core/provider-schema";
import { buildPlaneTriggerOutputs } from "../../../src/modules/plane/domain/services/trigger-outputs";
import { createPlaneIssueFromContent } from "../../../src/modules/plane/application/services/create-plane-issue";
import { createTaigaIssueFromContent } from "../../../src/modules/taiga/application/services/create-taiga-issue";
import type { PlaneProvider, TaigaProvider } from "../../../src/core/config";
import type { IPlaneApiClient } from "../../../src/modules/plane/application/ports/plane-api.port";
import type { ITaigaApiClient } from "../../../src/modules/taiga/application/ports/taiga-api.port";

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
    const client: ITaigaApiClient = {
      getProjectBySlug: mock(() => Promise.resolve({ id: 1, slug: "desk", name: "Desk" })),
      createItem: mock(() =>
        Promise.resolve({
          id: 7, ref: 3, subject: "Hi", description: "", tags: [],
          status: null, statusName: null, typeId: null, priorityId: null,
        }),
      ),
      getItem: mock(() =>
        Promise.resolve({
          id: 7, ref: 3, subject: "Hi", version: 1, status: 1,
          statusName: null, assigneeName: null, typeId: null, priorityId: null,
        }),
      ),
      getItemStatuses: mock(() => Promise.resolve([])),
      getIssueTypes: mock(() => Promise.resolve([])),
      getPriorities: mock(() => Promise.resolve([])),
      updateItem: mock(() => Promise.resolve()),
      getMemberIdByEmail: mock(() => Promise.resolve(null)),
    };
    const provider: TaigaProvider = {
      type: "taiga", alias: "support", baseUrl: "https://taiga.test", project: "desk",
    };

    const { outputs } = await createTaigaIssueFromContent(client, provider, { name: "Hi" });

    expect(sorted(Object.keys(outputs))).toEqual(sorted(getProviderOutputs("taiga")));
    expect(sorted(getProviderOutputs("taiga"))).toEqual(sorted(PROVIDER_OUTPUTS.taiga));
  });
});
