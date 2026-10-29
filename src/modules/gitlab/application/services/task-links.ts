import type { IPipelineStateStore } from "../../../../core/persistence/pipeline-state.port";
import { log } from "../../../../core/logger";

/**
 * Remember which tracker item a branch / merge request belongs to, from the outputs of a
 * `to: gitlab:*` step. This is the only link back: GitLab webhooks carry no tracker id, so
 * without it a merged MR could not move the right item.
 *
 * Best-effort — a storage failure must not fail the repository work that already succeeded.
 */
export function rememberTaskLink(
  store: IPipelineStateStore | null,
  tracker: string,
  outputs: Record<string, unknown>,
): void {
  if (!store) return;

  const repo = str(outputs.repo);
  const branch = str(outputs.branch);
  const taskId = str(outputs.taskId);
  if (!repo || !branch || !taskId) return;

  const mrIid = typeof outputs.mrIid === "number" ? outputs.mrIid : null;

  try {
    store.rememberTaskLink({
      repo,
      branch,
      mrIid,
      mrUrl: str(outputs.mrUrl),
      tracker,
      taskId,
      taskUrl: str(outputs.taskUrl),
      taskIdentifier: str(outputs.taskIdentifier),
      taskName: str(outputs.taskName),
    });
    log.debug("Task link recorded", { repo, branch, mrIid, tracker, taskId });
  } catch (e) {
    log.error("Failed to record the task link", { repo, branch, error: String(e) });
  }
}

function str(value: unknown): string {
  return value == null ? "" : String(value);
}
