/** Nested user object Taiga sends in `by`, `owner` and `assigned_to` (no email — see memberships). */
export interface TaigaWebhookUser {
  id?: number;
  username?: string;
  full_name?: string;
  full_name_display?: string;
  permalink?: string;
}

/** Relevant subset of Taiga's webhook payload (nested objects come pre-serialized). */
export interface TaigaWebhookPayload {
  /** "create" | "change" | "delete" | "test". */
  action: string;
  /** "issue" | "userstory" | "task" | ... */
  type: string;
  /** Who triggered the event. */
  by?: TaigaWebhookUser;
  date?: string;
  data?: {
    id?: number;
    ref?: number;
    subject?: string;
    description?: string;
    permalink?: string;
    project?: { id?: number; permalink?: string; name?: string };
    status?: { id?: number; name?: string; is_closed?: boolean };
    assigned_to?: TaigaWebhookUser | null;
    type?: { name?: string } | null;
    priority?: { name?: string } | null;
    severity?: { name?: string } | null;
    tags?: string[] | null;
    /** Sprint. Null when the item is not in one; an object (or a bare id) when it is. */
    milestone?: { id?: number; name?: string; slug?: string } | number | string | null;
    /** Tasks only: the parent user story, serialized in full (so its sprint comes along). */
    user_story?: {
      id?: number;
      ref?: number;
      subject?: string;
      permalink?: string;
      tags?: string[] | null;
      status?: { id?: number; name?: string } | null;
      milestone?: { id?: number; name?: string; slug?: string } | number | string | null;
    } | null;
  };
  /** Present for `action: "change"`: `diff` holds `{ field: { from, to } }` with display values. */
  change?: { comment?: string; diff?: Record<string, unknown> };
}
