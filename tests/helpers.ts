import type { PlaneWebhookPayload, PlaneStateInline } from "../src/modules/plane/domain/entities";
import type { Config, Provider } from "../src/core/config";
import { PachkaClient } from "../src/modules/messenger/infrastructure/clients/pachka-api-client";
import { MessageStore } from "../src/modules/messenger/infrastructure/persistence/sqlite-message-store";
import { ProviderRegistry } from "../src/core/provider-registry";
import { createApp, type AppDependencies } from "../src/app";

// ── Webhook payload factory ──

const TEST_PROJECT_ID = "test-project-uuid-001";

interface PayloadOverrides {
  issueId?: string;
  action?: "created" | "updated" | "deleted";
  issueName?: string;
  sequenceId?: number;
  state?: PlaneStateInline | null;
  priority?: string;
  activity?: PlaneWebhookPayload["activity"];
  updatedAt?: string;
}

export function createWebhookPayload(overrides: PayloadOverrides = {}): PlaneWebhookPayload {
  const state: PlaneStateInline = overrides.state ?? {
    id: "state-001",
    name: "In Progress",
    color: "#f59e0b",
    group: "started",
  };

  return {
    event: "issue",
    action: overrides.action ?? "created",
    webhook_id: "wh-test-001",
    workspace_id: "ws-test-001",
    data: {
      id: overrides.issueId ?? crypto.randomUUID(),
      name: overrides.issueName ?? `Test Issue ${Date.now()}`,
      state,
      priority: overrides.priority ?? "medium",
      sequence_id: overrides.sequenceId ?? Math.floor(Math.random() * 9000) + 1000,
      project: TEST_PROJECT_ID,
      workspace: "test-ws",
      assignees: [],
      labels: [],
      created_at: new Date().toISOString(),
      updated_at: overrides.updatedAt ?? new Date().toISOString(),
    },
    activity: overrides.activity,
  };
}

// ── Test app factory ──

const TEST_PROVIDERS: Provider[] = [
  {
    type: "plane",
    alias: "test",
    baseUrl: "http://plane.test.local",
    workspace: "test-ws",
    project: "TestProject",
  },
  { type: "pachka", alias: "test-target", chatId: 0 }, // chatId set in createTestApp
];

export function createTestApp(chatId: number): { app: ReturnType<typeof createApp>; store: MessageStore } {
  const providers: Provider[] = [
    TEST_PROVIDERS[0],
    { type: "pachka" as const, alias: "test-target", chatId },
  ];

  const config: Config = {
    providers,
    rules: [
      [
        {
          from: "plane:test",
          to: "pachka:test-target",
          on: {
            action: "create",
            content: {
              message: "[E2E-TEST] #{{seq}} {{title}} ({{state}})",
            },
          },
        },
      ],
      [
        {
          from: "plane:test",
          to: "pachka:test-target",
          on: {
            action: "update",
            state: "Done",
            content: {
              message: "[E2E-DONE] #{{seq}} {{title}}",
              actions: [
                { type: "reaction" as const, emoji: "\u2705" },
                { type: "threadReply" as const, message: "State: {{state}}" },
                { type: "buttons" as const, buttons: [{ text: "Open", url: "{{issueUrl}}" }] },
              ],
            },
          },
        },
      ],
      [
        {
          from: "plane:test",
          to: "pachka:test-target",
          on: {
            action: "update",
            stateGroup: ["backlog", "unstarted", "started", "cancelled"],
            content: {
              message: "[E2E-UPD] #{{seq}} {{title}}",
              actions: [
                { type: "editPrevious" as const, message: "[E2E-EDITED] #{{seq}} {{title}} -> {{state}}" },
              ],
            },
          },
        },
      ],
    ],
  };

  const token = process.env.PACHKA_TEST_TOKEN;
  if (!token) throw new Error("PACHKA_TEST_TOKEN is required for E2E tests");

  const pachkaClient = new PachkaClient(token);
  const store = new MessageStore(":memory:");
  const registry = new ProviderRegistry(providers);

  const projectIdMap = new Map<string, string>();
  projectIdMap.set("test-ws:TestProject", TEST_PROJECT_ID);

  const projectIdentifierMap = new Map<string, string>();
  projectIdentifierMap.set(TEST_PROJECT_ID, "TEST");

  const deps: AppDependencies = {
    config,
    registry,
    pachkaClient,
    messageStore: store,
    projectIdMap,
    projectIdentifierMap,
    memberMap: new Map(),
  };

  return { app: createApp(deps), store };
}

// ── HTTP helpers ──

export async function postWebhook(
  baseUrl: string,
  payload: PlaneWebhookPayload,
): Promise<Response> {
  return fetch(`${baseUrl}/webhook/plane`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-plane-event": payload.event,
    },
    body: JSON.stringify(payload),
  });
}

// ── Pachka verification helpers ──

export async function waitForMessage(
  client: PachkaClient,
  chatId: number,
  predicate: (msg: { id: number; content: string }) => boolean,
  timeoutMs = 10_000,
): Promise<{ id: number; content: string }> {
  const start = Date.now();
  let delay = 200;

  while (Date.now() - start < timeoutMs) {
    const messages = await client.getMessages(chatId, 20);
    const found = messages.find(predicate);
    if (found) return found;

    await Bun.sleep(delay);
    delay = Math.min(delay * 1.5, 2000);
  }

  throw new Error(`waitForMessage timed out after ${timeoutMs}ms`);
}

export async function cleanupMessages(client: PachkaClient, messageIds: number[]): Promise<void> {
  for (const id of messageIds) {
    try {
      await client.deleteMessage(id);
    } catch {
      // already deleted or not found — ignore
    }
  }
}

/** Delete all recent messages in a chat matching the E2E prefix pattern, including thread messages. */
export async function cleanupTestMessages(client: PachkaClient, chatId: number): Promise<void> {
  try {
    const messages = await client.getMessages(chatId, 50);
    const testMessages = messages.filter((m) =>
      m.content.startsWith("[E2E-") || m.content.startsWith("State: "),
    );
    for (const msg of testMessages) {
      try {
        // Check for thread and delete thread messages first
        const fullMsg = await client.getMessage(msg.id);
        if (fullMsg.thread) {
          const threadMessages = await client.getMessages(fullMsg.thread.chat_id, 50);
          for (const tm of threadMessages) {
            try { await client.deleteMessage(tm.id); } catch {}
          }
        }
        await client.deleteMessage(msg.id);
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore cleanup errors
  }
}

// ── Misc ──

export function getTestEnv() {
  const token = process.env.PACHKA_TEST_TOKEN;
  const chatId = Number(process.env.PACHKA_TEST_CHAT_ID);
  if (!token) throw new Error("PACHKA_TEST_TOKEN env variable is required for E2E tests");
  if (!chatId || isNaN(chatId)) throw new Error("PACHKA_TEST_CHAT_ID env variable is required for E2E tests");
  return { token, chatId };
}

export function getTestClient(): PachkaClient {
  const { token } = getTestEnv();
  return new PachkaClient(token);
}
