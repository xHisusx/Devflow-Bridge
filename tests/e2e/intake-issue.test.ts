import { describe, test, expect, afterAll, beforeAll } from "bun:test";
import { join } from "path";
import { Elysia } from "elysia";
import { PlaneClient } from "../../src/modules/plane/infrastructure/clients/plane-api-client";
import { ProcessIntakePipelineUseCase } from "../../src/modules/plane/application/use-cases/process-intake-pipeline";
import { intakeIssueRoute } from "../../src/modules/plane/infrastructure/routes/intake-issue.route";
import { ProviderRegistry } from "../../src/core/provider-registry";
import type { Config, Provider } from "../../src/core/config";

function getPlaneTestEnv() {
  const apiKey = process.env.PLANE_API_KEY;
  const baseUrl = process.env.PLANE_TEST_BASE_URL;
  const workspace = process.env.PLANE_TEST_WORKSPACE;
  const projectId = process.env.PLANE_TEST_PROJECT_ID;

  if (!apiKey) throw new Error("PLANE_API_KEY env variable is required for Plane E2E tests");
  if (!baseUrl) throw new Error("PLANE_TEST_BASE_URL env variable is required for Plane E2E tests");
  if (!workspace) throw new Error("PLANE_TEST_WORKSPACE env variable is required for Plane E2E tests");
  if (!projectId) throw new Error("PLANE_TEST_PROJECT_ID env variable is required for Plane E2E tests");

  return { apiKey, baseUrl, workspace, projectId };
}

describe("E2E: Intake Issue", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let app: any;
  let baseUrl: string;
  let workspace: string;
  let projectId: string;
  let planeBaseUrl: string;
  let apiKey: string;
  const createdIssueIds: string[] = [];

  beforeAll(async () => {
    const env = getPlaneTestEnv();
    workspace = env.workspace;
    projectId = env.projectId;
    planeBaseUrl = env.baseUrl;
    apiKey = env.apiKey;

    const planeClient = new PlaneClient(env.baseUrl, env.apiKey);

    // Resolve project name for provider config
    const projects = await planeClient.getProjects(workspace);
    const project = projects.find((p) => p.id === projectId);
    if (!project) throw new Error(`Project ${projectId} not found in workspace ${workspace}`);

    const providers: Provider[] = [
      {
        type: "plane",
        alias: "test",
        baseUrl: env.baseUrl,
        workspace,
        project: project.name,
      },
      { type: "api", alias: "intake", endpoint: "/api/plane/intake-issues" },
    ];

    const registry = new ProviderRegistry(providers);

    const config: Config = {
      providers,
      rules: [
        [
          {
            from: "api:intake",
            to: "plane:test",
            on: {
              action: "create" as const,
              entity: "task" as const,
              content: {
                name: "{{body.name}}",
                description: "{{body.description}}",
                labels: "{{body.labels}}",
              },
            },
          },
        ],
      ],
    };

    const intakePipeline = new ProcessIntakePipelineUseCase(
      config, registry, new Map([["plane:test", planeClient]]), null, null,
    );

    app = new Elysia().use(
      intakeIssueRoute({ intakePipeline, endpoint: "/api/plane/intake-issues", triggerRef: "api:intake" }),
    );
    app.listen(0);
    baseUrl = `http://localhost:${app.server!.port}`;
  });

  afterAll(async () => {
    for (const id of createdIssueIds) {
      try {
        await fetch(
          `${planeBaseUrl}/api/v1/workspaces/${workspace}/projects/${projectId}/work-items/${id}/`,
          { method: "DELETE", headers: { "X-API-Key": apiKey } },
        );
      } catch {
        // ignore cleanup errors
      }
    }
    await app.stop();
  });

  test("creates intake issue with name only", async () => {
    const name = `E2E-intake-${Date.now()}`;
    const res = await fetch(`${baseUrl}/api/plane/intake-issues`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.id).toBeDefined();
    createdIssueIds.push(json.issue_id);
  });

  test("creates intake issue with description", async () => {
    const name = `E2E-intake-desc-${Date.now()}`;
    const res = await fetch(`${baseUrl}/api/plane/intake-issues`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, description: "<p>Test description from E2E</p>" }),
    });
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.ok).toBe(true);
    createdIssueIds.push(json.issue_id);
  });

  test("creates intake issue with attachment via multipart", async () => {
    const name = `E2E-intake-attach-${Date.now()}`;
    const file = new File(["hello from e2e test"], "test-attachment.txt", { type: "text/plain" });
    const formData = new FormData();
    formData.append("name", name);
    formData.append("attachments", file);
    const res = await fetch(`${baseUrl}/api/plane/intake-issues`, {
      method: "POST",
      body: formData,
    });
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.attachments).toHaveLength(1);
    createdIssueIds.push(json.issue_id);
  });

  test("creates intake issue with two image attachments from disk", async () => {
    const name = `E2E-intake-png-${Date.now()}`;
    const imagePath = join(import.meta.dir, "..", "assets", "test.png");
    const imageBuffer = await Bun.file(imagePath).arrayBuffer();
    const file1 = new File([imageBuffer], "test1.png", { type: "image/png" });
    const file2 = new File([imageBuffer], "test2.png", { type: "image/png" });
    const formData = new FormData();
    formData.append("name", name);
    formData.append("description", "<p>Issue with two PNG attachments</p>");
    formData.append("attachments", file1);
    formData.append("attachments", file2);
    const res = await fetch(`${baseUrl}/api/plane/intake-issues`, {
      method: "POST",
      body: formData,
    });
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.attachments).toHaveLength(2);
    createdIssueIds.push(json.issue_id);
  }, 30_000);

  test("creates intake issue with labels", async () => {
    const labelsRes = await fetch(
      `${planeBaseUrl}/api/v1/workspaces/${workspace}/projects/${projectId}/labels/`,
      { headers: { "X-API-Key": apiKey } },
    );
    const labelsData = (await labelsRes.json()) as { results: { id: string; name: string }[] };
    const existingLabels = labelsData.results;
    if (existingLabels.length === 0) {
      console.warn("No labels in test project, skipping labels E2E test");
      return;
    }
    const labelName = existingLabels[0].name;
    const name = `E2E-intake-labels-${Date.now()}`;
    const res = await fetch(`${baseUrl}/api/plane/intake-issues`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, labels: [labelName] }),
    });
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.ok).toBe(true);
    createdIssueIds.push(json.issue_id);
  });

  test("returns 400 for non-existent label", async () => {
    const res = await fetch(`${baseUrl}/api/plane/intake-issues`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: `E2E-bad-label-${Date.now()}`,
        labels: ["ThisLabelDoesNotExist_12345"],
      }),
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.ok).toBe(false);
    expect(json.error).toContain("ThisLabelDoesNotExist_12345");
  });

  test("returns 400 for missing required fields", async () => {
    const res = await fetch(`${baseUrl}/api/plane/intake-issues`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.ok).toBe(false);
  });
});
