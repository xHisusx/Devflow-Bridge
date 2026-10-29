import { describe, expect, test } from "bun:test";
import {
  BitrixMappingError,
  parseBitrixIdFromDescription,
  updateBitrixStatusFromTaiga,
} from "../../../src/modules/bitrix/application/services/update-bitrix-status";
import { ProcessIntakePipelineUseCase } from "../../../src/modules/plane/application/use-cases/process-intake-pipeline";
import { ProcessTaigaTriggerUseCase } from "../../../src/modules/taiga/application/use-cases/process-taiga-trigger";
import { ProviderRegistry } from "../../../src/core/provider-registry";
import type { Config, Provider } from "../../../src/core/config";
import { bitrixClientMock, taigaClientMock } from "../../mocks";

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
    const bitrix = bitrixClientMock();
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
    const bitrix = bitrixClientMock();
    const taiga = taigaClientMock({
      getProjectBySlug: () => Promise.resolve({ id: 1, slug: "support", name: "Support" }),
      createItem: () =>
        Promise.resolve({
          id: 7,
          ref: 12,
          subject: "Request",
          description: "**BitrixID:** 456",
          tags: [],
          status: 1,
          statusName: "New",
          typeId: null,
          priorityId: null,
        }),
    });
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
      new Map(),
      null,
      null,
      new Map([["bitrix:support", bitrix]]),
    );

    const result = await pipeline.execute({
      body: { name: "Request", description: "**BitrixID:** 456" },
    });

    expect(result.ok).toBe(true);
    expect(bitrix.updateStatus).toHaveBeenCalledWith({ id: 456, status: "Closed", resolution: "Готово" });
  });

  test("executes the Taiga to Bitrix pipeline on Closed/Rejected status webhook", async () => {
    const bitrix = bitrixClientMock();
    const providers: Provider[] = [
      { type: "taiga", alias: "support", baseUrl: "http://taiga.test", project: "support" },
      { type: "bitrix", alias: "support", baseUrl: "http://bitrix.test/api" },
    ];
    const config: Config = {
      providers,
      rules: [
        [{
          from: "taiga:support",
          to: "bitrix:support",
          on: {
            action: "update",
            status: "Closed",
            content: { status: "Closed", resolution: "Закрыто в Taiga" },
          },
        }],
        [{
          from: "taiga:support",
          to: "bitrix:support",
          on: {
            action: "update",
            status: "Rejected",
            content: { status: "Rejected", resolution: "Отклонено в Taiga" },
          },
        }],
      ],
    };
    const registry = new ProviderRegistry(providers);
    const taigaClients = new Map([["taiga:support", taigaClientMock()]]);
    const pipeline = new ProcessIntakePipelineUseCase(
      config,
      registry,
      new Map(),
      null,
      null,
      taigaClients,
      new Map(),
      null,
      null,
      new Map([["bitrix:support", bitrix]]),
    );
    const trigger = new ProcessTaigaTriggerUseCase(config, registry, taigaClients, pipeline);

    const result = await trigger.execute({
      action: "change",
      type: "issue",
      data: {
        id: 7,
        ref: 12,
        subject: "Request",
        description: "**BitrixID:** 654",
        project: { permalink: "http://taiga.test/project/support", name: "Support" },
        status: { name: "Closed" },
      },
      change: { diff: { status: { from: "In progress", to: "Closed" } } },
    });

    expect(result.triggered).toBe(1);
    expect(bitrix.updateStatus).toHaveBeenCalledWith({
      id: 654,
      status: "Closed",
      resolution: "Закрыто в Taiga",
    });

    await trigger.execute({
      action: "change",
      type: "issue",
      data: {
        id: 7,
        ref: 12,
        subject: "Request",
        description: "**BitrixID:** 654",
        project: { permalink: "http://taiga.test/project/support", name: "Support" },
        status: { name: "Rejected" },
      },
      change: { diff: { status: { from: "In progress", to: "Rejected" } } },
    });
    expect(bitrix.updateStatus).toHaveBeenCalledWith({
      id: 654,
      status: "Rejected",
      resolution: "Отклонено в Taiga",
    });
  });

  test("Taiga's own `close` action triggers a rule that asks for it", async () => {
    const bitrix = bitrixClientMock();
    const providers: Provider[] = [
      { type: "taiga", alias: "support", baseUrl: "http://taiga.test", project: "support" },
      { type: "bitrix", alias: "support", baseUrl: "http://bitrix.test/api" },
    ];
    const config: Config = {
      providers,
      rules: [[{
        from: "taiga:support",
        to: "bitrix:support",
        on: {
          action: "close",
          status: "Closed",
          content: { status: "Closed", resolution: "Закрыто в Taiga" },
        },
      }]],
    };
    const registry = new ProviderRegistry(providers);
    const taigaClients = new Map([["taiga:support", taigaClientMock()]]);
    const trigger = new ProcessTaigaTriggerUseCase(
      config,
      registry,
      taigaClients,
      new ProcessIntakePipelineUseCase(
        config,
        registry,
        new Map(),
        null,
        null,
        taigaClients,
        new Map(),
        null,
        null,
        new Map([["bitrix:support", bitrix]]),
      ),
    );

    // `close` arrives without a change.diff, so the action is all a rule has to go by.
    const result = await trigger.execute({
      action: "close",
      type: "issue",
      data: {
        id: 8,
        ref: 13,
        subject: "Request",
        description: "**BitrixID:** 777",
        project: { permalink: "http://taiga.test/project/support", name: "Support" },
        status: { name: "Closed" },
      },
    });

    expect(result.triggered).toBe(1);
    expect(bitrix.updateStatus).toHaveBeenCalledWith({
      id: 777,
      status: "Closed",
      resolution: "Закрыто в Taiga",
    });
  });
});
