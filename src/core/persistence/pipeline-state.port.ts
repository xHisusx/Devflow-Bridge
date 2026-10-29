/**
 * Durable state shared by the pipeline engines, independent of any provider:
 *
 * - **once keys** — a step declared `once` runs a single time per key, surviving restarts. Without
 *   persistence a re-assignment (or a webhook replay) would notify the same person again.
 * - **task links** — which tracker item a branch / merge request was created for. GitLab webhooks
 *   carry no tracker id, so this is what lets "MR merged" move the right Taiga item.
 */

export interface TaskLink {
  /** Repository path with namespace ("team/backend"). */
  repo: string;
  branch: string;
  /** Null until the merge request is opened. */
  mrIid: number | null;
  /** Web URL of that merge request; empty until it is opened. */
  mrUrl: string;
  /** Provider ref the task lives in ("taiga:dev"), so a write-back targets the right instance. */
  tracker: string;
  taskId: string;
  taskUrl: string;
  taskIdentifier: string;
  taskName: string;
}

export interface IPipelineStateStore {
  /** True the first time the key is seen (and remembers it), false on every later call. */
  markOnce(key: string): boolean;
  /** Release a key claimed by `markOnce` — used when the step it guarded then failed. */
  forget(key: string): void;
  /** Record (or update) the branch/MR -> tracker item link. Keyed by repo + branch. */
  rememberTaskLink(link: TaskLink): void;
  findTaskByMr(repo: string, mrIid: number): TaskLink | null;
  findTaskByBranch(repo: string, branch: string): TaskLink | null;
  /**
   * The repository work recorded for a tracker item — the reverse lookup. A tracker event carries
   * no branch or merge request, so this is what lets a card about the item be re-rendered with
   * them. Prefers a link that already has a merge request, then the most recent one.
   */
  findLinkByTask(tracker: string, taskId: string): TaskLink | null;
}
