import type { ITaigaApiClient } from "../ports/taiga-api.port";
import { log } from "../../../../core/logger";

export interface StoryProgress {
  /** Tasks the story is made of. */
  total: number;
  /** Tasks sitting in one of the requested statuses. */
  done: number;
  /** Every task of the story is in one of those statuses — and there is at least one task. */
  complete: boolean;
}

/**
 * How far a user story has got, measured against a set of task statuses ("Ready for Test", "Done").
 *
 * A story is delivered in pieces: each task moving on is progress worth seeing in Taiga, but none
 * of them means the story itself is ready — that is only true once *all* of its tasks are done.
 * Which is why this cannot be read off the event that arrives: the webhook is about one task, and
 * the answer is about its siblings.
 *
 * A story with no tasks is never complete: there is no work to judge, and treating it as finished
 * would roll up stories nobody has started.
 */
export async function storyTaskProgress(
  client: ITaigaApiClient,
  projectId: number,
  storyId: number,
  statusNames: string[],
): Promise<StoryProgress> {
  const tasks = await client.getTasksOfUserStory(storyId);
  if (tasks.length === 0) return { total: 0, done: 0, complete: false };

  const wanted = new Set(statusNames.map((n) => n.trim().toLowerCase()).filter(Boolean));
  const statuses = await client.getItemStatuses("task", projectId);
  const wantedIds = new Set(statuses.filter((s) => wanted.has(s.name.toLowerCase())).map((s) => s.id));

  const unknown = [...wanted].filter((n) => !statuses.some((s) => s.name.toLowerCase() === n));
  if (unknown.length > 0) {
    log.warn("Taiga story progress: task status not found in the project", {
      unknown,
      available: statuses.map((s) => s.name),
    });
  }

  const done = tasks.filter((t) => wantedIds.has(t.status)).length;
  return { total: tasks.length, done, complete: done === tasks.length };
}
