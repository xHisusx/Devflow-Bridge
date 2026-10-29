import type {
  GitLabBranchInfo,
  GitLabCommitInfo,
  GitLabCommitQuery,
  GitLabIssueCreatePayload,
  GitLabIssueInfo,
  GitLabIssuePatch,
  GitLabIssueQuery,
  GitLabMemberInfo,
  GitLabMergeRequestInfo,
  GitLabMrCreatePayload,
  GitLabMrPatch,
  GitLabMrQuery,
  GitLabProjectInfo,
  GitLabUserInfo,
  IGitLabApiClient,
} from "../../application/ports/gitlab-api.port";

/** Raised for any non-2xx GitLab response; `status` lets callers treat 404/409 specially. */
export class GitLabApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "GitLabApiError";
  }
}

/** GitLab REST v4 client (self-hosted or SaaS) over fetch, authenticated with a personal token. */
export class GitLabApiClient implements IGitLabApiClient {
  private baseUrl: string;

  constructor(
    baseUrl: string,
    private token: string,
  ) {
    this.baseUrl = `${baseUrl.replace(/\/+$/, "")}/api/v4`;
  }

  private async request<T>(
    method: string,
    path: string,
    opts?: { query?: Record<string, unknown>; body?: unknown },
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(opts?.query ?? {})) {
      if (value === undefined || value === null || value === "") continue;
      url.searchParams.set(key, String(value));
    }

    const res = await fetch(url, {
      method,
      headers: {
        "PRIVATE-TOKEN": this.token,
        "Content-Type": "application/json",
      },
      body: opts?.body ? JSON.stringify(opts.body) : undefined,
    });

    if (res.status === 429) {
      const retryAfter = Number(res.headers.get("retry-after") || "5");
      await new Promise((r) => setTimeout(r, retryAfter * 1000));
      return this.request<T>(method, path, opts);
    }

    if (!res.ok) {
      throw new GitLabApiError(
        `GitLab API ${method} ${path}: ${res.status} ${await res.text()}`,
        res.status,
      );
    }

    if (res.status === 204) return undefined as T;
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  /** Project ids and paths both go into the URL path, so paths must be fully encoded. */
  private ref(project: string): string {
    return encodeURIComponent(project);
  }

  // ── Repository ──

  async getProject(project: string): Promise<GitLabProjectInfo> {
    const raw = await this.request<Record<string, any>>("GET", `/projects/${this.ref(project)}`);
    return {
      id: raw.id,
      path: raw.path_with_namespace,
      webUrl: raw.web_url,
      defaultBranch: raw.default_branch ?? "master",
    };
  }

  async listCommits(project: string, query: GitLabCommitQuery = {}): Promise<GitLabCommitInfo[]> {
    const raw = await this.request<Record<string, any>[]>(
      "GET",
      `/projects/${this.ref(project)}/repository/commits`,
      {
        query: {
          ref_name: query.ref,
          since: query.since,
          until: query.until,
          path: query.path,
          per_page: query.perPage ?? 20,
        },
      },
    );
    return raw.map(toCommit);
  }

  async getCommit(project: string, sha: string): Promise<GitLabCommitInfo> {
    const raw = await this.request<Record<string, any>>(
      "GET",
      `/projects/${this.ref(project)}/repository/commits/${encodeURIComponent(sha)}`,
    );
    return toCommit(raw);
  }

  async listBranches(project: string, search?: string): Promise<GitLabBranchInfo[]> {
    const raw = await this.request<Record<string, any>[]>(
      "GET",
      `/projects/${this.ref(project)}/repository/branches`,
      { query: { search, per_page: 100 } },
    );
    return raw.map(toBranch);
  }

  async getBranch(project: string, branch: string): Promise<GitLabBranchInfo | null> {
    try {
      const raw = await this.request<Record<string, any>>(
        "GET",
        `/projects/${this.ref(project)}/repository/branches/${encodeURIComponent(branch)}`,
      );
      return toBranch(raw);
    } catch (e) {
      if (e instanceof GitLabApiError && e.status === 404) return null;
      throw e;
    }
  }

  async createBranch(project: string, branch: string, ref: string): Promise<GitLabBranchInfo> {
    const raw = await this.request<Record<string, any>>(
      "POST",
      `/projects/${this.ref(project)}/repository/branches`,
      { query: { branch, ref } },
    );
    return toBranch(raw);
  }

  async deleteBranch(project: string, branch: string): Promise<void> {
    await this.request<void>(
      "DELETE",
      `/projects/${this.ref(project)}/repository/branches/${encodeURIComponent(branch)}`,
    );
  }

  // ── Merge requests ──

  async createMergeRequest(
    project: string,
    payload: GitLabMrCreatePayload,
  ): Promise<GitLabMergeRequestInfo> {
    const raw = await this.request<Record<string, any>>(
      "POST",
      `/projects/${this.ref(project)}/merge_requests`,
      {
        body: {
          source_branch: payload.sourceBranch,
          target_branch: payload.targetBranch,
          title: payload.title,
          ...(payload.description ? { description: payload.description } : {}),
          ...(payload.assigneeIds?.length ? { assignee_ids: payload.assigneeIds } : {}),
          ...(payload.reviewerIds?.length ? { reviewer_ids: payload.reviewerIds } : {}),
          ...(payload.labels?.length ? { labels: payload.labels.join(",") } : {}),
          ...(payload.removeSourceBranch != null
            ? { remove_source_branch: payload.removeSourceBranch }
            : {}),
          ...(payload.squash != null ? { squash: payload.squash } : {}),
        },
      },
    );
    return toMergeRequest(raw);
  }

  async updateMergeRequest(
    project: string,
    iid: number,
    patch: GitLabMrPatch,
  ): Promise<GitLabMergeRequestInfo> {
    const raw = await this.request<Record<string, any>>(
      "PUT",
      `/projects/${this.ref(project)}/merge_requests/${iid}`,
      {
        body: {
          ...(patch.title != null ? { title: patch.title } : {}),
          ...(patch.description != null ? { description: patch.description } : {}),
          ...(patch.targetBranch != null ? { target_branch: patch.targetBranch } : {}),
          ...(patch.assigneeIds ? { assignee_ids: patch.assigneeIds } : {}),
          ...(patch.reviewerIds ? { reviewer_ids: patch.reviewerIds } : {}),
          ...(patch.labels ? { labels: patch.labels.join(",") } : {}),
          ...(patch.removeSourceBranch != null
            ? { remove_source_branch: patch.removeSourceBranch }
            : {}),
          ...(patch.stateEvent ? { state_event: patch.stateEvent } : {}),
        },
      },
    );
    return toMergeRequest(raw);
  }

  async getMergeRequest(project: string, iid: number): Promise<GitLabMergeRequestInfo> {
    const raw = await this.request<Record<string, any>>(
      "GET",
      `/projects/${this.ref(project)}/merge_requests/${iid}`,
    );
    return toMergeRequest(raw);
  }

  async listMergeRequests(
    project: string,
    query: GitLabMrQuery = {},
  ): Promise<GitLabMergeRequestInfo[]> {
    const raw = await this.request<Record<string, any>[]>(
      "GET",
      `/projects/${this.ref(project)}/merge_requests`,
      {
        query: {
          state: query.state,
          source_branch: query.sourceBranch,
          target_branch: query.targetBranch,
          per_page: query.perPage ?? 20,
        },
      },
    );
    return raw.map(toMergeRequest);
  }

  async listMergeRequestCommits(project: string, iid: number): Promise<GitLabCommitInfo[]> {
    const raw = await this.request<Record<string, any>[]>(
      "GET",
      `/projects/${this.ref(project)}/merge_requests/${iid}/commits`,
      { query: { per_page: 100 } },
    );
    return raw.map(toCommit);
  }

  async mergeMergeRequest(
    project: string,
    iid: number,
    opts: { squash?: boolean; message?: string } = {},
  ): Promise<GitLabMergeRequestInfo> {
    const raw = await this.request<Record<string, any>>(
      "PUT",
      `/projects/${this.ref(project)}/merge_requests/${iid}/merge`,
      {
        body: {
          ...(opts.squash != null ? { squash: opts.squash } : {}),
          ...(opts.message ? { merge_commit_message: opts.message } : {}),
        },
      },
    );
    return toMergeRequest(raw);
  }

  async addMergeRequestNote(project: string, iid: number, body: string): Promise<void> {
    await this.request<void>(
      "POST",
      `/projects/${this.ref(project)}/merge_requests/${iid}/notes`,
      { body: { body } },
    );
  }

  // ── Issues ──

  async createIssue(project: string, payload: GitLabIssueCreatePayload): Promise<GitLabIssueInfo> {
    const raw = await this.request<Record<string, any>>(
      "POST",
      `/projects/${this.ref(project)}/issues`,
      {
        body: {
          title: payload.title,
          ...(payload.description ? { description: payload.description } : {}),
          ...(payload.labels?.length ? { labels: payload.labels.join(",") } : {}),
          ...(payload.assigneeIds?.length ? { assignee_ids: payload.assigneeIds } : {}),
        },
      },
    );
    return toIssue(raw);
  }

  async updateIssue(project: string, iid: number, patch: GitLabIssuePatch): Promise<GitLabIssueInfo> {
    const raw = await this.request<Record<string, any>>(
      "PUT",
      `/projects/${this.ref(project)}/issues/${iid}`,
      {
        body: {
          ...(patch.title != null ? { title: patch.title } : {}),
          ...(patch.description != null ? { description: patch.description } : {}),
          ...(patch.labels ? { labels: patch.labels.join(",") } : {}),
          ...(patch.assigneeIds ? { assignee_ids: patch.assigneeIds } : {}),
          ...(patch.stateEvent ? { state_event: patch.stateEvent } : {}),
        },
      },
    );
    return toIssue(raw);
  }

  async getIssue(project: string, iid: number): Promise<GitLabIssueInfo> {
    const raw = await this.request<Record<string, any>>(
      "GET",
      `/projects/${this.ref(project)}/issues/${iid}`,
    );
    return toIssue(raw);
  }

  async listIssues(project: string, query: GitLabIssueQuery = {}): Promise<GitLabIssueInfo[]> {
    const raw = await this.request<Record<string, any>[]>(
      "GET",
      `/projects/${this.ref(project)}/issues`,
      {
        query: {
          state: query.state,
          labels: query.labels?.join(","),
          search: query.search,
          per_page: query.perPage ?? 20,
        },
      },
    );
    return raw.map(toIssue);
  }

  async addIssueNote(project: string, iid: number, body: string): Promise<void> {
    await this.request<void>("POST", `/projects/${this.ref(project)}/issues/${iid}/notes`, {
      body: { body },
    });
  }

  // ── Users ──

  async getCurrentUser(): Promise<GitLabUserInfo> {
    return toUser(await this.request<Record<string, any>>("GET", "/user"));
  }

  async getUser(userId: number): Promise<GitLabUserInfo> {
    return toUser(await this.request<Record<string, any>>("GET", `/users/${userId}`));
  }

  /**
   * `GET /users?search=<email>` matches private emails only for admin tokens; a regular token
   * matches `public_email`. The search is a substring match, so the result is filtered down to an
   * exact (case-insensitive) hit on either field.
   */
  async findUserByEmail(email: string): Promise<GitLabUserInfo | null> {
    const needle = email.trim().toLowerCase();
    const raw = await this.request<Record<string, any>[]>("GET", "/users", {
      query: { search: needle, per_page: 20 },
    });
    const match = raw.find((u) =>
      [u.email, u.public_email, u.commit_email]
        .filter(Boolean)
        .some((e: string) => e.toLowerCase() === needle),
    );
    return match ? toUser(match) : null;
  }

  async findUserByUsername(username: string): Promise<GitLabUserInfo | null> {
    const raw = await this.request<Record<string, any>[]>("GET", "/users", {
      query: { username },
    });
    return raw.length > 0 ? toUser(raw[0]) : null;
  }

  async listProjectMembers(project: string): Promise<GitLabMemberInfo[]> {
    const raw = await this.request<Record<string, any>[]>(
      "GET",
      `/projects/${this.ref(project)}/members/all`,
      { query: { per_page: 100 } },
    );
    return raw.map((m) => ({ ...toUser(m), accessLevel: m.access_level ?? 0 }));
  }

  /** `/members/all` so members inherited from parent groups are included too. */
  async listGroupMembers(group: string): Promise<GitLabMemberInfo[]> {
    const raw = await this.request<Record<string, any>[]>(
      "GET",
      `/groups/${this.ref(group)}/members/all`,
      { query: { per_page: 100 } },
    );
    return raw.map((m) => ({ ...toUser(m), accessLevel: m.access_level ?? 0 }));
  }
}

// ── Response mappers (snake_case API -> port shapes) ──

function toCommit(raw: Record<string, any>): GitLabCommitInfo {
  return {
    id: raw.id,
    shortId: raw.short_id,
    title: raw.title ?? "",
    message: raw.message ?? "",
    authorName: raw.author_name ?? "",
    authorEmail: raw.author_email ?? "",
    createdAt: raw.created_at ?? "",
    webUrl: raw.web_url ?? "",
  };
}

function toBranch(raw: Record<string, any>): GitLabBranchInfo {
  return {
    name: raw.name,
    webUrl: raw.web_url ?? "",
    commitSha: raw.commit?.id ?? "",
    protected: Boolean(raw.protected),
  };
}

function toMergeRequest(raw: Record<string, any>): GitLabMergeRequestInfo {
  return {
    id: raw.id,
    iid: raw.iid,
    title: raw.title ?? "",
    description: raw.description ?? "",
    state: raw.state ?? "",
    draft: Boolean(raw.draft ?? raw.work_in_progress),
    sourceBranch: raw.source_branch ?? "",
    targetBranch: raw.target_branch ?? "",
    webUrl: raw.web_url ?? "",
    assigneeIds: Array.isArray(raw.assignees)
      ? raw.assignees.map((a: Record<string, any>) => a.id)
      : raw.assignee
        ? [raw.assignee.id]
        : [],
  };
}

function toIssue(raw: Record<string, any>): GitLabIssueInfo {
  return {
    id: raw.id,
    iid: raw.iid,
    title: raw.title ?? "",
    description: raw.description ?? "",
    state: raw.state ?? "",
    webUrl: raw.web_url ?? "",
    labels: Array.isArray(raw.labels) ? raw.labels : [],
  };
}

function toUser(raw: Record<string, any>): GitLabUserInfo {
  return {
    id: raw.id,
    username: raw.username ?? "",
    name: raw.name ?? "",
    email: raw.email ?? raw.public_email ?? null,
    webUrl: raw.web_url ?? "",
  };
}
