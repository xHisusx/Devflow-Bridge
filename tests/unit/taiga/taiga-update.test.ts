import { describe, test, expect, mock } from "bun:test";
import { updateTaigaItemFromContent } from "../../../src/modules/taiga/application/services/update-taiga-item";
import { TaigaWriteError } from "../../../src/modules/taiga/application/services/create-taiga-issue";
import type { ITaigaApiClient } from "../../../src/modules/taiga/application/ports/taiga-api.port";
import type { TaigaProvider } from "../../../src/core/config";

const PROVIDER: TaigaProvider = {
  type: "taiga",
  alias: "dev",
  baseUrl: "https://taiga.test",
  project: "dev",
  entity: "user_story",
};

function createMockClient(overrides: Partial<ITaigaApiClient> = {}): ITaigaApiClient {
  return {
    getProjectBySlug: mock(() => Promise.resolve({ id: 5, slug: "dev", name: "Dev" })),
    createItem: mock(() => Promise.resolve({} as never)),
    getItem: mock(() =>
      Promise.resolve({
        id: 777, ref: 42, subject: "Исправить баг", description: "Шаги", tags: ["backend"],
        version: 3, status: 1, statusName: "In progress", assigneeName: "Алексей Махов",
        typeId: null, priorityId: null,
      }),
    ),
    getItemStatuses: mock(() => Promise.resolve([{ id: 2, name: "In progress" }])),
    getIssueTypes: mock(() => Promise.resolve([])),
    getPriorities: mock(() => Promise.resolve([])),
    updateItem: mock(() => Promise.resolve()),
    getMemberIdByEmail: mock(() => Promise.resolve(11)),
    getMemberEmailById: mock(() => Promise.resolve(null)),
    getCustomAttributes: mock(() =>
      Promise.resolve([{ id: 4, name: "MR" }, { id: 5, name: "Ветка" }]),
    ),
    getCustomAttributeValues: mock(() =>
      Promise.resolve({ values: { "9": "keep me" }, version: 7 }),
    ),
    setCustomAttributeValues: mock(() => Promise.resolve()),
    ...overrides,
  } as ITaigaApiClient;
}

describe("updateTaigaItemFromContent", () => {
  test("writes custom fields by name, keeping the values already set", async () => {
    const client = createMockClient();

    const { outputs } = await updateTaigaItemFromContent(client, PROVIDER, {
      item: "777",
      customFields: { MR: "https://git.test/mr/7", Ветка: "feat/am/ispravit-bag" },
    });

    expect(client.getCustomAttributes).toHaveBeenCalledWith("user_story", 5);
    expect(client.setCustomAttributeValues).toHaveBeenCalledWith(
      "user_story",
      777,
      { "9": "keep me", "4": "https://git.test/mr/7", "5": "feat/am/ispravit-bag" },
      7,
    );
    expect(outputs.issueId).toBe("777");
    expect(outputs.issueUrl).toBe("https://taiga.test/project/dev/us/42");
    expect(outputs.action).toBe("update");
    expect(outputs.labels).toEqual(["backend"]);
  });

  test("field names match case-insensitively", async () => {
    const client = createMockClient();

    await updateTaigaItemFromContent(client, PROVIDER, {
      item: "777",
      customFields: { mr: "https://git.test/mr/7" },
    });

    const [, , values] = (client.setCustomAttributeValues as ReturnType<typeof mock>).mock.calls[0];
    expect(values["4"]).toBe("https://git.test/mr/7");
  });

  // The write-back is an extra: a field the project does not define is skipped, so the steps
  // that follow in the pipeline (the DM) still run.
  test("an unknown custom field is skipped, the known ones are still written", async () => {
    const client = createMockClient();

    await updateTaigaItemFromContent(client, PROVIDER, {
      item: "777",
      customFields: { "Нет такого": "x", MR: "https://git.test/mr/7" },
    });

    const [, , values] = (client.setCustomAttributeValues as ReturnType<typeof mock>).mock.calls[0];
    expect(values["4"]).toBe("https://git.test/mr/7");
    expect(Object.keys(values)).not.toContain("Нет такого");
  });

  test("custom fields that exist nowhere in the project leave the item untouched", async () => {
    const client = createMockClient();

    await updateTaigaItemFromContent(client, PROVIDER, {
      item: "777",
      customFields: { "Нет такого": "x" },
    });

    expect(client.setCustomAttributeValues).not.toHaveBeenCalled();
  });

  test("moves the status, assigns by email and posts a comment in one patch", async () => {
    const client = createMockClient();

    await updateTaigaItemFromContent(client, PROVIDER, {
      item: "777",
      status: "in progress",
      assigneeEmail: "a.makhov@example.com",
      comment: "Ветка создана",
    });

    expect(client.updateItem).toHaveBeenCalledWith(
      "user_story",
      777,
      { status: 2, assigned_to: 11, comment: "Ветка создана" },
      3,
    );
  });

  test("an unknown status is an error", async () => {
    const client = createMockClient();

    expect(
      updateTaigaItemFromContent(client, PROVIDER, { item: "777", status: "Нет такого" }),
    ).rejects.toThrow(TaigaWriteError);
  });

  test("a missing item id is an error", async () => {
    const client = createMockClient();

    expect(
      updateTaigaItemFromContent(client, PROVIDER, { customFields: { MR: "x" } }),
    ).rejects.toThrow(TaigaWriteError);
  });

  test("nothing is patched when only custom fields are given", async () => {
    const client = createMockClient();

    await updateTaigaItemFromContent(client, PROVIDER, {
      item: "777",
      customFields: { MR: "https://git.test/mr/7" },
    });

    expect(client.updateItem).not.toHaveBeenCalled();
  });
});
