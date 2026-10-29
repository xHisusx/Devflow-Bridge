import type { Config } from "../../../../core/config";
import type { ProviderRegistry } from "../../../../core/provider-registry";
import type { PlaneStateInline } from "../../domain/entities/issue";
import type { PlaneMember } from "../../domain/entities/member";
import type { PlaneWebhookPayload } from "../../domain/entities/webhook-payload";
import type { IMessengerClient } from "../../../messenger/application/ports/messenger-client.port";
import type { IMessageStore } from "../../../messenger/application/ports/message-store.port";
import type { IPlaneApiClient } from "../ports/plane-api.port";
import type { NotifyContent, PlaneContent } from "../../../messenger/domain/entities/notification";
import { matchesCondition } from "../../domain/services/rule-matcher";
import { renderMessage, DEFAULT_TEMPLATE } from "../../domain/services/template-renderer";
import { mapContent } from "../../domain/services/content-mapper";
import { buildPlaneTriggerOutputs } from "../../domain/services/trigger-outputs";
import { parseRef } from "../../../messenger/domain/entities/notification";
import { Deduplicator } from "../../domain/services/deduplicator";
import { extractButtons } from "../../../messenger/domain/services/action-executor";
import { executeActions } from "../../../messenger/application/use-cases/execute-actions";
import { sendPachkaMessage } from "../../../messenger/infrastructure/clients/pachka-webhook-sender";
import { filterOutputs, onceKey } from "../../../../core/pipeline";
import type { IPipelineStateStore } from "../../../../core/persistence/pipeline-state.port";
import { rememberTaskLink } from "../../../gitlab/application/services/task-links";
import { createPlaneIssueFromContent } from "../services/create-plane-issue";
import { createTaigaIssueFromContent } from "../../../taiga/application/services/create-taiga-issue";
import { updateTaigaItemFromContent } from "../../../taiga/application/services/update-taiga-item";
import type { ITaigaApiClient } from "../../../taiga/application/ports/taiga-api.port";
import type { IGitLabApiClient } from "../../../gitlab/application/ports/gitlab-api.port";
import { runGitLabStep } from "../../../gitlab/application/services/run-gitlab-step";
import type { GitLabContent } from "../../../messenger/domain/entities/notification";
import type { PachkaUserDirectory } from "../../../messenger/application/services/pachka-user-directory";
import { resolvePachkaTarget } from "../../../messenger/application/services/resolve-pachka-target";
import type { Rule } from "../../../messenger/domain/entities/notification";
import { log } from "../../../../core/logger";

export interface ProcessWebhookInput {
  entity: string;
  action: string;
  payload: PlaneWebhookPayload;
}

export interface ProcessWebhookResult {
  sent: number;
}

export class ProcessPlaneWebhookUseCase {
  private deduplicator: Deduplicator;

  constructor(
    private config: Config,
    private registry: ProviderRegistry,
    private messengerClient: IMessengerClient | null,
    private messageStore: IMessageStore | null,
    private projectIdMap: Map<string, string>,
    private projectIdentifierMap: Map<string, string>,
    private memberMap: Map<string, PlaneMember>,
    private planeClients: Map<string, IPlaneApiClient> = new Map(),
    private taigaClients: Map<string, ITaigaApiClient> = new Map(),
    private gitlabClients: Map<string, IGitLabApiClient> = new Map(),
    private userDirectory: PachkaUserDirectory | null = null,
    private pipelineState: IPipelineStateStore | null = null,
  ) {
    this.deduplicator = new Deduplicator();
  }

  async execute(input: ProcessWebhookInput): Promise<ProcessWebhookResult> {
    const { entity, action, payload } = input;
    const issue = payload.data;
    const state = typeof issue.state === "object" ? (issue.state as PlaneStateInline) : null;
    const stateName = state?.name ?? "unknown";
    const priority = issue.priority ?? "none";

    const activityField = payload.activity?.field ?? "";
    const dedupKey = `${issue.id}:${action}:${stateName}:${issue.updated_at}:${activityField}`;
    if (this.deduplicator.isDuplicate(dedupKey)) {
      log.debug(`Webhook: duplicate skipped (${entity} ${action} "${issue.name}")`);
      return { sent: 0 };
    }

    log.info(`Webhook: ${entity} ${action} "${issue.name}" state="${stateName}" priority="${priority}"`);

    // Provider-independent event field (resolved against the member map).
    const assignee =
      (issue.assignees ?? [])
        .map((a: any) => {
          if (typeof a === "object" && a !== null) {
            return a.first_name && a.last_name ? `${a.first_name} ${a.last_name}` : (a.display_name ?? a.id);
          }
          const m = this.memberMap.get(a);
          if (!m) return a;
          return m.first_name && m.last_name ? `${m.first_name} ${m.last_name}` : m.display_name;
        })
        .join(", ") || "\u043D\u0435 \u043D\u0430\u0437\u043D\u0430\u0447\u0435\u043D";

    let sent = 0;

    for (const pipeline of this.config.rules) {
      if (pipeline.length === 0) continue;
      const trigger = pipeline[0];

      // Webhook pipelines are gated by a plane trigger as their first step.
      if (parseRef(trigger.from).type !== "plane") continue;

      const planeProvider = this.registry.getPlane(trigger.from);
      if (!planeProvider) continue;

      // Match project: resolve provider's project name to UUID against the event.
      const projectId = this.projectIdMap.get(`${planeProvider.workspace}:${planeProvider.project}`);
      if (!projectId || issue.project !== projectId) continue;

      const projectIdentifier = this.projectIdentifierMap.get(projectId) ?? planeProvider.project;
      const identifier = `${projectIdentifier}-${issue.sequence_id}`;
      const triggerOutputs = buildPlaneTriggerOutputs({
        project: planeProvider.project,
        seq: String(issue.sequence_id),
        title: issue.name,
        state: stateName,
        stateGroup: state?.group ?? "",
        priority,
        action,
        entity,
        issueId: issue.id,
        issueUrl: `${planeProvider.baseUrl}/${planeProvider.workspace}/browse/${identifier}/`,
        identifier,
        assignee,
      });

      // Context carries each step's outputs to subsequent steps, keyed by "type:alias".
      const context = new Map<string, Record<string, unknown>>();
      context.set(trigger.from, triggerOutputs);

      for (let i = 0; i < pipeline.length; i++) {
        const step = pipeline[i];
        const source = context.get(step.from);
        if (!source) {
          log.warn(`-> ${step.to}: source "${step.from}" has no outputs in context (must reference a previous step)`);
          break;
        }

        // The trigger step gates the whole pipeline against the event conditions.
        if (i === 0 && !matchesCondition(step.on, entity, action, state, priority, payload.activity)) {
          break;
        }

        // A step declared `once` runs a single time per key (see onceKey), across restarts.
        const guard = onceKey(step, source);
        if (guard && this.pipelineState && !this.pipelineState.markOnce(guard)) {
          log.debug(`-> ${step.to}: already ran once, skipped`, { key: guard });
          continue;
        }

        const outputs = await this.executeStep(step, source);
        if (outputs) {
          context.set(step.to, filterOutputs(outputs, step.on.outputs));
          const targetType = parseRef(step.to).type;
          // Count notifications, not tracker or repository writes.
          if (targetType === "pachka" || targetType === "webhook") sent++;
          if (targetType === "gitlab") rememberTaskLink(this.pipelineState, step.from, outputs);
        } else if (guard) {
          // The step failed: release the key so the next event can try again.
          this.pipelineState?.forget(guard);
        }
      }
    }

    return { sent };
  }

  /**
   * Execute one pipeline step (plane create / pachka / webhook) using `source` outputs.
   * Returns the step's outputs (per provider schema) or null on failure / unsupported target.
   */
  private async executeStep(
    step: Rule,
    source: Record<string, unknown>,
  ): Promise<Record<string, unknown> | null> {
    const { type: toType } = parseRef(step.to);

    try {
      if (toType === "plane") {
        return await this.executePlaneStep(step, source);
      }
      if (toType === "taiga") {
        return await this.executeTaigaStep(step, source);
      }
      if (toType === "gitlab") {
        return await this.executeGitlabStep(step, source);
      }

      const content = step.on.content as NotifyContent;
      const message = renderMessage(content.message ?? DEFAULT_TEMPLATE, source);
      // Correlation key: the upstream entity id (the Plane issue for a plane trigger, or the task
      // a gitlab step did the repository work for).
      const correlationId = String(source.issueId ?? source.taskId ?? "");

      if (toType === "pachka") {
        const pachkaProvider = this.registry.getPachka(step.to);
        if (!pachkaProvider || !this.messengerClient || !this.messageStore) {
          log.warn(`-> ${step.to}: not configured or client unavailable`);
          return null;
        }
        const destination = await resolvePachkaTarget(
          pachkaProvider, content, source, this.userDirectory,
        );
        if (!destination) return null;
        const chatId = destination.entityId;
        const target = pachkaProvider.alias;
        const previousMessageId = this.messageStore.get(correlationId, target);
        const buttons = extractButtons(content.actions, source);
        const msg = await this.messengerClient.sendMessage(chatId, message, {
          buttons,
          ...(destination.entityType === "discussion" ? {} : { entityType: destination.entityType }),
        });
        this.messageStore.set(correlationId, target, msg.id, chatId);
        log.debug(`-> ${step.to}: "${message}"`, { msgId: msg.id });

        if (content.actions) {
          await executeActions(content.actions, {
            client: this.messengerClient,
            store: this.messageStore,
            chatId,
            target,
            correlationId,
            source: { ...source, _currentMessage: message },
            currentMessageId: msg.id,
            previousMessageId,
          });
        }
        return { messageId: msg.id, chatId, channel: target, message };
      } else if (toType === "webhook") {
        const webhookProvider = this.registry.getWebhook(step.to);
        if (!webhookProvider) {
          log.warn(`-> ${step.to}: not configured`);
          return null;
        }
        await sendPachkaMessage(webhookProvider.url, message);
        log.debug(`-> ${step.to}: "${message}"`);
        return { channel: webhookProvider.alias, message };
      }
      log.warn(`-> ${step.to}: unsupported target type "${toType}" in webhook pipeline`);
      return null;
    } catch (e) {
      log.error(`-> ${step.to}: FAILED`, { error: String(e) });
      return null;
    }
  }

  /** Create a Plane work item from the event (e.g. mirror/escalate to another project). */
  private async executePlaneStep(
    step: Rule,
    source: Record<string, unknown>,
  ): Promise<Record<string, unknown> | null> {
    const planeProvider = this.registry.getPlane(step.to);
    const client = this.planeClients.get(step.to);
    if (!planeProvider || !client) {
      log.warn(`-> ${step.to}: plane provider or API client not configured`);
      return null;
    }
    const mapped = mapContent(step.on.content as PlaneContent, source);
    const { outputs } = await createPlaneIssueFromContent(client, planeProvider, mapped);
    log.debug(`-> ${step.to}: created issue ${outputs.issueId}`);
    return outputs;
  }

  /** Create or update a Taiga item from the event (mirror/escalate, or write back a link). */
  private async executeTaigaStep(
    step: Rule,
    source: Record<string, unknown>,
  ): Promise<Record<string, unknown> | null> {
    const taigaProvider = this.registry.getTaiga(step.to);
    const client = this.taigaClients.get(step.to);
    if (!taigaProvider || !client) {
      log.warn(`-> ${step.to}: taiga provider or API client not configured`);
      return null;
    }
    const mapped = mapContent(step.on.content as PlaneContent, source);

    // A declared `item` means update, never create: an unresolved one is a skip, so an empty
    // template cannot spawn a duplicate item.
    if ("item" in (step.on.content as Record<string, unknown>)) {
      if (mapped.item == null || mapped.item === "") {
        log.warn(`-> ${step.to}: "item" resolved to empty, update skipped`);
        return null;
      }
      const { outputs } = await updateTaigaItemFromContent(client, taigaProvider, mapped);
      log.debug(`-> ${step.to}: updated item ${outputs.issueId}`);
      return outputs;
    }

    const { outputs } = await createTaigaIssueFromContent(client, taigaProvider, mapped);
    log.debug(`-> ${step.to}: created item ${outputs.issueId}`);
    return outputs;
  }

  /** Repository work for the event: branch, draft MR, issue, comment. */
  private async executeGitlabStep(
    step: Rule,
    source: Record<string, unknown>,
  ): Promise<Record<string, unknown> | null> {
    const provider = this.registry.getGitLab(step.to);
    const client = this.gitlabClients.get(step.to);
    if (!provider || !client) {
      log.warn(`-> ${step.to}: gitlab provider or API client not configured`);
      return null;
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
}
