import { describe, test, expect, mock } from "bun:test";
import { createTaigaIssueFromContent, TaigaWriteError } from "../../../src/modules/taiga/application/services/create-taiga-issue";
import { buildItemVars } from "../../../src/modules/taiga/application/services/feedback-message";
import type { ITaigaApiClient } from "../../../src/modules/taiga/application/ports/taiga-api.port";
import type { TaigaProvider } from "../../../src/core/config";

const PRIORITIES = [
  { id: 89, name: "Low" },
  { id: 90, name: "Normal" },
  { id: 91, name: "High" },
  { id: 95, name: "Critical" },
];

function createMockClient(overrides: Partial<ITaigaApiClient> = {}): ITaigaApiClient {
  return {
    getProjectBySlug: mock(() => Promise.resolve({ id: 30, slug: "devops", name: "DevOps" })),
    createItem: mock(() =>
      Promise.resolve({
        id: 777, ref: 13, subject: "X", description: "", tags: [],
        status: 1, statusName: "New", typeId: null, priorityId: 95,
      }),
    ),
    getItem: mock(() =>
      Promise.resolve({
        id: 777, ref: 13, subject: "X", version: 1, status: 1,
        statusName: "New", assigneeName: null, typeId: null, priorityId: 95,
      }),
    ),
    getItemStatuses: mock(() => Promise.resolve([{ id: 1, name: "New" }])),
    getIssueTypes: mock(() => Promise.resolve([])),
    getPriorities: mock(() => Promise.resolve(PRIORITIES)),
    updateItem: mock(() => Promise.resolve()),
    getMemberIdByEmail: mock(() => Promise.resolve(null)),
    ...overrides,
  };
}

const PROVIDER: TaigaProvider = {
  type: "taiga",
  alias: "devops",
  baseUrl: "https://taiga.test",
  project: "devops",
  entity: "issue",
  priorityLabels: { Low: "Низкая", Normal: "Обычная", High: "Высокая", Critical: "Критическая" },
};

describe("createTaigaIssueFromContent — priority", () => {
  test("resolves the priority name (case-insensitive) and passes its id to createItem", async () => {
    const client = createMockClient();

    const { outputs } = await createTaigaIssueFromContent(client, PROVIDER, {
      name: "X",
      priority: "critical",
    });

    const payload = (client.createItem as ReturnType<typeof mock>).mock.calls[0][1];
    expect(payload.priorityId).toBe(95);
    expect(outputs.priority).toBe("Критическая");
  });

  test("unknown priority fails with the available list", async () => {
    const client = createMockClient();

    expect(
      createTaigaIssueFromContent(client, PROVIDER, { name: "X", priority: "Urgent" }),
    ).rejects.toThrow(TaigaWriteError);
    expect(
      createTaigaIssueFromContent(client, PROVIDER, { name: "X", priority: "Urgent" }),
    ).rejects.toThrow("Low, Normal, High, Critical");
  });

  test("without a requested priority the created item's own priority is resolved for display", async () => {
    const client = createMockClient({
      createItem: mock(() =>
        Promise.resolve({
          id: 777, ref: 13, subject: "X", description: "", tags: [],
          status: 1, statusName: "New", typeId: null, priorityId: 90,
        }),
      ),
    });

    const { outputs } = await createTaigaIssueFromContent(client, PROVIDER, { name: "X" });

    const payload = (client.createItem as ReturnType<typeof mock>).mock.calls[0][1];
    expect(payload.priorityId).toBeUndefined();
    expect(outputs.priority).toBe("Обычная");
  });

  test("without priorityLabels the raw Taiga name is exposed; unresolvable priority shows a dash", async () => {
    const bare: TaigaProvider = { ...PROVIDER, priorityLabels: undefined };
    const { outputs } = await createTaigaIssueFromContent(createMockClient(), bare, {
      name: "X",
      priority: "High",
    });
    expect(outputs.priority).toBe("High");

    const noPriority = createMockClient({
      createItem: mock(() =>
        Promise.resolve({
          id: 777, ref: 13, subject: "X", description: "", tags: [],
          status: 1, statusName: "New", typeId: null, priorityId: null,
        }),
      ),
    });
    const { outputs: outputs2 } = await createTaigaIssueFromContent(noPriority, PROVIDER, { name: "X" });
    expect(outputs2.priority).toBe("—");
  });
});

describe("buildItemVars — priority", () => {
  test("redraw vars include the labeled priority of the live item", async () => {
    const client = createMockClient();

    const vars = await buildItemVars(client, PROVIDER, { id: 30, slug: "devops", name: "DevOps" }, 777);

    expect(vars.priority).toBe("Критическая");
  });

  test("items without priority render a dash", async () => {
    const client = createMockClient({
      getItem: mock(() =>
        Promise.resolve({
          id: 777, ref: 13, subject: "X", version: 1, status: 1,
          statusName: "New", assigneeName: null, typeId: null, priorityId: null,
        }),
      ),
    });

    const vars = await buildItemVars(client, PROVIDER, { id: 30, slug: "devops", name: "DevOps" }, 777);

    expect(vars.priority).toBe("—");
  });
});
