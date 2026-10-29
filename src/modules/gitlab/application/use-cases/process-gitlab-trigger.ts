import type { Config, GitLabProvider } from "../../../../core/config";
import type { ProviderRegistry } from "../../../../core/provider-registry";
import type { IPipelineStateStore, TaskLink } from "../../../../core/persistence/pipeline-state.port";
import type { Rule } from "../../../messenger/domain/entities/notification";
import type { GitLabWebhookPayload } from "../../domain/entities/gitlab-webhook-payload";
import { parseRef } from "../../../messenger/domain/entities/notification";
import { Deduplicator } from "../../../plane/domain/services/deduplicator";
import { formatReceivedAt } from "../../../plane/application/use-cases/process-intake-pipeline";
import {
  buildGitLabTriggerOutputs,
  extractGitLabFacts,
  matchesGitLabCondition,
  type GitLabTriggerFacts,
} from "../../domain/services/gitlab-trigger";
import { log } from "../../../../core/logger";

/** Structural dependency on the pipeline engine (implemented by ProcessIntakePipelineUseCase). */
export interface GitLabPipelineRunner {
  run(pipeline: Rule[], triggerOutputs: Record<string, unknown>, files?: File[]): Promise<unknown>;
}

export interface GitLabTriggerResult {
  ok: boolean;
  /** How many pipelines this event started. */
  triggered: number;
}

/**
 * GitLab webhook as a pipeline *trigger* (`from: "gitlab:<alias>"` as a pipeline's first step):
 * a merge request or push event runs the matching pipelines — "MR merged" moving the Taiga item
 * to Done being the point of it.
 *
 * GitLab events say nothing about the tracker, so the task the event is about is recalled from
 * the task link that the `to: gitlab:*` step recorded when it created the branch and the MR.
 */
export class ProcessGitLabTriggerUseCase {
  private deduplicator = new Deduplicator();

  constructor(
    private config: Config,
    private registry: ProviderRegistry,
    private links: IPipelineStateStore | null,
    private pipelineRunner: GitLabPipelineRunner | null,
  ) {}

  async execute(payload: GitLabWebhookPayload): Promise<GitLabTriggerResult> {
    if (!this.pipelineRunner) return { ok: true, triggered: 0 };

    const facts = extractGitLabFacts(payload);
    if (!facts.event) {
      log.debug("GitLab webhook: payload without object_kind, ignored");
      return { ok: true, triggered: 0 };
    }

    let triggered = 0;

    for (let index = 0; index < this.config.rules.length; index++) {
      const pipeline = this.config.rules[index];
      const trigger = pipeline[0];
      if (!trigger || parseRef(trigger.from).type !== "gitlab") continue;

      const provider = this.registry.getGitLab(trigger.from);
      if (!provider) continue;
      if (!coversRepo(provider, facts.repo)) continue;
      if (!matchesGitLabCondition(trigger.on, facts)) continue;

      const dedupKey = [
        index, trigger.from, facts.event, facts.repo, facts.branch,
        payload.object_attributes?.iid ?? "", facts.action, facts.state,
        payload.checkout_sha ?? payload.object_attributes?.last_commit?.id ?? "",
      ].join(":");
      if (this.deduplicator.isDuplicate(dedupKey)) {
        log.debug("GitLab trigger: duplicate event skipped", { repo: facts.repo, pipeline: index });
        continue;
      }

      log.info(`GitLab trigger: ${trigger.from} ${facts.event} ${facts.action}`, {
        repo: facts.repo,
        branch: facts.branch,
        mr: payload.object_attributes?.iid,
        state: facts.state,
      });

      const outputs = this.buildOutputs(payload, facts);
      try {
        await this.pipelineRunner.run(pipeline, outputs);
        triggered++;
      } catch (e) {
        log.error("GitLab trigger: pipeline failed", {
          trigger: trigger.from,
          repo: facts.repo,
          error: String(e),
        });
      }
    }

    return { ok: true, triggered };
  }

  /** Trigger outputs for the templates of the pipeline's steps. */
  private buildOutputs(
    payload: GitLabWebhookPayload,
    facts: GitLabTriggerFacts,
  ): Record<string, unknown> {
    const attrs = payload.object_attributes ?? {};
    const mrIid = typeof attrs.iid === "number" ? attrs.iid : null;
    const link = this.findLink(facts.repo, mrIid, facts.branch);
    const lastCommit = attrs.last_commit ?? payload.commits?.[payload.commits.length - 1];

    if (!link) {
      log.debug("GitLab trigger: no task linked to this branch or MR", {
        repo: facts.repo, branch: facts.branch, mr: mrIid,
      });
    }

    return buildGitLabTriggerOutputs({
      event: facts.event,
      action: facts.action,
      state: facts.state,
      repo: facts.repo,
      repoUrl: payload.project?.web_url ?? "",
      branch: facts.branch,
      target: facts.target,
      mrIid,
      mrUrl: attrs.url ?? "",
      mrTitle: attrs.title ?? "",
      draft: facts.draft,
      merged: facts.merged,
      labels: facts.labels,
      author: payload.user?.name ?? payload.user_name ?? payload.user?.username ?? "",
      authorEmail: payload.user?.email ?? payload.user_email ?? "",
      commits: payload.total_commits_count ?? payload.commits?.length ?? 0,
      lastCommit: lastCommit?.title ?? lastCommit?.message?.split("\n")[0] ?? "",
      sha: payload.checkout_sha ?? lastCommit?.id ?? "",
      taskId: link?.taskId ?? "",
      taskName: link?.taskName ?? "",
      taskUrl: link?.taskUrl ?? "",
      taskIdentifier: link?.taskIdentifier ?? "",
      receivedAt: formatReceivedAt(new Date()),
    });
  }

  /** By merge request first, then by source branch (an MR opened by hand on a bridge branch). */
  private findLink(repo: string, mrIid: number | null, branch: string): TaskLink | null {
    if (!this.links || !repo) return null;
    try {
      const byMr = mrIid != null ? this.links.findTaskByMr(repo, mrIid) : null;
      if (byMr) return byMr;
      return branch ? this.links.findTaskByBranch(repo, branch) : null;
    } catch (e) {
      log.error("GitLab trigger: task link lookup failed", { repo, mrIid, error: String(e) });
      return null;
    }
  }
}

/**
 * Does this provider speak for that repository? Its default project and every repository in its
 * tag map, plus anything under one of its `groups` (so a group webhook covers new repositories
 * without a config change).
 */
export function coversRepo(provider: GitLabProvider, repo: string): boolean {
  if (!repo) return false;
  const path = repo.toLowerCase();
  if (provider.project.toLowerCase() === path) return true;
  if (Object.values(provider.repoByTag ?? {}).some((r) => r.toLowerCase() === path)) return true;
  return (provider.groups ?? []).some((g) => path.startsWith(`${g.toLowerCase()}/`));
}
