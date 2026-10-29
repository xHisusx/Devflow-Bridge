import type { ProviderRegistry } from "../../../../core/provider-registry";
import type { Config, TaigaProvider, PachkaProvider } from "../../../../core/config";
import type { IMessengerClient } from "../../../messenger/application/ports/messenger-client.port";
import type { IMessageStore } from "../../../messenger/application/ports/message-store.port";
import type { IPipelineStateStore } from "../../../../core/persistence/pipeline-state.port";
import {
  buildFeedbackButtons,
  buttonsForStatus,
  keepLinkButtons,
  statusLabel,
  buildItemUrl,
} from "../../domain/services/feedback-buttons";
import { extractProjectSlug, normalizeTaigaEntity } from "../../domain/services/taiga-trigger";
import { findNotifyContent, withCardVars } from "../services/feedback-message";
import { renderMessage } from "../../../plane/domain/services/template-renderer";
import type { TaigaWebhookPayload } from "../../domain/entities/taiga-webhook-payload";
import { log } from "../../../../core/logger";

export type { TaigaWebhookPayload };

export interface TaigaWebhookResult {
  ok: boolean;
  updated: number;
}

/**
 * Taiga -> Pachka sync: when an item's status or assignee changes in Taiga (manually or via our
 * feedback buttons), re-render the tracked Pachka message (template of the pipeline rule) and
 * swap its buttons to the set configured for the current status.
 *
 * Pipelines started by a Taiga event (`from: "taiga:<alias>"`) are a separate concern and belong
 * to ProcessTaigaTriggerUseCase; the webhook route runs both on the same payload.
 */
export class ProcessTaigaWebhookUseCase {
  constructor(
    private registry: ProviderRegistry,
    private messengerClient: IMessengerClient | null,
    private messageStore: IMessageStore | null,
    private config: Config | null = null,
    private pipelineState: IPipelineStateStore | null = null,
  ) {}

  async execute(payload: TaigaWebhookPayload): Promise<TaigaWebhookResult> {
    if (payload.action === "test") {
      log.info("Taiga webhook test received");
      return { ok: true, updated: 0 };
    }

    const diff = payload.change?.diff ?? {};
    // Taiga emits a dedicated `close` action for closing an item; unlike `change`,
    // it may not include change.diff, so treat it as a status change itself.
    const isCloseAction = payload.action === "close";
    const relevantChange = isCloseAction || "status" in diff || "assigned_to" in diff;
    const itemId = payload.data?.id;
    const statusName = payload.data?.status?.name;
    if (!(payload.action === "change" || isCloseAction) || !relevantChange || !itemId || !statusName) {
      return { ok: true, updated: 0 };
    }
    if (!this.messengerClient || !this.messageStore) {
      return { ok: true, updated: 0 };
    }

    const slug = extractProjectSlug(payload.data?.project?.permalink);
    const entity = normalizeTaigaEntity(payload.type);
    let updated = 0;

    for (const provider of this.registry.getByType("taiga") as TaigaProvider[]) {
      if (!provider.feedback || (slug && provider.project !== slug)) continue;
      // One project can be served by two providers — its tasks and its user stories — and a card
      // is the business of the one whose entity the event is about. Without this the other would
      // rewrite it with the buttons of a different kind of item.
      if ((provider.entity ?? "issue") !== entity) continue;

      const vars = withCardVars(
        this.buildVars(provider, payload, itemId, statusName),
        this.pipelineState,
        `taiga:${provider.alias}`,
      );

      for (const pachka of this.registry.getByType("pachka") as PachkaProvider[]) {
        const messageId = this.messageStore.get(String(itemId), pachka.alias);
        if (!messageId) continue;
        try {
          const notify = this.config
            ? findNotifyContent(this.config, `taiga:${provider.alias}`, pachka.alias)
            : null;
          // Read either way: the message's link buttons survive the transition (see keepLinkButtons).
          const current = await this.messengerClient.getMessage(messageId);
          const content = notify?.message ? renderMessage(notify.message, vars) : current.content;
          // What can be done from a card is the business of the step that sent it (a tester
          // returns or finishes the task; the developer waits) — hence the per-step set first.
          const buttons = [
            ...keepLinkButtons(current.buttons),
            ...buildFeedbackButtons(
              provider.alias,
              itemId,
              buttonsForStatus(notify?.buttonsByStatus ?? provider.feedback.buttons, statusName),
            ),
          ];
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

    return { ok: true, updated };
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
      description: data.description ?? "",
      seq: ref,
      identifier: `#${ref}`,
      name: data.subject ?? "",
      title: data.subject ?? "",
      project: data.project?.name ?? provider.project,
      status: statusLabel(provider.feedback?.statusLabels, statusName),
      assignee: data.assigned_to?.full_name_display ?? data.assigned_to?.full_name ?? "—",
      type: data.type?.name ?? "—",
    };
  }
}
