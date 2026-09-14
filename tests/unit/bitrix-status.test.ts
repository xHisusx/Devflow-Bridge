import { describe, expect, mock, test } from "bun:test";
import {
  BitrixMappingError,
  parseBitrixIdFromDescription,
  updateBitrixStatusFromTaiga,
} from "../../src/modules/bitrix/application/services/update-bitrix-status";
import type { IBitrixClient } from "../../src/modules/bitrix/application/ports/bitrix-api.port";
import { ProcessIntakePipelineUseCase } from "../../src/modules/plane/application/use-cases/process-intake-pipeline";
import { ProviderRegistry } from "../../src/core/provider-registry";
import type { Config, Provider } from "../../src/core/config";

function client(): IBitrixClient {
  return {
    updateStatus: mock(() => Promise.resolve({ status: "ok", data: [], errors: [] })),
  };
}

describe("Bitrix status integration", () => {
  test.each([
    "**BitrixID:** 12345",
    "BitrixID: 12345",
    "<p>**BitrixID:** 12345</p>",
    "**Bitrix ID:** 12345",
  ])("parses id from %s", (description) => {
    expect(parseBitrixIdFromDescription(description)).toBe(12345);
  });

  test("rejects description without BitrixID", () => {
    expect(() => parseBitrixIdFromDescription("No external id"))
      .toThrow(BitrixMappingError);
  });

  test("updates Bitrix with parsed id and configured status", async () => {
    const bitrix = client();
    const provider = { type: "bitrix" as const, alias: "support", baseUrl: "http://bitrix.test/api" };

    const outputs = await updateBitrixStatusFromTaiga(
      bitrix,
      provider,
      { description: "**BitrixID:** 987" },
      { status: "Rejected", resolution: "Отклонено оператором" },
    );

    expect(bitrix.updateStatus).toHaveBeenCalledWith({
      id: 987,
      status: "Rejected",
      resolution: "Отклонено оператором",
    });
    expect(outputs.bitrixId).toBe(987);
  });

  test("executes a from Taiga to Bitrix pipeline step", async () => {
    const bitrix = client();
    const taiga = {
      getProjectBySlug: mock(() => Promise.resolve({ id: 1, slug: "support", name: "Support" })),
      createItem: mock(() => Promise.resolve({
        id: 7,
        ref: 12,
        subject: "Request",
        description: "**BitrixID:** 456",
        tags: [],
        status: 1,
        statusName: "New",
        typeId: null,
        priorityId: null,
      })),
      getItem: mock(),
      getItemStatuses: mock(),
      getIssueTypes: mock(),
      getPriorities: mock(),
      updateItem: mock(),
      getMemberIdByEmail: mock(),
    };
    const providers: Provider[] = [
      { type: "api", alias: "intake", endpoint: "/intake" },
      { type: "taiga", alias: "support", baseUrl: "http://taiga.test", project: "support" },
      { type: "bitrix", alias: "support", baseUrl: "http://bitrix.test/api" },
    ];
    const rules = [[
      { from: "api:intake", to: "taiga:support", on: { content: { name: "{{body.name}}", description: "{{body.description}}" } } },
      { from: "taiga:support", to: "bitrix:support", on: { content: { status: "Closed", resolution: "Готово" } } },
    ]] as Config["rules"];
    const pipeline = new ProcessIntakePipelineUseCase(
      { providers, rules },
      new ProviderRegistry(providers),
      new Map(),
      null,
      null,
      new Map([["taiga:support", taiga]]),
      new Map([["bitrix:support", bitrix]]),
    );

    const result = await pipeline.execute({
      body: { name: "Request", description: "**BitrixID:** 456" },
    });

    expect(result.ok).toBe(true);
    expect(bitrix.updateStatus).toHaveBeenCalledWith({ id: 456, status: "Closed", resolution: "Готово" });
  });
});
