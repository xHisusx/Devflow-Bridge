import type { PlaneWebhookPayload } from "../entities/webhook-payload";

export const PLANE_WEBHOOK_RECEIVED = "plane.webhook.received";

export interface PlaneWebhookReceivedEvent {
  entity: string;
  action: string;
  payload: PlaneWebhookPayload;
}
