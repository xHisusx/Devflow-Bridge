import type { GitLabProvider, GitLabUserMapping } from "../../../../core/config";
import type { GitLabMemberInfo, GitLabUserInfo, IGitLabApiClient } from "../ports/gitlab-api.port";
import { nameKey } from "../../../../core/slug";
import { log } from "../../../../core/logger";

/**
 * email (+ display name) -> GitLab user, without requiring an administrator token.
 *
 * `GET /users?search=<email>` matches a *private* email only for admins, so a group- or
 * project-scoped token needs other routes to the same person. They are tried in order of
 * reliability:
 *
 * 1. the provider's explicit `userMap` (works with any token);
 * 2. the email search (hits public emails, and everything with an admin token);
 * 3. the member list of the provider's `groups` (or of the repository itself), matched on email
 *    where the instance exposes it, then on a username derived from the email's local part, then
 *    on a loose transliterated name key;
 * 4. `GET /users?username=<candidate>` for those same username candidates.
 *
 * Never throws: an unresolved assignee leaves the merge request unassigned and is logged with
 * what to do about it.
 */
export class GitLabUserResolver {
  /** Lookups already done against this instance, misses included (as null). */
  private cache = new Map<string, GitLabUserInfo | null>();

  constructor(
    private client: IGitLabApiClient,
    private provider: GitLabProvider,
  ) {}

  async resolve(email: string, name?: string, repo?: string): Promise<GitLabUserInfo | null> {
    const key = `${email.trim().toLowerCase()}|${name ?? ""}|${repo ?? ""}`;
    if (this.cache.has(key)) return this.cache.get(key) ?? null;

    const user = await this.lookup(email, name, repo);
    this.cache.set(key, user);
    return user;
  }

  private async lookup(
    email: string,
    name: string | undefined,
    repo: string | undefined,
  ): Promise<GitLabUserInfo | null> {
    const mapping = findMapping(this.provider.userMap, email);

    try {
      if (mapping?.userId) return await this.client.getUser(mapping.userId);
      if (mapping?.username) {
        const byUsername = await this.client.findUserByUsername(mapping.username);
        if (byUsername) return byUsername;
        log.warn("GitLab: userMap username not found", { username: mapping.username });
      }
    } catch (e) {
      log.error("GitLab: userMap lookup failed", { email, error: String(e) });
    }

    if (!email && !name) return null;

    if (email) {
      try {
        const byEmail = await this.client.findUserByEmail(email);
        if (byEmail) return byEmail;
      } catch (e) {
        log.debug("GitLab: email search unavailable for this token", { error: String(e) });
      }
    }

    const candidates = usernameCandidates(email);
    const members = await this.members(repo);

    if (members.length > 0) {
      const needle = email.trim().toLowerCase();
      const byMemberEmail = needle
        ? members.find((m) => (m.email ?? "").toLowerCase() === needle)
        : undefined;
      if (byMemberEmail) return byMemberEmail;

      const byMemberUsername = members.find((m) => candidates.includes(m.username.toLowerCase()));
      if (byMemberUsername) {
        log.info("GitLab: assignee matched by a username derived from the email", {
          email,
          username: byMemberUsername.username,
        });
        return byMemberUsername;
      }

      if (name) {
        const wanted = nameKey(name);
        const exact = wanted ? members.filter((m) => nameKey(m.name) === wanted) : [];
        const byName = exact.length > 0 ? exact : nameSubsetMatches(members, wanted);
        if (byName.length === 1) {
          log.info("GitLab: assignee matched by name", { name, username: byName[0].username });
          return byName[0];
        }
        if (byName.length > 1) {
          log.warn("GitLab: several members share that name, assignee left unresolved", {
            name,
            candidates: byName.map((m) => m.username),
          });
          return null;
        }
      }
    }

    for (const candidate of candidates) {
      try {
        const user = await this.client.findUserByUsername(candidate);
        if (user) {
          log.info("GitLab: assignee resolved by a username guess", { email, username: candidate });
          return user;
        }
      } catch (e) {
        log.debug("GitLab: username lookup failed", { candidate, error: String(e) });
      }
    }

    log.warn(
      "GitLab: no user found for that person, merge request stays unassigned. Add them to the " +
        "provider's userMap, list their group in the provider's groups, or use an admin token " +
        "(private email search)",
      { email, name },
    );
    return null;
  }

  /** Member index of the provider's `groups`, or of the repository when no group is configured. */
  private async members(repo: string | undefined): Promise<GitLabMemberInfo[]> {
    const groups = this.provider.groups ?? [];
    const scope = groups.length > 0 ? groups.join(",") : (repo ?? this.provider.project);
    const cacheKey = `${this.provider.baseUrl}|${this.provider.alias}|${scope}`;

    const cached = memberCache.get(cacheKey);
    if (cached && Date.now() - cached.at < MEMBER_TTL_MS) return cached.members;

    const members: GitLabMemberInfo[] = [];
    try {
      if (groups.length > 0) {
        for (const group of groups) {
          members.push(...(await this.client.listGroupMembers(group)));
        }
      } else if (scope) {
        members.push(...(await this.client.listProjectMembers(scope)));
      }
    } catch (e) {
      log.warn("GitLab: could not list members for the user lookup", { scope, error: String(e) });
      return cached?.members ?? [];
    }

    memberCache.set(cacheKey, { at: Date.now(), members });
    log.debug("GitLab member index built", { scope, members: members.length });
    return members;
  }
}

/**
 * Same person, different amount of name: the tracker has "Алексей Павлов" while git has
 * "Павлов Алексей Сергеевич". One token set has to contain the other, and at least two tokens
 * have to line up, so a shared surname alone never decides.
 */
function nameSubsetMatches(members: GitLabMemberInfo[], wanted: string): GitLabMemberInfo[] {
  const want = wanted.split(" ").filter(Boolean);
  if (want.length < 2) return [];

  return members.filter((m) => {
    const have = nameKey(m.name).split(" ").filter(Boolean);
    if (have.length < 2) return false;
    return want.every((t) => have.includes(t)) || have.every((t) => want.includes(t));
  });
}

const MEMBER_TTL_MS = 10 * 60 * 1000;
const memberCache = new Map<string, { at: number; members: GitLabMemberInfo[] }>();

/** Drop the member index (tests, and after a membership change). */
export function clearGitLabMemberCache(): void {
  memberCache.clear();
}

/**
 * Usernames a person with this email plausibly has: the local part as-is and with its separators
 * removed or swapped, plus the "first initial + last part" form ("a.makhov" -> "amakhov").
 */
export function usernameCandidates(email: string): string[] {
  const local = (email.split("@")[0] ?? "").trim().toLowerCase();
  if (!local) return [];

  const parts = local.split(/[._\-+]+/).filter(Boolean);
  const out = new Set<string>([
    local,
    parts.join(""),
    parts.join("_"),
    parts.join("-"),
    parts.join("."),
  ]);
  if (parts.length > 1) {
    const last = parts[parts.length - 1];
    out.add(parts[0][0] + last);
    out.add(`${parts[0][0]}.${last}`);
  }
  return [...out].filter(Boolean);
}

export function findMapping(
  userMap: Record<string, GitLabUserMapping> | undefined,
  email: string | undefined,
): GitLabUserMapping | undefined {
  if (!userMap || !email) return undefined;
  const key = Object.keys(userMap).find((k) => k.toLowerCase() === email.toLowerCase());
  return key ? userMap[key] : undefined;
}
