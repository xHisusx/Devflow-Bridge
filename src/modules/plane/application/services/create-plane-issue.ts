import type { PlaneProvider } from "../../../../core/config";
import type { IPlaneApiClient } from "../ports/plane-api.port";
import type { MappedContent } from "../../domain/services/content-mapper";
import { log } from "../../../../core/logger";

/** Raised when a Plane write (create / label resolution) cannot be completed. */
export class PlaneWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlaneWriteError";
  }
}

export interface PlaneCreateResult {
  result: { id: string; issue_id: string; sequence_id: number };
  projectId: string;
  projectIdentifier: string;
  /** Step outputs exposed to subsequent pipeline steps — must match PLANE_STEP_OUTPUTS. */
  outputs: Record<string, unknown>;
}

/**
 * Create a Plane work item from mapped content (name/description/labels/priority) and assemble the
 * canonical `plane` step outputs. Shared by the intake and webhook pipeline engines so the produced
 * fields stay in one place. File upload (intake-only) is layered on top by the caller.
 */
export async function createPlaneIssueFromContent(
  client: IPlaneApiClient,
  provider: PlaneProvider,
  mapped: MappedContent,
): Promise<PlaneCreateResult> {
  const { workspace, project, baseUrl } = provider;

  const name = typeof mapped.name === "string" ? mapped.name : undefined;
  if (!name) throw new PlaneWriteError("name is required (resolved to empty)");
  const description = typeof mapped.description === "string" ? mapped.description : undefined;
  const labels = Array.isArray(mapped.labels) ? mapped.labels.map(String) : undefined;
  const priority = typeof mapped.priority === "string" ? mapped.priority : undefined;

  // Resolve project name/identifier -> id
  const projects = await client.getProjects(workspace);
  const projectObj = projects.find((p) => p.name === project || p.identifier === project);
  if (!projectObj) throw new PlaneWriteError(`Project "${project}" not found in workspace "${workspace}"`);
  const projectId = projectObj.id;
  const projectIdentifier = projectObj.identifier;

  // Create issue
  const result = await client.createIntakeIssue(workspace, projectId, {
    name,
    ...(description ? { description_html: description } : {}),
  });
  log.info("Plane issue created", { id: result.id, issue_id: result.issue_id, workspace, project });

  // Resolve and assign labels + priority
  const patchData: { labels?: string[]; priority?: string } = {};
  if (labels && labels.length > 0) {
    const projectLabels = await client.getLabels(workspace, projectId);
    const labelMap = new Map(projectLabels.map((l) => [l.name.toLowerCase(), l.id]));
    const notFound: string[] = [];
    const resolved: string[] = [];
    for (const label of labels) {
      const id = labelMap.get(label.toLowerCase());
      if (id) resolved.push(id);
      else notFound.push(label);
    }
    if (notFound.length > 0) throw new PlaneWriteError(`Labels not found: ${notFound.join(", ")}`);
    patchData.labels = resolved;
  }
  if (priority) patchData.priority = priority;

  if (Object.keys(patchData).length > 0) {
    try {
      await client.updateWorkItem(workspace, projectId, result.issue_id, patchData);
      log.info("Work item updated", patchData);
    } catch (e) {
      log.error("Failed to update work item", { error: String(e) });
    }
  }

  const seq = result.sequence_id;
  const identifier = seq ? `${projectIdentifier}-${seq}` : "";
  const issueUrl = seq ? `${baseUrl}/${workspace}/browse/${identifier}/` : "";

  const outputs: Record<string, unknown> = {
    issueId: result.issue_id,
    issueUrl,
    seq,
    identifier,
    name,
    title: name,
    description: description ?? "",
    labels: labels ?? [],
    workspace,
    project,
    action: "create",
  };

  return { result, projectId, projectIdentifier, outputs };
}
