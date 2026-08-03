import { describe, test, expect, mock } from "bun:test";
import { getProviderOutputs } from "../../../src/core/provider-schema";
import { ProcessFormSubmissionUseCase } from "../../../src/modules/messenger/application/use-cases/process-form-submission";
import type { FormPipelineRunner } from "../../../src/modules/messenger/application/use-cases/process-form-submission";
import type { Config, Provider } from "../../../src/core/config";
import type { Rule } from "../../../src/modules/messenger/domain/entities/notification";
import type { IMessengerClient } from "../../../src/modules/messenger/application/ports/messenger-client.port";

const PROVIDERS: Provider[] = [
  { type: "form", alias: "support", title: "Заявка", blocks: [{ type: "input", name: "summary", label: "S" }] },
  { type: "pachka", alias: "helpdesk", chatId: 555 },
];

const PIPELINE: Rule[] = [
  {
    from: "form:support",
    to: "pachka:helpdesk",
    on: { content: { message: "📬 {{data.summary}} от {{user.first_name}}" } },
  },
];

function makeConfig(rules: Rule[][] = [PIPELINE]): Config {
  return { providers: PROVIDERS, rules };
}

function createMockRunner(): FormPipelineRunner {
  return { run: mock(() => Promise.resolve({ ok: true })) };
}

function createMockMessengerClient(user: unknown = { id: 9, first_name: "Ann" }): IMessengerClient {
  return {
    getUser: mock(() =>
      user instanceof Error ? Promise.reject(user) : Promise.resolve(user),
    ),
  } as unknown as IMessengerClient;
}

describe("ProcessFormSubmissionUseCase.matches", () => {
  test("matches form callback ids only", () => {
    expect(ProcessFormSubmissionUseCase.matches("form:support")).toBe(true);
    expect(ProcessFormSubmissionUseCase.matches("taiga:support")).toBe(false);
    expect(ProcessFormSubmissionUseCase.matches(undefined)).toBe(false);
    expect(ProcessFormSubmissionUseCase.matches(42)).toBe(false);
  });
});

describe("ProcessFormSubmissionUseCase.execute", () => {
  test("runs the pipeline whose first step matches the callback_id", async () => {
    const runner = createMockRunner();
    const useCase = new ProcessFormSubmissionUseCase(makeConfig(), runner, createMockMessengerClient());

    const result = await useCase.execute({
      callbackId: "form:support",
      data: { summary: "Сломалось" },
      userId: 9,
      chatId: 555,
      privateMetadata: JSON.stringify({ formRef: "form:support", correlationId: "issue-42" }),
    });

    expect(result.ok).toBe(true);
    const [pipeline, trigger] = (runner.run as ReturnType<typeof mock>).mock.calls[0];
    expect(pipeline).toBe(PIPELINE);
    expect(trigger.data).toEqual({ summary: "Сломалось" });
    expect(trigger.user).toEqual({ id: 9, first_name: "Ann" });
    expect(trigger.userId).toBe(9);
    expect(trigger.chatId).toBe(555);
    expect(trigger.meta).toEqual({ formRef: "form:support", correlationId: "issue-42" });
    expect(typeof trigger.receivedAt).toBe("string");
    expect(trigger.receivedAt.length).toBeGreaterThan(0);
    // Drift guard: the trigger must expose exactly the declared form trigger schema.
    expect([...Object.keys(trigger)].sort()).toEqual([...getProviderOutputs("form", "trigger")].sort());
  });

  test("fails when no pipeline starts from the callback_id", async () => {
    const runner = createMockRunner();
    const useCase = new ProcessFormSubmissionUseCase(makeConfig([]), runner, createMockMessengerClient());

    const result = await useCase.execute({ callbackId: "form:support", data: {} });

    expect(result.ok).toBe(false);
    expect((runner.run as ReturnType<typeof mock>).mock.calls.length).toBe(0);
  });

  test("tolerates getUser failure — user is null, pipeline still runs", async () => {
    const runner = createMockRunner();
    const useCase = new ProcessFormSubmissionUseCase(
      makeConfig(),
      runner,
      createMockMessengerClient(new Error("404")),
    );

    const result = await useCase.execute({ callbackId: "form:support", data: { summary: "x" }, userId: 9 });

    expect(result.ok).toBe(true);
    const trigger = (runner.run as ReturnType<typeof mock>).mock.calls[0][1];
    expect(trigger.user).toBeNull();
  });

  test("file_input values are normalized to markdown links, other values untouched", async () => {
    const runner = createMockRunner();
    const useCase = new ProcessFormSubmissionUseCase(makeConfig(), runner, null);

    await useCase.execute({
      callbackId: "form:support",
      data: {
        summary: "x",
        tags: ["a", "b"],
        attachments: [
          { name: "log.txt", size: 10, url: "https://files.test/log.txt" },
          { size: 5, url: "https://files.test/raw" },
        ],
      },
    });

    const trigger = (runner.run as ReturnType<typeof mock>).mock.calls[0][1];
    expect(trigger.data.attachments).toBe(
      "[log.txt](https://files.test/log.txt), [https://files.test/raw](https://files.test/raw)",
    );
    expect(trigger.data.summary).toBe("x");
    expect(trigger.data.tags).toEqual(["a", "b"]);
  });

  test("invalid private_metadata JSON yields empty meta; missing data yields empty object", async () => {
    const runner = createMockRunner();
    const useCase = new ProcessFormSubmissionUseCase(makeConfig(), runner, null);

    const result = await useCase.execute({ callbackId: "form:support", privateMetadata: "not-json" });

    expect(result.ok).toBe(true);
    const trigger = (runner.run as ReturnType<typeof mock>).mock.calls[0][1];
    expect(trigger.meta).toEqual({});
    expect(trigger.data).toEqual({});
    expect(trigger.user).toBeNull();
  });
});
