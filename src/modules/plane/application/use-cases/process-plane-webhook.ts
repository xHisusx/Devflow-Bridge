import type { Config, BitrixContent } from "../../../../core/config";
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
import { filterOutputs } from "../../../../core/pipeline";
import { createPlaneIssueFromContent } from "../services/create-plane-issue";
import { createTaigaIssueFromContent } from "../../../taiga/application/services/create-taiga-issue";
import type { ITaigaApiClient } from "../../../taiga/application/ports/taiga-api.port";
import type { IBitrixClient } from "../../../bitrix/application/ports/bitrix-api.port";
import { updateBitrixStatusFromTaiga } from "../../../bitrix/application/services/update-bitrix-status";
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
    private bitrixClients: Map<string, IBitrixClient> = new Map(),
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

        const outputs = await this.executeStep(step, source);
        if (outputs) {
          context.set(step.to, filterOutputs(outputs, step.on.outputs));
          const targetType = parseRef(step.to).type;
          if (targetType !== "plane" && targetType !== "taiga") sent++; // count notifications, not tracker writes
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
      if (toType === "bitrix") {
        return await this.executeBitrixStep(step, source);
      }

      const content = step.on.content as NotifyContent;
      const message = renderMessage(content.message ?? DEFAULT_TEMPLATE, source);
      // Correlation key comes from the upstream source's entity id (Plane issue id for a plane trigger).
      const correlationId = String(source.issueId ?? "");

      if (toType === "pachka") {
        const pachkaProvider = this.registry.getPachka(step.to);
        if (!pachkaProvider || !this.messengerClient || !this.messageStore) {
          log.warn(`-> ${step.to}: not configured or client unavailable`);
          return null;
        }
        const chatId = pachkaProvider.chatId;
        const target = pachkaProvider.alias;
        const previousMessageId = this.messageStore.get(correlationId, target);
        const buttons = extractButtons(content.actions, source);
        const msg = await this.messengerClient.sendMessage(chatId, message, { buttons });
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

  /** Create a Taiga item from the event (mirror/escalate to a Taiga project). */
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
    const { outputs } = await createTaigaIssueFromContent(client, taigaProvider, mapped);
    log.debug(`-> ${step.to}: created item ${outputs.issueId}`);
    return outputs;
  }

  private async executeBitrixStep(
    step: Rule,
    source: Record<string, unknown>,
  ): Promise<Record<string, unknown> | null> {
    const provider = this.registry.getBitrix(step.to);
    const client = this.bitrixClients.get(step.to);
    if (!provider || !client) {
      log.warn(`-> ${step.to}: bitrix provider or API client not configured`);
      return null;
    }
    const outputs = await updateBitrixStatusFromTaiga(
      client,
      provider,
      source,
      step.on.content as BitrixContent,
    );
    log.debug(`-> ${step.to}: updated Bitrix appeal ${outputs.bitrixId}`);
    return outputs;
  }
}
