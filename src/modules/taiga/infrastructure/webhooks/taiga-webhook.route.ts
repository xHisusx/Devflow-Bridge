import { Elysia } from "elysia";
import type { ProcessTaigaWebhookUseCase, TaigaWebhookPayload } from "../../application/use-cases/process-taiga-webhook";
import { verifyTaigaSignature } from "../services/taiga-webhook-verifier";
import { log } from "../../../../core/logger";

export interface TaigaWebhookRouteDeps {
  useCase: ProcessTaigaWebhookUseCase;
  /** Secret configured on the Taiga webhook; when set, signatures are enforced. */
  webhookSecret?: string;
}

export function taigaWebhookRoute(deps: TaigaWebhookRouteDeps) {
  const { useCase, webhookSecret } = deps;

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

      const result = await useCase.execute(payload);
      return { ok: true, updated: result.updated };
    });
}
