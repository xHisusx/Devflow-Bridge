import type { GitLabProvider } from "../../../../core/config";
import type { GitLabContent, GitLabMrContent } from "../../../messenger/domain/entities/notification";
import type {
  GitLabBranchInfo,
  GitLabIssueInfo,
  GitLabMergeRequestInfo,
  IGitLabApiClient,
} from "../ports/gitlab-api.port";
import { GitLabUserResolver, findMapping } from "./gitlab-user-resolver";
import { resolve, resolveDeep } from "../../../plane/domain/services/content-mapper";
import { renderMessage } from "../../../plane/domain/services/template-renderer";
import {
  DEFAULT_BRANCH_PATTERN,
  DEFAULT_SLUG_LENGTH,
  asTagList,
  buildBranchName,
  draftTitle,
  missingBranchVars,
  resolveBranchType,
  resolveRepo,
} from "../../domain/services/branch-name";
import { initials, slugify } from "../../../../core/slug";
import { log } from "../../../../core/logger";

/** Raised when the repository work a step asked for cannot be done at all (no branch, no repo). */
export class GitLabWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitLabWriteError";
  }
}

const DEFAULT_MR_TITLE = "{{taskIdentifier}} {{taskName}}";
const DEFAULT_MR_DESCRIPTION = "Задача: {{taskUrl}}";

export interface GitLabStepResult {
  /** Step outputs exposed to subsequent pipeline steps — must match GITLAB_STEP_OUTPUTS. */
  outputs: Record<string, unknown>;
}

/**
 * Execute one `to: gitlab:*` step: create the work branch (reusing it when it already exists),
 * open or reuse a draft merge request, optionally create an issue and leave a note.
 *
 * Templates are resolved in two phases. First the identity fields (`repo`, `tags`, `ref`,
 * `assigneeEmail`, `assigneeName`) are resolved against the upstream step's outputs; then
 * `{{slug}}`, `{{assigneeInitials}}` and the `task*` fields are computed and the remaining
 * fields (`branch`, `mr`, `issue`, `comment`) are resolved against that enriched set.
 */
export async function runGitLabStep(
  client: IGitLabApiClient,
  provider: GitLabProvider,
  content: GitLabContent,
  source: Record<string, unknown>,
): Promise<GitLabStepResult> {
  // ── Phase 1: identity ──
  const tags = asTagList(resolve(content.tags ?? source.labels, source));
  const repo = resolveRepo(provider, str(resolve(content.repo, source)), tags);

  let project;
  try {
    project = await client.getProject(repo);
  } catch (e) {
    throw new GitLabWriteError(`Repository "${repo}" is not reachable: ${String(e)}`);
  }

  const assigneeEmail = str(resolve(content.assigneeEmail ?? source.assigneeEmail, source));
  const assigneeName = str(resolve(content.assigneeName ?? source.assignee, source));
  const mapping = findMapping(provider.userMap, assigneeEmail);
  const users = new GitLabUserResolver(client, provider);
  const user = await users.resolve(assigneeEmail, assigneeName, repo);

  // ── Phase 2: computed template vars ──
  const taskName = str(source.name ?? source.title);
  const assigneeInitials =
    mapping?.initials || str(source.assigneeInitials) || initials(assigneeName, assigneeEmail);
  const vars: Record<string, unknown> = {
    ...source,
    slug: str(source.slug) || slugify(taskName, provider.branch?.maxSlugLength ?? DEFAULT_SLUG_LENGTH),
    branchType: resolveBranchType(
      provider,
      str(resolve(content.branchType, source)) || undefined,
      tags,
      str(source.type),
    ),
    assigneeInitials,
    // The person as the tracker shows them: templates say "Исполнитель: {{assignee}}" and mean
    // the human name, not a git login. The GitLab account is attached through assigneeIds.
    assignee: assigneeName || user?.name || user?.username || "",
    assigneeEmail,
    repo: project.path,
    repoUrl: project.webUrl,
    taskId: str(source.issueId),
    taskName,
    taskUrl: str(source.issueUrl),
    taskIdentifier: str(source.identifier),
    // The tracker's own context, echoed so a card built from this step can name the project the
    // task lives in and the status it is in ("[Med-2.0] ... Статус: В работе").
    taskProject: str(source.project),
    taskStatus: str(source.status ?? source.state),
  };

  const resolved = resolveDeep(
    {
      branch: content.branch,
      ref: content.ref,
      mr: content.mr,
      issue: content.issue,
      comment: content.comment,
    },
    vars,
  ) as {
    branch?: string;
    ref?: string;
    mr?: GitLabMrContent;
    issue?: { title?: string; description?: string; labels?: string[]; assigneeEmail?: string };
    comment?: string;
  };

  const baseRef = resolved.ref || provider.defaultBranch || project.defaultBranch;
  const target = resolved.mr?.target || provider.mr?.target || provider.defaultBranch || project.defaultBranch;

  // ── Branch ──
  let branch: GitLabBranchInfo | null = null;
  let branchName = "";
  if ("branch" in content || content.mr) {
    const pattern = resolved.branch || provider.branch?.pattern || DEFAULT_BRANCH_PATTERN;
    const missing = missingBranchVars(pattern, vars);
    if (missing.length > 0) {
      throw new GitLabWriteError(
        `Branch pattern "${pattern}" has unresolved placeholders: ${missing.map((m) => `{{${m}}}`).join(", ")}`,
      );
    }
    branchName = buildBranchName(pattern, vars);
    if (!branchName) {
      throw new GitLabWriteError(`Branch name template "${pattern}" resolved to an empty name`);
    }

    branch = await client.getBranch(repo, branchName);
    if (branch) {
      log.info("GitLab branch already exists, reusing", { repo: project.path, branch: branchName });
    } else {
      branch = await client.createBranch(repo, branchName, baseRef);
      log.info("GitLab branch created", { repo: project.path, branch: branchName, ref: baseRef });
    }
  }

  // ── Merge request ──
  let mr: GitLabMergeRequestInfo | null = null;
  if (content.mr && branchName) {
    mr = await openOrReuseMergeRequest(client, provider, {
      repo,
      repoPath: project.path,
      branchName,
      target,
      mrContent: resolved.mr ?? {},
      vars,
      assigneeId: user?.id,
      users,
    });
  } else if (content.mr) {
    log.warn("GitLab step: `mr` declared without a branch — skipped", { repo: project.path });
  }

  // ── Issue ──
  let issue: GitLabIssueInfo | null = null;
  if (resolved.issue?.title) {
    const issueAssignee = resolved.issue.assigneeEmail
      ? await users.resolve(resolved.issue.assigneeEmail, undefined, repo)
      : user;
    issue = await client.createIssue(repo, {
      title: resolved.issue.title,
      ...(resolved.issue.description ? { description: resolved.issue.description } : {}),
      ...(resolved.issue.labels?.length ? { labels: resolved.issue.labels } : {}),
      ...(issueAssignee ? { assigneeIds: [issueAssignee.id] } : {}),
    });
    log.info("GitLab issue created", { repo: project.path, iid: issue.iid });
  }

  // ── Note on the merge request ──
  if (resolved.comment && mr) {
    try {
      await client.addMergeRequestNote(repo, mr.iid, resolved.comment);
    } catch (e) {
      log.error("GitLab step: failed to add MR note", { repo: project.path, error: String(e) });
    }
  } else if (resolved.comment) {
    log.warn("GitLab step: `comment` has no merge request to attach to — skipped", {
      repo: project.path,
    });
  }

  return {
    outputs: {
      branch: branch?.name ?? "",
      branchUrl: branch?.webUrl ?? "",
      ref: baseRef,
      repo: project.path,
      repoUrl: project.webUrl,
      mrIid: mr?.iid ?? null,
      mrUrl: mr?.webUrl ?? "",
      mrTitle: mr?.title ?? "",
      mrTarget: mr?.targetBranch ?? target,
      issueIid: issue?.iid ?? null,
      issueUrl: issue?.webUrl ?? "",
      assignee: assigneeName || user?.name || user?.username || "",
      assigneeEmail,
      assigneeInitials,
      taskId: vars.taskId,
      taskName,
      taskUrl: vars.taskUrl,
      taskIdentifier: vars.taskIdentifier,
      taskProject: vars.taskProject,
      taskStatus: vars.taskStatus,
    },
  };
}

/**
 * Reuse the open MR of that source branch when there is one (re-runs of the same event, a
 * re-assignment), otherwise open a new one. A failure to open is logged, not thrown: the branch
 * exists and the notification steps downstream are still worth running.
 */
async function openOrReuseMergeRequest(
  client: IGitLabApiClient,
  provider: GitLabProvider,
  args: {
    repo: string;
    repoPath: string;
    branchName: string;
    target: string;
    mrContent: GitLabMrContent;
    vars: Record<string, unknown>;
    assigneeId?: number;
    users: GitLabUserResolver;
  },
): Promise<GitLabMergeRequestInfo | null> {
  const { repo, repoPath, branchName, target, mrContent, vars, assigneeId, users } = args;

  try {
    const open = await client.listMergeRequests(repo, {
      state: "opened",
      sourceBranch: branchName,
      perPage: 1,
    });
    if (open.length > 0) {
      log.info("GitLab MR already open for branch, reusing", {
        repo: repoPath, branch: branchName, iid: open[0].iid,
      });
      return open[0];
    }
  } catch (e) {
    log.warn("GitLab step: failed to look up existing MRs", { repo: repoPath, error: String(e) });
  }

  const draft = mrContent.draft ?? provider.mr?.draft ?? true;
  const title = draftTitle(
    mrContent.title || renderMessage(provider.mr?.title ?? DEFAULT_MR_TITLE, vars),
    draft,
  );
  const description =
    mrContent.description ?? renderMessage(provider.mr?.description ?? DEFAULT_MR_DESCRIPTION, vars);
  const labels = mrContent.labels ?? provider.mr?.labels;
  const reviewerIds = await resolveReviewers(users, repo, mrContent.reviewerEmails);

  try {
    const mr = await client.createMergeRequest(repo, {
      sourceBranch: branchName,
      targetBranch: target,
      title: title.trim(),
      ...(description ? { description } : {}),
      ...(assigneeId ? { assigneeIds: [assigneeId] } : {}),
      ...(reviewerIds.length > 0 ? { reviewerIds } : {}),
      ...(labels?.length ? { labels } : {}),
      removeSourceBranch: mrContent.removeSourceBranch ?? provider.mr?.removeSourceBranch ?? true,
      squash: mrContent.squash ?? provider.mr?.squash ?? false,
    });
    log.info("GitLab MR created", {
      repo: repoPath, iid: mr.iid, source: branchName, target, draft, assigneeId,
    });
    return mr;
  } catch (e) {
    log.error("GitLab step: failed to create MR", {
      repo: repoPath, source: branchName, target, error: String(e),
    });
    return null;
  }
}

async function resolveReviewers(
  users: GitLabUserResolver,
  repo: string,
  emails: string | string[] | undefined,
): Promise<number[]> {
  const ids: number[] = [];
  for (const email of asTagList(emails)) {
    const user = await users.resolve(email, undefined, repo);
    if (user) ids.push(user.id);
  }
  return ids;
}

function str(value: unknown): string {
  return value == null ? "" : String(value);
}
