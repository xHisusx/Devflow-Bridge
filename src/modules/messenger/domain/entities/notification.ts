import type { StateGroup, PlaneEntity } from "../../../plane/domain/entities";
import type { BitrixContent } from "../../../../core/config";

// Content для to: "plane" — маппинг полей из request body
export interface PlaneContent {
  [field: string]: string | string[] | number;
}

// Content для to: "pachka:*" / "webhook:*" — шаблон уведомления
export interface NotifyContent {
  message: string;
  actions?: RuleAction[];
}

export function isNotifyContent(content: unknown): content is NotifyContent {
  return typeof content === "object" && content !== null && "message" in content;
}

export interface ButtonDef {
  text: string;
  url?: string;
  callbackData?: string;
  /** Alias of a `form` provider; renders a data-button that opens the form. Excludes url/callbackData. */
  form?: string;
}

export type RuleAction =
  | { type: "reaction"; emoji: string }
  | { type: "editPrevious"; message?: string }
  | { type: "threadReply"; message: string }
  | { type: "buttons"; buttons: ButtonDef[] }
  | { type: "pin" };

export interface RuleOn {
  // ── Match conditions (Plane-trigger only) ──
  // Evaluated by rule-matcher only when the pipeline source is a Plane webhook event (first step).
  // Ignored for api:intake-sourced pipelines and for non-first steps.
  action?: "create" | "update" | "delete";
  entity?: PlaneEntity | PlaneEntity[];
  state?: string | string[];
  stateGroup?: StateGroup | StateGroup[];
  priority?: string | string[];
  /** Taiga webhook status condition (used with `from: taiga:*`). */
  status?: string | string[];

  // ── Step payload (all sources) ──
  content: PlaneContent | NotifyContent | BitrixContent;
  outputs?: string[]; // fields this step exposes to subsequent steps (defaults to the provider schema)
}

export interface Rule {
  from: string; // "type:alias" (e.g. "plane:dev", "api:intake")
  to: string; // "type:alias" (e.g. "pachka:releases", "plane:dev")
  on: RuleOn;
}

export function parseRef(ref: string): { type: string; alias: string } {
  const [type, alias = ""] = ref.split(":");
  return { type, alias };
}
