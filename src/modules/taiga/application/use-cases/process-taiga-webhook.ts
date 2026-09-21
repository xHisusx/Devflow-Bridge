import type { ProviderRegistry } from "../../../../core/provider-registry";
import type { Config, TaigaProvider, PachkaProvider, BitrixContent } from "../../../../core/config";
import type { IMessengerClient } from "../../../messenger/application/ports/messenger-client.port";
import type { IMessageStore } from "../../../messenger/application/ports/message-store.port";
import { buildFeedbackButtons, statusLabel, buildItemUrl } from "../../domain/services/feedback-buttons";
import { findNotifyTemplate } from "../services/feedback-message";
import { renderMessage } from "../../../plane/domain/services/template-renderer";
import { log } from "../../../../core/logger";
import type { IBitrixClient } from "../../../bitrix/application/ports/bitrix-api.port";
import { BitrixMappingError, updateBitrixStatusFromTaiga } from "../../../bitrix/application/services/update-bitrix-status";
import { parseRef, type Rule } from "../../../messenger/domain/entities/notification";
import { filterOutputs } from "../../../../core/pipeline";

/** Relevant subset of Taiga's webhook payload (nested objects come pre-serialized). */
export interface TaigaWebhookPayload {
  action: string; // "create" | "change" | "delete" | "test"
  type: string; // "issue" | "userstory" | "task" | ...
  data?: {
    id?: number;
    ref?: number;
    subject?: string;
    project?: { permalink?: string; name?: string };
    status?: { name?: string };
    assigned_to?: { full_name_display?: string; full_name?: string } | null;
    type?: { name?: string } | null;
    description?: string;
  };
  change?: { diff?: Record<string, unknown> };
}

export interface TaigaWebhookResult {
  ok: boolean;
  updated: number;
  bitrixUpdated?: number;
}

/**
 * Taiga -> Pachka sync: when an item's status or assignee changes in Taiga (manually or via our
 * feedback buttons), re-render the tracked Pachka message (template of the pipeline rule) and
 * swap its buttons to the set configured for the current status.
 */
export class ProcessTaigaWebhookUseCase {
  constructor(
    private registry: ProviderRegistry,
    private messengerClient: IMessengerClient | null,
    private messageStore: IMessageStore | null,
    private config: Config | null = null,
    private bitrixClients: Map<string, IBitrixClient> = new Map(),
  ) {}

  async execute(payload: TaigaWebhookPayload): Promise<TaigaWebhookResult> {
    if (payload.action === "test") {
      log.info("Taiga webhook test received");
      return { ok: true, updated: 0, bitrixUpdated: 0 };
    }

    const diff = payload.change?.diff ?? {};
    // Taiga emits a dedicated `close` action for closing an item; unlike `change`,
    // it may not include change.diff, so treat it as a status change itself.
    const isCloseAction = payload.action === "close";
    const relevantChange = isCloseAction || "status" in diff || "assigned_to" in diff;
    const itemId = payload.data?.id;
    const statusName = payload.data?.status?.name;
    if (!(payload.action === "change" || isCloseAction) || !relevantChange || !itemId || !statusName) {
      return { ok: true, updated: 0, bitrixUpdated: 0 };
    }

    const slug = extractProjectSlug(payload.data?.project?.permalink);
    const bitrixUpdated = (isCloseAction || "status" in diff)
      ? await this.processBitrixRules(payload, slug)
      : 0;
    if (!this.messengerClient || !this.messageStore) {
      return { ok: true, updated: 0, bitrixUpdated };
    }
    let updated = 0;

    for (const provider of this.registry.getByType("taiga") as TaigaProvider[]) {
      if (!provider.feedback || (slug && provider.project !== slug)) continue;

      const buttonsMap = provider.feedback.buttons ?? {};
      const key = Object.keys(buttonsMap).find((k) => k.toLowerCase() === statusName.toLowerCase());
      const buttons = buildFeedbackButtons(provider.alias, itemId, key ? buttonsMap[key] : []);
      const vars = this.buildVars(provider, payload, itemId, statusName);

      for (const pachka of this.registry.getByType("pachka") as PachkaProvider[]) {
        const messageId = this.messageStore.get(String(itemId), pachka.alias);
        if (!messageId) continue;
        try {
          const template = this.config
            ? findNotifyTemplate(this.config, `taiga:${provider.alias}`, pachka.alias)
            : null;
          const content = template
            ? renderMessage(template, vars)
            : (await this.messengerClient.getMessage(messageId)).content;
          await this.messengerClient.editMessage(messageId, content, { buttons });
          updated++;
          log.info("Taiga webhook: message synced", {
            itemId, status: statusName, messageId, target: pachka.alias,
          });
        } catch (e) {
          log.error("Taiga webhook: failed to sync message", {
            itemId, messageId, error: String(e),
          });
        }
      }
    }

    return { ok: true, updated, bitrixUpdated };
  }

  /** Execute standalone Taiga webhook pipelines such as taiga -> bitrix. */
  private async processBitrixRules(payload: TaigaWebhookPayload, slug: string | null): Promise<number> {
    if (!this.config || this.bitrixClients.size === 0) return 0;

    const itemId = payload.data?.id;
    const statusName = payload.data?.status?.name;
    if (!itemId || !statusName) return 0;

    const action = payload.action === "close" ? "close" : "update";
    let updated = 0;

    for (const pipeline of this.config.rules) {
      const trigger = pipeline[0];
      if (!trigger || parseRef(trigger.from).type !== "taiga") continue;
      const taigaProvider = this.registry.getTaiga(trigger.from);
      if (!taigaProvider || (slug && taigaProvider.project !== slug)) continue;
      if (!matchesTaigaCondition(trigger, action, statusName)) continue;

      const source = this.buildVars(taigaProvider, payload, itemId, statusName);
      const context = new Map<string, Record<string, unknown>>([[trigger.from, source]]);
      for (const step of pipeline) {
        const stepSource = context.get(step.from);
        if (!stepSource) break;
        if (parseRef(step.to).type !== "bitrix") continue;

        const provider = this.registry.getBitrix(step.to);
        const client = this.bitrixClients.get(step.to);
        if (!provider || !client) {
          log.warn("Taiga -> Bitrix: provider or client is not configured", { target: step.to });
          continue;
        }

        try {
          const outputs = await updateBitrixStatusFromTaiga(
            client,
            provider,
            stepSource,
            step.on.content as BitrixContent,
          );
          context.set(step.to, filterOutputs(outputs, step.on.outputs));
          updated++;
          log.info("Taiga webhook -> Bitrix completed", {
            itemId,
            bitrixId: outputs.bitrixId,
            status: outputs.status,
            target: step.to,
          });
        } catch (error) {
          if (error instanceof BitrixMappingError) {
            log.warn("Taiga webhook -> Bitrix skipped: BitrixID is absent from description", {
              itemId,
              target: step.to,
              error: error.message,
            });
          } else {
            log.error("Taiga webhook -> Bitrix failed", { itemId, target: step.to, error: String(error) });
          }
        }
      }
    }
    return updated;
  }

  /** Template vars from the webhook payload itself (no API calls needed). */
  private buildVars(
    provider: TaigaProvider,
    payload: TaigaWebhookPayload,
    itemId: number,
    statusName: string,
  ): Record<string, unknown> {
    const data = payload.data ?? {};
    const ref = data.ref ?? 0;
    return {
      issueId: String(itemId),
      issueUrl: buildItemUrl(provider, provider.project, ref),
      seq: ref,
      identifier: `#${ref}`,
      name: data.subject ?? "",
      title: data.subject ?? "",
      project: data.project?.name ?? provider.project,
      status: statusLabel(provider.feedback?.statusLabels, statusName),
      assignee: data.assigned_to?.full_name_display ?? data.assigned_to?.full_name ?? "—",
      type: data.type?.name ?? "—",
      description: data.description ?? "",
    };
  }
}

function matchesTaigaCondition(rule: Rule, action: string, status: string): boolean {
  if (rule.on.action && rule.on.action !== action) return false;
  if (!rule.on.status) return true;
  const values = Array.isArray(rule.on.status) ? rule.on.status : [rule.on.status];
  return values.some((value) => value.toLowerCase() === status.toLowerCase());
}

/** "https://taiga.example.com/project/my-slug" -> "my-slug". */
function extractProjectSlug(permalink?: string): string | null {
  if (!permalink) return null;
  const parts = permalink.replace(/\/$/, "").split("/");
  return parts[parts.length - 1] || null;
}
