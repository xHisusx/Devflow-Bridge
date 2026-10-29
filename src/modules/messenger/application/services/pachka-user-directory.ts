import type { PachkaUser } from "../../domain/entities/message";
import type { IMessengerClient } from "../ports/messenger-client.port";
import { log } from "../../../../core/logger";

/** Pachka custom profile field that carries the person's work email. */
export const DEFAULT_WORK_EMAIL_FIELD = "Рабочая почта";

/**
 * Work email of a Pachka profile: the custom field first (that is the field people actually fill
 * in), the login email second. Returns "" when neither is available — Pachka hides other users'
 * emails unless the workspace allows personal data, which is exactly why the custom field exists.
 */
export function workEmailOf(user: PachkaUser, workEmailField = DEFAULT_WORK_EMAIL_FIELD): string {
  const custom = user.custom_properties?.find(
    (p) => p.name.toLowerCase() === workEmailField.toLowerCase(),
  );
  const fromField = typeof custom?.value === "string" ? custom.value.trim() : "";
  return (fromField || user.email || "").trim();
}

/**
 * email -> Pachka user id, the link that lets the bridge DM the person a tracker event is about.
 * Lookups go: in-memory cache -> targeted `GET /users?query=<email>` (matches the login email) ->
 * full member list scanned on the work-email custom field, cached for `ttlMs`.
 */
export class PachkaUserDirectory {
  private byEmail = new Map<string, number>();
  private allUsers: PachkaUser[] | null = null;
  private loadedAt = 0;

  constructor(
    private client: IMessengerClient,
    private ttlMs = 10 * 60_000,
  ) {}

  async findIdByEmail(
    email: string,
    workEmailField = DEFAULT_WORK_EMAIL_FIELD,
  ): Promise<number | null> {
    const needle = email.trim().toLowerCase();
    if (!needle) return null;

    const cached = this.byEmail.get(needle);
    if (cached) return cached;

    try {
      const found = await this.client.listUsers({ query: needle, limit: 20 });
      const direct = found.find((u) => workEmailOf(u, workEmailField).toLowerCase() === needle);
      if (direct) return this.remember(needle, direct.id);
    } catch (e) {
      log.debug("Pachka directory: query lookup failed", { email: needle, error: String(e) });
    }

    const users = await this.loadAll();
    const match = users.find((u) => workEmailOf(u, workEmailField).toLowerCase() === needle);
    if (!match) {
      log.warn("Pachka directory: no user with that work email", { email: needle, workEmailField });
      return null;
    }
    return this.remember(needle, match.id);
  }

  /** Drop the cached member list (e.g. after a new hire fills in their work email). */
  invalidate(): void {
    this.allUsers = null;
    this.loadedAt = 0;
    this.byEmail.clear();
  }

  private async loadAll(): Promise<PachkaUser[]> {
    const fresh = this.allUsers && Date.now() - this.loadedAt < this.ttlMs;
    if (fresh) return this.allUsers!;

    try {
      this.allUsers = await this.client.listUsers();
      this.loadedAt = Date.now();
      log.debug("Pachka directory: member list loaded", { count: this.allUsers.length });
    } catch (e) {
      log.error("Pachka directory: failed to list users", { error: String(e) });
      this.allUsers = this.allUsers ?? [];
    }
    return this.allUsers;
  }

  private remember(email: string, userId: number): number {
    this.byEmail.set(email, userId);
    return userId;
  }
}
