import type { Config, BitrixContent } from "../../../../core/config";
import type { ProviderRegistry } from "../../../../core/provider-registry";
import type { IPlaneApiClient } from "../ports/plane-api.port";
import type { IMessengerClient } from "../../../messenger/application/ports/messenger-client.port";
import type { IMessageStore } from "../../../messenger/application/ports/message-store.port";
import { parseRef, type NotifyContent, type PlaneContent, type Rule } from "../../../messenger/domain/entities/notification";
import { renderMessage, DEFAULT_INTAKE_TEMPLATE } from "../../domain/services/template-renderer";
import { mapContent } from "../../domain/services/content-mapper";
import { extractButtons } from "../../../messenger/domain/services/action-executor";
import { executeActions } from "../../../messenger/application/use-cases/execute-actions";
import { sendPachkaMessage } from "../../../messenger/infrastructure/clients/pachka-webhook-sender";
import { filterOutputs, onceKey } from "../../../../core/pipeline";
import type { IPipelineStateStore } from "../../../../core/persistence/pipeline-state.port";
import { createPlaneIssueFromContent } from "../services/create-plane-issue";
import { createTaigaIssueFromContent } from "../../../taiga/application/services/create-taiga-issue";
import { updateTaigaItemFromContent } from "../../../taiga/application/services/update-taiga-item";
import type { ITaigaApiClient } from "../../../taiga/application/ports/taiga-api.port";
import type { IGitLabApiClient } from "../../../gitlab/application/ports/gitlab-api.port";
import { runGitLabStep } from "../../../gitlab/application/services/run-gitlab-step";
import { rememberTaskLink } from "../../../gitlab/application/services/task-links";
import type { GitLabContent } from "../../../messenger/domain/entities/notification";
import type { PachkaUserDirectory } from "../../../messenger/application/services/pachka-user-directory";
import { resolvePachkaTarget } from "../../../messenger/application/services/resolve-pachka-target";
import type { IBitrixClient } from "../../../bitrix/application/ports/bitrix-api.port";
import {
  BitrixMappingError,
  updateBitrixStatusFromTaiga,
} from "../../../bitrix/application/services/update-bitrix-status";
import { log } from "../../../../core/logger";

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/jpg", "image/gif", "image/webp"]);

function isImage(file: File): boolean {
  return IMAGE_TYPES.has((file.type || "").split(";")[0]);
}

function buildImageNode(assetId: string, blockId: string): string {
  return `<image-component src="${assetId}" data-id="${blockId}" id="${blockId}" width="auto" aspectratio="1" alignment="left" status="uploaded"></image-component>`;
}

export interface IntakePipelineInput {
  body: Record<string, unknown>;
  files?: File[];
}

export interface IntakePipelineResult {
  ok: boolean;
  id?: string;
  issue_id?: string;
  attachments: string[];
  notifications_sent: number;
}

export class ProcessIntakePipelineUseCase {
  constructor(
    private config: Config,
    private registry: ProviderRegistry,
    private planeClients: Map<string, IPlaneApiClient>,
    private messengerClient: IMessengerClient | null,
    private messageStore: IMessageStore | null,
    private taigaClients: Map<string, ITaigaApiClient> = new Map(),
    private gitlabClients: Map<string, IGitLabApiClient> = new Map(),
    private userDirectory: PachkaUserDirectory | null = null,
    private pipelineState: IPipelineStateStore | null = null,
    private bitrixClients: Map<string, IBitrixClient> = new Map(),
  ) {}

  /**
   * Run the intake pipeline triggered by `apiRef` (e.g. "api:intake"). When omitted, falls back to
   * the first pipeline whose source is any `api:*` provider (single-endpoint default).
   */
  async execute(input: IntakePipelineInput, apiRef?: string): Promise<IntakePipelineResult> {
    const pipeline = this.config.rules.find((p) => {
      if (p.length === 0) return false;
      return apiRef ? p[0].from === apiRef : parseRef(p[0].from).type === "api";
    });

    if (!pipeline || pipeline.length === 0) {
      log.warn("No intake pipeline configured", { apiRef });
      return { ok: false, attachments: [], notifications_sent: 0 };
    }

    return this.run(
      pipeline,
      {
        body: input.body,
        files: input.files ?? [],
        receivedAt: formatReceivedAt(new Date()),
      },
      input.files ?? [],
    );
  }

  /**
   * Run a pipeline with pre-built trigger outputs seeded under the first step's `from` ref.
   * Also used by form-submission pipelines (`from: form:*`), which build their own trigger.
   */
  async run(
    pipeline: Rule[],
    triggerOutputs: Record<string, unknown>,
    files: File[] = [],
  ): Promise<IntakePipelineResult> {
    // === Context: stores outputs of each step, keyed by "type:alias" ===
    const context = new Map<string, Record<string, unknown>>();
    context.set(pipeline[0].from, triggerOutputs);

    let result: { id: string; issue_id: string; sequence_id: number } | null = null;
    const attachments: string[] = [];
    let notificationsSent = 0;
    // Writing elsewhere (a repository, a Bitrix appeal) is a completed step on its own, even in a
    // pipeline that creates no tracker item.
    let sideEffectSteps = 0;
    // Refs of steps that did not run, so the steps reading from them are skipped as well.
    const skipped = new Set<string>();

    for (const step of pipeline) {
      const sourceOutputs = context.get(step.from);
      if (!sourceOutputs) {
        if (skipped.has(step.from)) {
          skipped.add(step.to);
          continue;
        }
        throw new IntakePipelineError(
          `Step "${step.to}": source "${step.from}" has no outputs in context`,
        );
      }

      const guard = this.claimOnce(step, sourceOutputs);
      if (guard === "skip") {
        skipped.add(step.to);
        continue;
      }

      const { type: toType } = parseRef(step.to);

      try {
        if (toType === "plane") {
          const stepResult = await this.executePlaneStep(step, sourceOutputs, files);
          result = stepResult.result;
          attachments.push(...stepResult.attachments);
          context.set(step.to, filterOutputs(stepResult.outputs, step.on.outputs));
        } else if (toType === "taiga") {
          const stepResult = await this.executeTaigaStep(step, sourceOutputs, files);
          if (!stepResult) {
            this.releaseOnce(guard);
            skipped.add(step.to);
            continue;
          }
          result = stepResult.result;
          context.set(step.to, filterOutputs(stepResult.outputs, step.on.outputs));
        } else if (toType === "gitlab") {
          const outputs = await this.executeGitlabStep(step, sourceOutputs);
          sideEffectSteps++;
          // Remember what the branch and MR are for, so a GitLab webhook can find the item again.
          rememberTaskLink(this.pipelineState, step.from, outputs);
          context.set(step.to, filterOutputs(outputs, step.on.outputs));
        } else if (toType === "pachka") {
          const outputs = await this.executePachkaStep(step, sourceOutputs);
          if (outputs) {
            notificationsSent++;
            context.set(step.to, filterOutputs(outputs, step.on.outputs));
          } else {
            this.releaseOnce(guard);
            skipped.add(step.to);
          }
        } else if (toType === "webhook") {
          const outputs = await this.executeWebhookStep(step, sourceOutputs);
          if (outputs) {
            notificationsSent++;
            context.set(step.to, filterOutputs(outputs, step.on.outputs));
          } else {
            this.releaseOnce(guard);
            skipped.add(step.to);
          }
        } else if (toType === "bitrix") {
          const outputs = await this.executeBitrixStep(step, sourceOutputs);
          if (outputs) {
            sideEffectSteps++;
            context.set(step.to, filterOutputs(outputs, step.on.outputs));
          } else {
            this.releaseOnce(guard);
            skipped.add(step.to);
          }
        } else {
          this.releaseOnce(guard);
          log.warn(`Step "${step.to}": unsupported target type "${toType}"`);
        }
      } catch (e) {
        // A guard must not outlive a failed step, or the retry would be skipped silently.
        this.releaseOnce(guard);
        throw e;
      }
    }

    if (!result) {
      const ok = sideEffectSteps > 0 || notificationsSent > 0;
      if (ok) {
        log.info("Pipeline completed", { steps: sideEffectSteps, notifications: notificationsSent });
      }
      return { ok, attachments: [], notifications_sent: notificationsSent };
    }

    log.info("Intake pipeline completed", {
      issue_id: result.issue_id,
      attachments: attachments.length,
      notifications: notificationsSent,
    });

    return {
      ok: true,
      id: result.id,
      issue_id: result.issue_id,
      attachments,
      notifications_sent: notificationsSent,
    };
  }

  /**
   * Claim the `once` key of a step before running it: null when the step has no guard, the
   * claimed key on a first run, "skip" when it ran before. Claiming up front (rather than
   * marking afterwards) keeps two concurrent webhooks from both passing the guard.
   */
  private claimOnce(step: Rule, source: Record<string, unknown>): string | null | "skip" {
    const key = onceKey(step, source);
    if (!key) return null;

    if (!this.pipelineState) {
      log.warn(
        `Step "${step.from} -> ${step.to}" declares "once" but no state store is available, running it`,
      );
      return null;
    }
    if (!this.pipelineState.markOnce(key)) {
      log.info(`Step "${step.from} -> ${step.to}" already ran once, skipped`, { key });
      return "skip";
    }
    return key;
  }

  private releaseOnce(guard: string | null | "skip"): void {
    if (guard && guard !== "skip") this.pipelineState?.forget(guard);
  }

  private async executePlaneStep(
    step: Rule,
    source: Record<string, unknown>,
    files: File[],
  ): Promise<{
    result: { id: string; issue_id: string; sequence_id: number };
    attachments: string[];
    outputs: Record<string, unknown>;
  }> {
    const planeProvider = this.registry.getPlane(step.to);
    if (!planeProvider) {
      throw new IntakePipelineError(`Plane provider "${step.to}" not found`);
    }
    const client = this.planeClients.get(step.to);
    if (!client) {
      throw new IntakePipelineError(`No Plane API client configured for "${step.to}"`);
    }

    const { workspace } = planeProvider;

    // Create the issue + assign labels/priority + compose outputs (shared with the webhook engine).
    const mapped = mapContent(step.on.content as PlaneContent, source);
    log.info("Intake pipeline started", { workspace, project: planeProvider.project, name: mapped.name });
    const { result, projectId, outputs } = await createPlaneIssueFromContent(client, planeProvider, mapped);

    const description = typeof outputs.description === "string" ? outputs.description : "";

    // === Upload files (intake-only; webhook events carry none) ===
    const imageFiles = files.filter(isImage);
    const otherFiles = files.filter((f) => !isImage(f));
    const attachments: string[] = [];
    const imageNodes: string[] = [];

    for (const file of [...imageFiles, ...otherFiles]) {
      log.debug("Uploading file", { name: file.name, type: file.type, size: file.size });
      try {
        const credentials = await client.getUploadCredentials(
          workspace, projectId, result.issue_id,
          { name: file.name, type: (file.type || "application/octet-stream").split(";")[0], size: file.size },
        );
        await client.uploadToStorage(credentials, file);
        await client.completeUpload(workspace, projectId, result.issue_id, credentials.asset_id);
        attachments.push(credentials.asset_id);

        if (isImage(file)) {
          const blockId = crypto.randomUUID();
          imageNodes.push(buildImageNode(credentials.asset_id, blockId));
          log.info("Image embedded", { file: file.name, assetId: credentials.asset_id });
        } else {
          log.info("Attachment uploaded", { file: file.name, assetId: credentials.asset_id });
        }
      } catch (e) {
        log.error("Failed to upload file", { file: file.name, error: String(e) });
      }
    }

    if (imageNodes.length > 0) {
      const descPart = description
        ? `<p class="editor-paragraph-block" data-id="${crypto.randomUUID()}">${description}</p>`
        : "";
      const updatedHtml = descPart + imageNodes.join("");
      try {
        await client.updateWorkItem(workspace, projectId, result.issue_id, {
          description_html: updatedHtml,
        });
        log.info("Description updated with embedded images", { count: imageNodes.length });
      } catch (e) {
        log.error("Failed to update description with images", { error: String(e) });
      }
    }

    return { result, attachments, outputs };
  }

  /**
   * Create a Taiga item (issue / user story / task), or update one when the content declares
   * `item`. Returns null when an update has nothing to act on (its `item` resolved to empty).
   * Attachments are not supported by Taiga yet.
   */
  private async executeTaigaStep(
    step: Rule,
    source: Record<string, unknown>,
    files: File[],
  ): Promise<{
    result: { id: string; issue_id: string; sequence_id: number };
    outputs: Record<string, unknown>;
  } | null> {
    const taigaProvider = this.registry.getTaiga(step.to);
    if (!taigaProvider) {
      throw new IntakePipelineError(`Taiga provider "${step.to}" not found`);
    }
    const client = this.taigaClients.get(step.to);
    if (!client) {
      throw new IntakePipelineError(`No Taiga API client configured for "${step.to}"`);
    }

    if (files.length > 0) {
      log.warn("Taiga step: attachments are not supported, skipping files", { count: files.length });
    }

    const mapped = mapContent(step.on.content as PlaneContent, source);

    // Two modes on the same target: a declared `item` means "update that item", otherwise create
    // a new one. A declared but unresolved item is a skip, never a create: an empty template (no
    // task linked to that merge request, say) must not spawn a duplicate issue.
    if ("item" in (step.on.content as Record<string, unknown>)) {
      if (mapped.item == null || mapped.item === "") {
        log.warn(`Taiga update step "${step.to}": "item" resolved to empty, step skipped`);
        return null;
      }
      log.info("Taiga update step", { taiga: taigaProvider.project, item: mapped.item });
      return updateTaigaItemFromContent(client, taigaProvider, mapped);
    }

    log.info("Intake pipeline started", { taiga: taigaProvider.project, name: mapped.name });
    return createTaigaIssueFromContent(client, taigaProvider, mapped);
  }

  /** Repository work: create the branch, open or reuse the draft MR, create an issue, comment. */
  private async executeGitlabStep(
    step: Rule,
    source: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const provider = this.registry.getGitLab(step.to);
    if (!provider) {
      throw new IntakePipelineError(`GitLab provider "${step.to}" not found`);
    }
    const client = this.gitlabClients.get(step.to);
    if (!client) {
      throw new IntakePipelineError(`No GitLab API client configured for "${step.to}"`);
    }

    const { outputs } = await runGitLabStep(
      client,
      provider,
      step.on.content as GitLabContent,
      source,
    );
    log.debug(`-> ${step.to}: branch="${outputs.branch}" mr=${outputs.mrUrl || "—"}`);
    return outputs;
  }

  /** Send a Pachka notification. Returns the step's outputs (per pachka schema) or null on failure. */
  private async executePachkaStep(
    step: Rule,
    source: Record<string, unknown>,
  ): Promise<Record<string, unknown> | null> {
    const content = step.on.content as NotifyContent;

    const pachkaProvider = this.registry.getPachka(step.to);
    if (!pachkaProvider || !this.messengerClient || !this.messageStore) {
      log.warn(`Intake notification: ${step.to} not configured or client unavailable`);
      return null;
    }

    const message = renderMessage(content.message || DEFAULT_INTAKE_TEMPLATE, source);
    // Correlation key: the upstream entity id. After a gitlab step that is the task the branch
    // was made for (`taskId`), otherwise the tracker item the step just wrote (`issueId`).
    const correlationId = String(source.issueId ?? source.taskId ?? "");

    const destination = await resolvePachkaTarget(pachkaProvider, content, source, this.userDirectory);
    if (!destination) return null;

    try {
      const chatId = destination.entityId;
      const target = pachkaProvider.alias;
      const buttons = extractButtons(content.actions, source);
      const msg = await this.messengerClient.sendMessage(chatId, message, {
        buttons,
        // Left out for chats so the call stays the plain "send to a discussion" one.
        ...(destination.entityType === "discussion" ? {} : { entityType: destination.entityType }),
      });
      if (correlationId) this.messageStore.set(correlationId, target, msg.id, chatId);
      log.debug(`Intake -> ${step.to}: "${message}"`, { msgId: msg.id });

      if (content.actions && correlationId) {
        const previousMessageId = this.messageStore.get(correlationId, target);
        await executeActions(content.actions, {
          client: this.messengerClient,
          store: this.messageStore,
          chatId,
          target,
          correlationId,
          source: { ...source, _currentMessage: message },
          currentMessageId: msg.id,
          previousMessageId: previousMessageId !== msg.id ? previousMessageId : null,
        });
      }
      return { messageId: msg.id, chatId, channel: target, message };
    } catch (e) {
      log.error(`Intake notification failed`, { target: step.to, error: String(e) });
      return null;
    }
  }

  /** Send via webhook. Returns the step's outputs (per webhook schema) or null on failure. */
  private async executeWebhookStep(
    step: Rule,
    source: Record<string, unknown>,
  ): Promise<Record<string, unknown> | null> {
    const webhookProvider = this.registry.getWebhook(step.to);
    if (!webhookProvider) {
      log.warn(`Intake notification: ${step.to} not configured`);
      return null;
    }
    const content = step.on.content as NotifyContent;
    const message = renderMessage(content.message || DEFAULT_INTAKE_TEMPLATE, source);
    try {
      await sendPachkaMessage(webhookProvider.url, message);
      log.debug(`Intake -> ${step.to}: "${message}"`);
      return { channel: webhookProvider.alias, message };
    } catch (e) {
      log.error(`Intake notification failed`, { target: step.to, error: String(e) });
      return null;
    }
  }

  /**
   * Set the status of the Bitrix appeal the tracker item came from. Returns null when the item
   * carries no BitrixID: not every request originates in Bitrix, so that is a skip, not an error.
   */
  private async executeBitrixStep(
    step: Rule,
    source: Record<string, unknown>,
  ): Promise<Record<string, unknown> | null> {
    const provider = this.registry.getBitrix(step.to);
    if (!provider) throw new IntakePipelineError(`Bitrix provider "${step.to}" not found`);
    const client = this.bitrixClients.get(step.to);
    if (!client) throw new IntakePipelineError(`No Bitrix API client configured for "${step.to}"`);

    let outputs: Record<string, unknown>;
    try {
      outputs = await updateBitrixStatusFromTaiga(
        client,
        provider,
        source,
        step.on.content as BitrixContent,
      );
    } catch (error) {
      if (error instanceof BitrixMappingError) {
        log.warn("Bitrix step skipped: BitrixID is absent from Taiga description", {
          provider: step.to,
          error: error.message,
        });
        return null;
      }
      throw error;
    }
    log.info("Bitrix appeal status updated", {
      provider: step.to,
      bitrixId: outputs.bitrixId,
      status: outputs.status,
    });
    return outputs;
  }
}

export class IntakePipelineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntakePipelineError";
  }
}

/** Server-local receive timestamp for templates: "11.07.2026 08:03". */
export function formatReceivedAt(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
