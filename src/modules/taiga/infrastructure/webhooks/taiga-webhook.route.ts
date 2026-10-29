import { Elysia } from "elysia";
import type { ProcessTaigaWebhookUseCase, TaigaWebhookPayload } from "../../application/use-cases/process-taiga-webhook";
import type { ProcessTaigaTriggerUseCase } from "../../application/use-cases/process-taiga-trigger";
import { verifyTaigaSignature } from "../services/taiga-webhook-verifier";
import { log } from "../../../../core/logger";

export interface TaigaWebhookRouteDeps {
  useCase: ProcessTaigaWebhookUseCase;
  /** Pipelines triggered by Taiga events (`from: "taiga:<alias>"`). Null when none are configured. */
  trigger?: ProcessTaigaTriggerUseCase | null;
  /** Secret configured on the Taiga webhook; when set, signatures are enforced. */
  webhookSecret?: string;
}

export function taigaWebhookRoute(deps: TaigaWebhookRouteDeps) {
  const { useCase, trigger, webhookSecret } = deps;

  return new Elysia()
    .post("/webhook/taiga", async ({ request }) => {
      const rawBody = await request.text();

      if (webhookSecret) {
        const signature = request.headers.get("x-taiga-webhook-signature") ?? "";
        const valid = await verifyTaigaSignature(rawBody, signature, webhookSecret);
        if (!valid) {
          log.warn("Invalid Taiga webhook signature");
          return new Response(JSON.stringify({ error: "invalid signature" }), {
            status: 401,
            headers: { "Content-Type": "application/json" },
          });
        }
      }

      const payload: TaigaWebhookPayload = JSON.parse(rawBody);
      log.debug("Taiga webhook", { action: payload.action, type: payload.type, id: payload.data?.id });

      // Message sync and trigger pipelines are independent: one event can both refresh a tracked
      // card and start a pipeline, and a failure in either must not hide the other.
      const [sync, triggered] = await Promise.all([
        useCase.execute(payload).catch((e) => {
          log.error("Taiga webhook: message sync failed", { error: String(e) });
          return { ok: false, updated: 0 };
        }),
        trigger
          ? trigger.execute(payload).catch((e) => {
              log.error("Taiga webhook: trigger failed", { error: String(e) });
              return { ok: false, triggered: 0 };
            })
          : Promise.resolve({ ok: true, triggered: 0 }),
      ]);

      return { ok: true, updated: sync.updated, triggered: triggered.triggered };
    });
}
