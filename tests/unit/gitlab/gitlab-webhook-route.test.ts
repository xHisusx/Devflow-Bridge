import { describe, test, expect, mock } from "bun:test";
import { gitlabWebhookRoute } from "../../../src/modules/gitlab/infrastructure/webhooks/gitlab-webhook.route";
import type { ProcessGitLabTriggerUseCase } from "../../../src/modules/gitlab/application/use-cases/process-gitlab-trigger";

const PAYLOAD = {
  object_kind: "merge_request",
  project: { path_with_namespace: "team/backend" },
  object_attributes: { iid: 7, action: "merge", state: "merged", target_branch: "master" },
};

function triggerMock() {
  return {
    execute: mock(() => Promise.resolve({ ok: true, triggered: 1 })),
  } as unknown as ProcessGitLabTriggerUseCase;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function post(app: any, opts: { token?: string; body?: string } = {}) {
  return app.handle(
    new Request("http://localhost/webhook/gitlab", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(opts.token ? { "X-Gitlab-Token": opts.token } : {}),
        "X-Gitlab-Event": "Merge Request Hook",
      },
      body: opts.body ?? JSON.stringify(PAYLOAD),
    }),
  );
}

describe("POST /webhook/gitlab", () => {
  test("a valid secret token lets the event through", async () => {
    const trigger = triggerMock();
    const app = gitlabWebhookRoute({ trigger, secrets: ["s3cret"] });

    const res = await post(app, { token: "s3cret" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, triggered: 1 });
    expect(trigger.execute).toHaveBeenCalledTimes(1);
  });

  test("a wrong or missing token is 401 and never reaches the pipeline", async () => {
    const trigger = triggerMock();
    const app = gitlabWebhookRoute({ trigger, secrets: ["s3cret"] });

    expect((await post(app, { token: "nope" })).status).toBe(401);
    expect((await post(app)).status).toBe(401);
    expect(trigger.execute).not.toHaveBeenCalled();
  });

  test("any of the configured secrets is accepted (one per provider)", async () => {
    const trigger = triggerMock();
    const app = gitlabWebhookRoute({ trigger, secrets: ["first", "second"] });

    expect((await post(app, { token: "second" })).status).toBe(200);
  });

  test("without configured secrets the payload is accepted unverified", async () => {
    const trigger = triggerMock();
    const app = gitlabWebhookRoute({ trigger, secrets: [] });

    expect((await post(app)).status).toBe(200);
  });

  test("a body that is not JSON is 400", async () => {
    const app = gitlabWebhookRoute({ trigger: triggerMock(), secrets: [] });

    const res = await post(app, { body: "not json" });

    expect(res.status).toBe(400);
  });

  test("with no gitlab pipelines configured the endpoint still answers 200", async () => {
    const app = gitlabWebhookRoute({ trigger: null });

    const res = await post(app);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, triggered: 0 });
  });

  test("a failing pipeline does not turn into a 500 for GitLab", async () => {
    const trigger = {
      execute: mock(() => Promise.reject(new Error("boom"))),
    } as unknown as ProcessGitLabTriggerUseCase;
    const app = gitlabWebhookRoute({ trigger, secrets: [] });

    const res = await post(app);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, triggered: 0 });
  });
});
