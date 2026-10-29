import { describe, expect, test } from "bun:test";
import { createApp } from "../../../src/app";
import { ProviderRegistry } from "../../../src/core/provider-registry";
import type { Config, Provider } from "../../../src/core/config";
import { bitrixClientMock, messageStoreMock, messengerClientMock, taigaClientMock } from "../../mocks";

/**
 * The Taiga -> Bitrix path runs through the generic trigger engine, which createApp only wires up
 * when the config asks for it. These tests go through the HTTP route so a rewiring cannot quietly
 * disconnect Bitrix.
 */
const PROVIDERS: Provider[] = [
  { type: "taiga", alias: "ikn", baseUrl: "http://taiga.test", project: "support" },
  { type: "bitrix", alias: "support", baseUrl: "http://bitrix.test/api" },
];

const CONFIG: Config = {
  providers: PROVIDERS,
  rules: [[{
    from: "taiga:ikn",
    to: "bitrix:support",
    on: {
      action: "close",
      status: "Closed",
      content: { status: "Closed", resolution: "Обращение закрыто в Taiga" },
    },
  }]],
};

function app(bitrix = bitrixClientMock()) {
  const registry = new ProviderRegistry(PROVIDERS);
  const instance = createApp({
    config: CONFIG,
    registry,
    pachkaClient: messengerClientMock(),
    messageStore: messageStoreMock(),
    projectIdMap: new Map(),
    projectIdentifierMap: new Map(),
    memberMap: new Map(),
    taigaClients: new Map([["taiga:ikn", taigaClientMock()]]),
    bitrixClients: new Map([["bitrix:support", bitrix]]),
  });
  return { instance, bitrix };
}

function closePayload(status: string) {
  return {
    action: "close",
    type: "issue",
    data: {
      id: 7,
      ref: 12,
      subject: "Request",
      description: "**BitrixID:** 654",
      project: { permalink: "http://taiga.test/project/support", name: "Support" },
      status: { name: status },
    },
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function post(instance: any, payload: unknown) {
  return instance.handle(
    new Request("http://localhost/webhook/taiga", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }),
  );
}

describe("POST /webhook/taiga -> Bitrix", () => {
  test("a close event reaches Bitrix with the item's appeal id", async () => {
    const { instance, bitrix } = app();

    const res = await post(instance, closePayload("Closed"));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, updated: 0, triggered: 1 });
    expect(bitrix.updateStatus).toHaveBeenCalledWith({
      id: 654,
      status: "Closed",
      resolution: "Обращение закрыто в Taiga",
    });
  });

  test("a status the rule does not ask for leaves Bitrix alone", async () => {
    const { instance, bitrix } = app();

    const res = await post(instance, closePayload("In progress"));

    expect(res.status).toBe(200);
    expect(bitrix.updateStatus).not.toHaveBeenCalled();
  });

  test("Taiga's test ping is answered without touching Bitrix", async () => {
    const { instance, bitrix } = app();

    const res = await post(instance, { action: "test", type: "issue", data: { id: 1 } });

    expect(res.status).toBe(200);
    expect(bitrix.updateStatus).not.toHaveBeenCalled();
  });
});
