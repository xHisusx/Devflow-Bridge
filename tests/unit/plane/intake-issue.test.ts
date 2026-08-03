import { describe, test, expect, mock } from "bun:test";
import { Elysia } from "elysia";
import { intakeIssueRoute } from "../../../src/modules/plane/infrastructure/routes/intake-issue.route";
import { ProcessIntakePipelineUseCase, IntakePipelineError } from "../../../src/modules/plane/application/use-cases/process-intake-pipeline";

function createMockPipeline(result = {
  ok: true as const,
  id: "intake-123",
  issue_id: "issue-456",
  attachments: [] as string[],
  notifications_sent: 0,
}) {
  return {
    execute: mock(() => Promise.resolve(result)),
  } as unknown as ProcessIntakePipelineUseCase;
}

function createFailPipeline(error: Error) {
  return {
    execute: mock(() => Promise.reject(error)),
  } as unknown as ProcessIntakePipelineUseCase;
}

function createApp(pipeline: ProcessIntakePipelineUseCase) {
  return new Elysia().use(
    intakeIssueRoute({ intakePipeline: pipeline, endpoint: "/api/plane/intake-issues", triggerRef: "api:intake" }),
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function postJson(app: any, body: Record<string, unknown>) {
  return app.handle(
    new Request("http://localhost/api/plane/intake-issues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

describe("POST /api/plane/intake-issues (route)", () => {
  test("201 on valid JSON request", async () => {
    const pipeline = createMockPipeline();
    const app = createApp(pipeline);

    const res = await postJson(app, { name: "Test issue" });

    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json).toEqual({ ok: true, id: "intake-123", issue_id: "issue-456", attachments: [] });
  });

  test("passes raw body to pipeline", async () => {
    const pipeline = createMockPipeline();
    const app = createApp(pipeline);

    await postJson(app, { name: "Test", description: "<p>X</p>", labels: ["Bug"], extra: 42 });

    const call = (pipeline.execute as ReturnType<typeof mock>).mock.calls[0][0];
    expect(call.body).toEqual({ name: "Test", description: "<p>X</p>", labels: ["Bug"], extra: 42 });
    expect(call.files).toBeUndefined();
  });

  test("400 when pipeline returns ok: false", async () => {
    const pipeline = createMockPipeline({
      ok: false as any,
      id: undefined as any,
      issue_id: undefined as any,
      attachments: [],
      notifications_sent: 0,
    });
    const app = createApp(pipeline);

    const res = await postJson(app, { name: "Test" });

    expect(res.status).toBe(400);
  });

  test("400 when pipeline throws IntakePipelineError", async () => {
    const pipeline = createFailPipeline(new IntakePipelineError("Labels not found: Foo"));
    const app = createApp(pipeline);

    const res = await postJson(app, { name: "Test" });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain("Labels not found: Foo");
  });

  test("parses multipart form data into body object", async () => {
    const pipeline = createMockPipeline();
    const app = createApp(pipeline);

    const formData = new FormData();
    formData.append("name", "Multipart issue");
    formData.append("description", "<p>desc</p>");

    const res = await app.handle(
      new Request("http://localhost/api/plane/intake-issues", {
        method: "POST",
        body: formData,
      }),
    );

    expect(res.status).toBe(201);
    const call = (pipeline.execute as ReturnType<typeof mock>).mock.calls[0][0];
    expect(call.body.name).toBe("Multipart issue");
    expect(call.body.description).toBe("<p>desc</p>");
  });

  test("parses JSON-stringified labels in multipart", async () => {
    const pipeline = createMockPipeline();
    const app = createApp(pipeline);

    const formData = new FormData();
    formData.append("name", "JSON labels");
    formData.append("labels", JSON.stringify(["Bug", "Urgent"]));

    const res = await app.handle(
      new Request("http://localhost/api/plane/intake-issues", {
        method: "POST",
        body: formData,
      }),
    );

    expect(res.status).toBe(201);
    const call = (pipeline.execute as ReturnType<typeof mock>).mock.calls[0][0];
    expect(call.body.labels).toEqual(["Bug", "Urgent"]);
  });

  test("passes files from multipart to pipeline", async () => {
    const pipeline = createMockPipeline();
    const app = createApp(pipeline);

    const formData = new FormData();
    formData.append("name", "With file");
    formData.append("attachments", new File(["content"], "test.txt", { type: "text/plain" }));

    const res = await app.handle(
      new Request("http://localhost/api/plane/intake-issues", {
        method: "POST",
        body: formData,
      }),
    );

    expect(res.status).toBe(201);
    const call = (pipeline.execute as ReturnType<typeof mock>).mock.calls[0][0];
    expect(call.files).toHaveLength(1);
    expect(call.files[0].name).toBe("test.txt");
  });

  describe("API key auth", () => {
    const API_KEY = "test-intake-key-123";

    function createAuthApp(pipeline: ProcessIntakePipelineUseCase) {
      return new Elysia().use(
        intakeIssueRoute({
          intakePipeline: pipeline,
          endpoint: "/api/plane/intake-issues",
          triggerRef: "api:intake",
          apiKey: API_KEY,
        }),
      );
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async function postWithHeaders(app: any, headers: Record<string, string>) {
      return app.handle(
        new Request("http://localhost/api/plane/intake-issues", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...headers },
          body: JSON.stringify({ name: "Test" }),
        }),
      );
    }

    test("401 without key, pipeline not called", async () => {
      const pipeline = createMockPipeline();
      const app = createAuthApp(pipeline);

      const res = await postWithHeaders(app, {});

      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json).toEqual({ ok: false, error: "Unauthorized" });
      expect((pipeline.execute as ReturnType<typeof mock>).mock.calls.length).toBe(0);
    });

    test("401 with wrong Bearer key", async () => {
      const pipeline = createMockPipeline();
      const app = createAuthApp(pipeline);

      const res = await postWithHeaders(app, { Authorization: "Bearer wrong-key" });

      expect(res.status).toBe(401);
      expect((pipeline.execute as ReturnType<typeof mock>).mock.calls.length).toBe(0);
    });

    test("201 with correct Bearer key", async () => {
      const pipeline = createMockPipeline();
      const app = createAuthApp(pipeline);

      const res = await postWithHeaders(app, { Authorization: `Bearer ${API_KEY}` });

      expect(res.status).toBe(201);
    });

    test("201 with correct X-API-Key header", async () => {
      const pipeline = createMockPipeline();
      const app = createAuthApp(pipeline);

      const res = await postWithHeaders(app, { "X-API-Key": API_KEY });

      expect(res.status).toBe(201);
    });

    test("no auth check when apiKey is not configured", async () => {
      const pipeline = createMockPipeline();
      const app = createApp(pipeline); // no apiKey in deps

      const res = await postJson(app, { name: "Test" });

      expect(res.status).toBe(201);
    });
  });

  describe("body field validation (fields)", () => {
    const FIELDS = {
      section: { required: true, values: ["Реестр контрактов", "KPI"] },
    };

    function createValidatingApp(pipeline: ProcessIntakePipelineUseCase) {
      return new Elysia().use(
        intakeIssueRoute({
          intakePipeline: pipeline,
          endpoint: "/api/plane/intake-issues",
          triggerRef: "api:intake",
          fields: FIELDS,
        }),
      );
    }

    test("400 when required field missing, pipeline not called", async () => {
      const pipeline = createMockPipeline();
      const app = createValidatingApp(pipeline);

      const res = await postJson(app, { name: "Test" });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error).toContain('"section" is required');
      expect((pipeline.execute as ReturnType<typeof mock>).mock.calls.length).toBe(0);
    });

    test("400 when field value not in enum", async () => {
      const pipeline = createMockPipeline();
      const app = createValidatingApp(pipeline);

      const res = await postJson(app, { name: "Test", section: "Другое" });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toContain('invalid value "Другое"');
      expect(json.error).toContain("KPI");
      expect((pipeline.execute as ReturnType<typeof mock>).mock.calls.length).toBe(0);
    });

    test("201 when field value is allowed", async () => {
      const pipeline = createMockPipeline();
      const app = createValidatingApp(pipeline);

      const res = await postJson(app, { name: "Test", section: "KPI" });

      expect(res.status).toBe(201);
      const call = (pipeline.execute as ReturnType<typeof mock>).mock.calls[0][0];
      expect(call.body.section).toBe("KPI");
    });

    test("validates multipart bodies too", async () => {
      const pipeline = createMockPipeline();
      const app = createValidatingApp(pipeline);

      const formData = new FormData();
      formData.append("name", "Test");
      formData.append("section", "Другое");

      const res = await app.handle(
        new Request("http://localhost/api/plane/intake-issues", {
          method: "POST",
          body: formData,
        }),
      );

      expect(res.status).toBe(400);
    });
  });

  test("multiple labels in multipart accumulated as array", async () => {
    const pipeline = createMockPipeline();
    const app = createApp(pipeline);

    const formData = new FormData();
    formData.append("name", "Multi labels");
    formData.append("labels", "Bug");
    formData.append("labels", "Urgent");

    const res = await app.handle(
      new Request("http://localhost/api/plane/intake-issues", {
        method: "POST",
        body: formData,
      }),
    );

    expect(res.status).toBe(201);
    const call = (pipeline.execute as ReturnType<typeof mock>).mock.calls[0][0];
    expect(call.body.labels).toEqual(["Bug", "Urgent"]);
  });
});
