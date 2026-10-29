/**
 * Shape of the GitLab webhook payloads the bridge reads (merge request, push, issue, note).
 * Everything is optional: the same endpoint receives every event kind a project is configured to
 * send, and GitLab keeps adding fields.
 */

export interface GitLabWebhookUser {
  id?: number;
  name?: string;
  username?: string;
  /** Present only when the instance exposes it (admin / public email). */
  email?: string;
}

export interface GitLabWebhookProject {
  id?: number;
  name?: string;
  path_with_namespace?: string;
  web_url?: string;
  default_branch?: string;
}

export interface GitLabWebhookCommit {
  id?: string;
  message?: string;
  title?: string;
  url?: string;
  author?: { name?: string; email?: string };
}

export interface GitLabWebhookLabel {
  id?: number;
  title?: string;
}

/** `object_attributes` of a merge-request event (a superset is sent; these are the fields used). */
export interface GitLabMergeRequestAttributes {
  id?: number;
  iid?: number;
  title?: string;
  description?: string;
  /** opened | closed | merged | locked */
  state?: string;
  /** open | close | reopen | update | approval | approved | unapproval | unapproved | merge */
  action?: string;
  source_branch?: string;
  target_branch?: string;
  url?: string;
  draft?: boolean;
  /** Deprecated predecessor of `draft`; still sent by older instances. */
  work_in_progress?: boolean;
  merge_status?: string;
  last_commit?: GitLabWebhookCommit;
  labels?: GitLabWebhookLabel[];
  assignee?: GitLabWebhookUser;
  [key: string]: unknown;
}

export interface GitLabWebhookPayload {
  /** merge_request | push | tag_push | issue | note | pipeline */
  object_kind?: string;
  event_type?: string;
  event_name?: string;
  user?: GitLabWebhookUser;
  /** Push events carry the pusher in flat fields instead of `user`. */
  user_name?: string;
  user_username?: string;
  user_email?: string;
  project?: GitLabWebhookProject;
  object_attributes?: GitLabMergeRequestAttributes;
  labels?: GitLabWebhookLabel[];
  changes?: Record<string, unknown>;
  assignees?: GitLabWebhookUser[];
  reviewers?: GitLabWebhookUser[];
  /** Push events: "refs/heads/<branch>". */
  ref?: string;
  commits?: GitLabWebhookCommit[];
  total_commits_count?: number;
  checkout_sha?: string;
}
