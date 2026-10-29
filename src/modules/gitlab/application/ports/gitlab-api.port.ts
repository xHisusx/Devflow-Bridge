/**
 * Port for the GitLab REST API (v4, self-hosted or SaaS). Only the operations the bridge needs:
 * repository reads (commits, branches), merge-request and issue management, and user lookup.
 * `project` is always a numeric id or a URL-encodable path with namespace ("team/backend").
 */

export interface GitLabProjectInfo {
  id: number;
  /** Path with namespace, e.g. "team/backend". */
  path: string;
  webUrl: string;
  defaultBranch: string;
}

export interface GitLabBranchInfo {
  name: string;
  webUrl: string;
  commitSha: string;
  protected: boolean;
}

export interface GitLabCommitInfo {
  id: string;
  shortId: string;
  title: string;
  message: string;
  authorName: string;
  authorEmail: string;
  createdAt: string;
  webUrl: string;
}

export interface GitLabUserInfo {
  id: number;
  username: string;
  name: string;
  /** Present for admin tokens (`/users?search=`) and for the token's own user. */
  email?: string | null;
  webUrl: string;
}

export interface GitLabMemberInfo extends GitLabUserInfo {
  accessLevel: number;
}

export interface GitLabMergeRequestInfo {
  id: number;
  iid: number;
  title: string;
  description: string;
  state: string;
  draft: boolean;
  sourceBranch: string;
  targetBranch: string;
  webUrl: string;
  assigneeIds: number[];
}

export interface GitLabIssueInfo {
  id: number;
  iid: number;
  title: string;
  description: string;
  state: string;
  webUrl: string;
  labels: string[];
}

export interface GitLabMrCreatePayload {
  sourceBranch: string;
  targetBranch: string;
  title: string;
  description?: string;
  assigneeIds?: number[];
  reviewerIds?: number[];
  labels?: string[];
  removeSourceBranch?: boolean;
  squash?: boolean;
}

export interface GitLabMrPatch {
  title?: string;
  description?: string;
  targetBranch?: string;
  assigneeIds?: number[];
  reviewerIds?: number[];
  labels?: string[];
  removeSourceBranch?: boolean;
  /** "close" / "reopen" — GitLab's state_event. */
  stateEvent?: "close" | "reopen";
}

export interface GitLabIssueCreatePayload {
  title: string;
  description?: string;
  labels?: string[];
  assigneeIds?: number[];
}

export interface GitLabIssuePatch {
  title?: string;
  description?: string;
  labels?: string[];
  assigneeIds?: number[];
  stateEvent?: "close" | "reopen";
}

export interface GitLabCommitQuery {
  /** Branch, tag or SHA. Defaults to the repository's default branch. */
  ref?: string;
  /** ISO 8601 bounds. */
  since?: string;
  until?: string;
  path?: string;
  perPage?: number;
}

export interface GitLabMrQuery {
  state?: "opened" | "closed" | "merged" | "locked" | "all";
  sourceBranch?: string;
  targetBranch?: string;
  perPage?: number;
}

export interface GitLabIssueQuery {
  state?: "opened" | "closed" | "all";
  labels?: string[];
  search?: string;
  perPage?: number;
}

export interface IGitLabApiClient {
  // ── Repository ──
  getProject(project: string): Promise<GitLabProjectInfo>;
  listCommits(project: string, query?: GitLabCommitQuery): Promise<GitLabCommitInfo[]>;
  getCommit(project: string, sha: string): Promise<GitLabCommitInfo>;
  listBranches(project: string, search?: string): Promise<GitLabBranchInfo[]>;
  /** Null when the branch does not exist (404), rather than throwing. */
  getBranch(project: string, branch: string): Promise<GitLabBranchInfo | null>;
  createBranch(project: string, branch: string, ref: string): Promise<GitLabBranchInfo>;
  deleteBranch(project: string, branch: string): Promise<void>;

  // ── Merge requests ──
  createMergeRequest(project: string, payload: GitLabMrCreatePayload): Promise<GitLabMergeRequestInfo>;
  updateMergeRequest(project: string, iid: number, patch: GitLabMrPatch): Promise<GitLabMergeRequestInfo>;
  getMergeRequest(project: string, iid: number): Promise<GitLabMergeRequestInfo>;
  listMergeRequests(project: string, query?: GitLabMrQuery): Promise<GitLabMergeRequestInfo[]>;
  listMergeRequestCommits(project: string, iid: number): Promise<GitLabCommitInfo[]>;
  mergeMergeRequest(
    project: string,
    iid: number,
    opts?: { squash?: boolean; message?: string },
  ): Promise<GitLabMergeRequestInfo>;
  addMergeRequestNote(project: string, iid: number, body: string): Promise<void>;

  // ── Issues ──
  createIssue(project: string, payload: GitLabIssueCreatePayload): Promise<GitLabIssueInfo>;
  updateIssue(project: string, iid: number, patch: GitLabIssuePatch): Promise<GitLabIssueInfo>;
  getIssue(project: string, iid: number): Promise<GitLabIssueInfo>;
  listIssues(project: string, query?: GitLabIssueQuery): Promise<GitLabIssueInfo[]>;
  addIssueNote(project: string, iid: number, body: string): Promise<void>;

  // ── Users ──
  /** The token's own user — used at startup to log who the bridge acts as. */
  getCurrentUser(): Promise<GitLabUserInfo>;
  getUser(userId: number): Promise<GitLabUserInfo>;
  /** Exact (case-insensitive) match on email; private emails need an admin token. */
  findUserByEmail(email: string): Promise<GitLabUserInfo | null>;
  findUserByUsername(username: string): Promise<GitLabUserInfo | null>;
  listProjectMembers(project: string): Promise<GitLabMemberInfo[]>;
  /**
   * Members of a group, inherited ones included. Lets a group-scoped (non-admin) token build an
   * index of people to match an assignee against. `group` is an id or a full path ("team/sub").
   */
  listGroupMembers(group: string): Promise<GitLabMemberInfo[]>;
}
