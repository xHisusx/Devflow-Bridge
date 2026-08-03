import type { PlaneIssue } from "./issue";

export interface PlaneWebhookPayload {
  event: string;
  action: "created" | "updated" | "deleted";
  webhook_id: string;
  workspace_id: string;
  data: PlaneIssue;
  activity?: {
    field: string;
    old_value: string;
    new_value: string;
    verb: string;
  };
}
