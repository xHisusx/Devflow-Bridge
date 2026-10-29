import { Elysia } from "elysia";
import { createHash, timingSafeEqual } from "node:crypto";
import type { ProcessGitLabTriggerUseCase } from "../../application/use-cases/process-gitlab-trigger";
import type { GitLabWebhookPayload } from "../../domain/entities/gitlab-webhook-payload";
import { log } from "../../../../core/logger";

export interface GitLabWebhookRouteDeps {
  /** Pipelines triggered by GitLab events (`from: "gitlab:<alias>"`). Null when none exist. */
  trigger: ProcessGitLabTriggerUseCase | null;
  /**
   * Secret tokens configured on the GitLab webhooks (one per provider). When the list is not
   * empty, `X-Gitlab-Token` must match one of them. GitLab sends the secret verbatim — there is
   * no signature to verify — so the comparison is constant-time over hashes.
   */
  secrets?: string[];
}

function isAuthorized(token: string | null, secrets: string[]): boolean {
  if (secrets.length === 0) return true;
  if (!token) return false;
  const candidate = createHash("sha256").update(token).digest();
  return secrets.some((secret) =>
    timingSafeEqual(candidate, createHash("sha256").update(secret).digest()),
  );
}

export function gitlabWebhookRoute(deps: GitLabWebhookRouteDeps) {
  const { trigger } = deps;
  const secrets = (deps.secrets ?? []).filter(Boolean);

  return new Elysia().post("/webhook/gitlab", async ({ request }) => {
    if (!isAuthorized(request.headers.get("x-gitlab-token"), secrets)) {
      log.warn("Invalid GitLab webhook token");
      return new Response(JSON.stringify({ ok: false, error: "invalid token" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    let payload: GitLabWebhookPayload;
    try {
      payload = (await request.json()) as GitLabWebhookPayload;
    } catch (e) {
      log.warn("GitLab webhook: invalid JSON body", { error: String(e) });
      return new Response(JSON.stringify({ ok: false, error: "invalid body" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    log.debug("GitLab webhook", {
      event: request.headers.get("x-gitlab-event"),
      kind: payload.object_kind,
      repo: payload.project?.path_with_namespace,
      action: payload.object_attributes?.action,
    });

    if (!trigger) return { ok: true, triggered: 0 };

    const result = await trigger.execute(payload).catch((e) => {
      log.error("GitLab webhook: trigger failed", { error: String(e) });
      return { ok: false, triggered: 0 };
    });

    return { ok: true, triggered: result.triggered };
  });
}
