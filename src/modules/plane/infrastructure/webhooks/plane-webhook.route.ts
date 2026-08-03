import { Elysia } from "elysia";
import type { ProcessPlaneWebhookUseCase } from "../../application/use-cases/process-plane-webhook";
import { verifyPlaneSignature } from "../services/webhook-verifier";
import type { PlaneWebhookPayload } from "../../domain/entities/webhook-payload";
import type { EventBus } from "../../../../core/events";
import { PLANE_WEBHOOK_RECEIVED, type PlaneWebhookReceivedEvent } from "../../domain/events/plane-events";
import { log } from "../../../../core/logger";

export interface PlaneWebhookRouteDeps {
  useCase: ProcessPlaneWebhookUseCase;
  eventBus: EventBus;
  webhookSecret?: string;
}

export function planeWebhookRoute(deps: PlaneWebhookRouteDeps) {
  const { useCase, eventBus, webhookSecret } = deps;

  return new Elysia()
    .post("/webhook/plane", async ({ request }) => {
      const rawBody = await request.text();

      if (webhookSecret) {
        const signature = request.headers.get("x-plane-signature") ?? "";
        const valid = await verifyPlaneSignature(rawBody, signature, webhookSecret);
        if (!valid) {
          log.warn("Invalid webhook signature");
          return new Response(JSON.stringify({ error: "invalid signature" }), {
            status: 401,
            headers: { "Content-Type": "application/json" },
          });
        }
      }

      const payload: PlaneWebhookPayload = JSON.parse(rawBody);
      const { action, event } = payload;
      const entity = request.headers.get("x-plane-event") ?? event;

      // Emit domain event for cross-module subscribers
      const eventData: PlaneWebhookReceivedEvent = { entity, action, payload };
      await eventBus.emit(PLANE_WEBHOOK_RECEIVED, eventData);

      // Execute core use case
      const result = await useCase.execute({ entity, action, payload });
      return { ok: true, sent: result.sent };
    });
}
