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
import { ProcessTaigaWebhookUseCase } from "../../src/modules/taiga/application/use-cases/process-taiga-webhook";
import { HandleTaigaFeedbackUseCase } from "../../src/modules/taiga/application/use-cases/handle-taiga-feedback";
import type { ITaigaApiClient } from "../../src/modules/taiga/application/ports/taiga-api.port";

function client(): IBitrixClient {
  return {
    updateStatus: mock(() => Promise.resolve({ status: "ok", data: [], errors: [] })),
  };
}

describe("Bitrix status integration", () => {
  test("callback waits for change webhook; repeated webhook is deduplicated", async () => {
    const bitrix = client();
    const providers: Provider[] = [
      { type: "taiga", alias: "support", baseUrl: "http://taiga.test", project: "support",
        feedback: { statuses: { close: "Closed" } } },
      { type: "bitrix", alias: "support", baseUrl: "http://bitrix.test/api" },
    ];
    const config: Config = { providers, rules: [[{
      from: "taiga:support", to: "bitrix:support",
      on: { action: "change", status: "Closed", content: { status: "Closed" } },
    }]] };
    const registry = new ProviderRegistry(providers);
    const transitions = new ProcessTaigaWebhookUseCase(registry, null, null, config,
      new Map([["bitrix:support", bitrix]]));
    const taiga: ITaigaApiClient = {
      getProjectBySlug: mock(async () => ({ id: 1, slug: "support", name: "Support" })),
      getItemStatuses: mock(async () => [{ id: 2, name: "Closed" }]),
      getItem: mock(async () => ({ id: 7, ref: 12, subject: "Request", description: "BitrixID: 654",
        version: 1, status: 1, statusName: "New", assigneeName: null, typeId: null, priorityId: null })),
      updateItem: mock(async () => {}),
      createItem: mock(), getIssueTypes: mock(), getPriorities: mock(), getMemberIdByEmail: mock(),
    };
    const feedback = new HandleTaigaFeedbackUseCase(registry, new Map([["taiga:support", taiga]]),
      null, config, null);
    expect((await feedback.execute({ data: "taiga:support:close:7" })).ok).toBe(true);
    expect(bitrix.updateStatus).not.toHaveBeenCalled();
    const webhook = {
      action: "change", type: "issue",
      data: { id: 7, description: "BitrixID: 654", status: { name: "Closed" },
        project: { permalink: "http://taiga.test/project/support" } },
      change: { diff: { status: { from: "New", to: "Closed" } } },
    };
    await transitions.execute(webhook);
    expect(bitrix.updateStatus).toHaveBeenCalledTimes(1);
    await transitions.execute(webhook);
    expect(bitrix.updateStatus).toHaveBeenCalledTimes(1);
    // A different item's manual status change must also match the close rule.
    await transitions.execute({ ...webhook, data: { ...webhook.data, id: 8 } });
    expect(bitrix.updateStatus).toHaveBeenCalledTimes(2);
    // Reopening allows a later close to be delivered again.
    await transitions.execute({ ...webhook, data: { ...webhook.data, status: { name: "New" } } });
    await transitions.execute(webhook);
    expect(bitrix.updateStatus).toHaveBeenCalledTimes(3);
  });
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

  test("executes the Taiga to Bitrix pipeline on Closed/Rejected status webhook", async () => {
    const bitrix = client();
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
            action: "change",
            status: "Closed",
            content: { status: "Closed", resolution: "Закрыто в Taiga" },
          },
        }],
        [{
          from: "taiga:support",
          to: "bitrix:support",
          on: {
            action: "change",
            status: "Rejected",
            content: { status: "Rejected", resolution: "Отклонено в Taiga" },
          },
        }],
      ],
    };
    const useCase = new ProcessTaigaWebhookUseCase(
      new ProviderRegistry(providers),
      null,
      null,
      config,
      new Map([["bitrix:support", bitrix]]),
    );

    const result = await useCase.execute({
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

    expect(result.bitrixUpdated).toBe(1);
    expect(bitrix.updateStatus).toHaveBeenCalledWith({
      id: 654,
      status: "Closed",
      resolution: "Закрыто в Taiga",
    });

    await useCase.execute({
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

  test("ignores close callback action as a webhook", async () => {
    const bitrix = client();
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
          action: "change",
          status: "Closed",
          content: { status: "Closed", resolution: "Закрыто в Taiga" },
        },
      }]],
    };
    const useCase = new ProcessTaigaWebhookUseCase(
      new ProviderRegistry(providers),
      null,
      null,
      config,
      new Map([["bitrix:support", bitrix]]),
    );

    const result = await useCase.execute({
      action: "close",
      type: "issue",
      data: {
        id: 8,
        ref: 13,
        subject: "Request",
        description: "**BitrixID:** 765",
        project: { permalink: "http://taiga.test/project/support", name: "Support" },
        status: { name: "Closed" },
      },
    });

    expect(result.bitrixUpdated).toBe(0);
    expect(bitrix.updateStatus).not.toHaveBeenCalled();
  });
});
