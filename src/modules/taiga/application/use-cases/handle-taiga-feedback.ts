import type { ProviderRegistry } from "../../../../core/provider-registry";
import type { Config, TaigaEntity, TaigaProvider } from "../../../../core/config";
import type { ITaigaApiClient, TaigaProjectInfo } from "../ports/taiga-api.port";
import type { IMessengerClient } from "../../../messenger/application/ports/messenger-client.port";
import type { IMessageStore } from "../../../messenger/application/ports/message-store.port";
import type { IPipelineStateStore } from "../../../../core/persistence/pipeline-state.port";
import {
  buildFeedbackButtons,
  buttonsForStatus,
  keepLinkButtons,
  TAIGA_CALLBACK_PREFIX,
} from "../../domain/services/feedback-buttons";
import { findNotifyContent, buildItemVars, withCardVars } from "../services/feedback-message";
import { renderMessage } from "../../../plane/domain/services/template-renderer";
import {
  DEFAULT_WORK_EMAIL_FIELD,
  workEmailOf,
} from "../../../messenger/application/services/pachka-user-directory";
import { log } from "../../../../core/logger";

export { TAIGA_CALLBACK_PREFIX };

/** Actions that also assign the clicking user to the item. */
const ASSIGNING_ACTIONS = new Set(["accept", "resume"]);

export interface TaigaFeedbackInput {
  /** Button callback data: "taiga:<alias>:<action>:<itemId>". */
  data: string;
  /** Pachka user who clicked the button. */
  pachkaUserId?: number;
  /** Pachka message the button belongs to (its buttons are refreshed after the transition). */
  messageId?: number;
}

export interface TaigaFeedbackResult {
  ok: boolean;
  status?: string;
  error?: string;
}

/**
 * Pachka -> Taiga feedback: a callback button click moves the Taiga item to the status mapped in
 * the provider's `feedback.statuses`, optionally assigns the clicker (matched by work email from
 * the Pachka custom profile field), then swaps the message buttons per `feedback.buttons`.
 */
export class HandleTaigaFeedbackUseCase {
  constructor(
    private registry: ProviderRegistry,
    private taigaClients: Map<string, ITaigaApiClient>,
    private messengerClient: IMessengerClient | null,
    private config: Config | null = null,
    private messageStore: IMessageStore | null = null,
    private pipelineState: IPipelineStateStore | null = null,
  ) {}

  static matches(data: string | undefined): data is string {
    return typeof data === "string" && data.startsWith(TAIGA_CALLBACK_PREFIX);
  }

  async execute(input: TaigaFeedbackInput): Promise<TaigaFeedbackResult> {
    const [, alias, action, itemIdRaw] = input.data.split(":");
    const itemId = Number(itemIdRaw);
    const ref = `taiga:${alias}`;

    const provider = this.registry.getTaiga(ref);
    const client = this.taigaClients.get(ref);
    if (!provider || !client) {
      log.warn(`Taiga feedback: provider or client "${ref}" not configured`, { data: input.data });
      return { ok: false, error: `provider "${ref}" not configured` };
    }
    const feedback = provider.feedback;
    if (!feedback) {
      log.warn(`Taiga feedback: provider "${ref}" has no feedback config`);
      return { ok: false, error: "feedback not configured" };
    }
    const statusName = feedback.statuses[action];
    if (!statusName || !Number.isFinite(itemId)) {
      log.warn(`Taiga feedback: unknown action or bad item id`, { data: input.data });
      return { ok: false, error: `unknown action "${action}"` };
    }

    const entity: TaigaEntity = provider.entity ?? "issue";
    const project = await client.getProjectBySlug(provider.project);

    const statuses = await client.getItemStatuses(entity, project.id);
    const status = statuses.find((s) => s.name.toLowerCase() === statusName.toLowerCase());
    if (!status) {
      log.warn(`Taiga feedback: status "${statusName}" not found in project`, {
        available: statuses.map((s) => s.name),
      });
      return { ok: false, error: `status "${statusName}" not found` };
    }

    const assignedTo = ASSIGNING_ACTIONS.has(action)
      ? await this.resolveAssignee(client, project.id, feedback.workEmailField ?? DEFAULT_WORK_EMAIL_FIELD, input.pachkaUserId)
      : null;

    const item = await client.getItem(entity, itemId);
    await client.updateItem(
      entity,
      itemId,
      { status: status.id, ...(assignedTo ? { assigned_to: assignedTo } : {}) },
      item.version,
    );
    log.info("Taiga feedback applied", { entity, itemId, action, status: statusName, assignedTo });

    await this.refreshMessage(input, provider, client, project, itemId, statusName);

    return { ok: true, status: statusName };
  }

  /** Pachka user -> work email (custom field, fallback to profile email) -> Taiga member id. */
  private async resolveAssignee(
    client: ITaigaApiClient,
    projectId: number,
    workEmailField: string,
    pachkaUserId?: number,
  ): Promise<number | null> {
    if (!pachkaUserId || !this.messengerClient) return null;
    try {
      const user = await this.messengerClient.getUser(pachkaUserId);
      const email = workEmailOf(user, workEmailField);
      if (!email) {
        log.warn(`Taiga feedback: no work email for Pachka user`, { pachkaUserId, workEmailField });
        return null;
      }
      const memberId = await client.getMemberIdByEmail(projectId, email);
      if (!memberId) log.warn(`Taiga feedback: no Taiga member with email "${email}"`);
      return memberId;
    } catch (e) {
      log.error("Taiga feedback: failed to resolve assignee", { pachkaUserId, error: String(e) });
      return null;
    }
  }

  /**
   * Re-render the clicked message after the transition: content from the pipeline rule's message
   * template (with fresh status/assignee), buttons per the set that rule declares for the new
   * status — or, with none declared, the provider-wide one. Falls back to keeping the old content
   * when no template is found.
   */
  private async refreshMessage(
    input: TaigaFeedbackInput,
    provider: TaigaProvider,
    client: ITaigaApiClient,
    project: TaigaProjectInfo,
    itemId: number,
    statusName: string,
  ): Promise<void> {
    if (!input.messageId || !this.messengerClient) return;
    try {
      // The message is read either way: its link buttons outlive the transition, and without a
      // template its text is kept as it is.
      const current = await this.messengerClient.getMessage(input.messageId);

      const target = this.messageStore?.getByPachkaMessageId(input.messageId)?.target;
      const notify = this.config && target
        ? findNotifyContent(this.config, `taiga:${provider.alias}`, target)
        : null;
      const buttons = [
        ...keepLinkButtons(current.buttons),
        ...buildFeedbackButtons(
          provider.alias,
          itemId,
          buttonsForStatus(notify?.buttonsByStatus ?? provider.feedback?.buttons, statusName),
        ),
      ];

      let content: string | null = null;
      if (notify?.message) {
        const vars = withCardVars(
          await buildItemVars(client, provider, project, itemId),
          this.pipelineState,
          `taiga:${provider.alias}`,
        );
        content = renderMessage(notify.message, vars);
      } else {
        content = current.content;
      }

      await this.messengerClient.editMessage(input.messageId, content, { buttons });
    } catch (e) {
      log.error("Taiga feedback: failed to refresh message", {
        messageId: input.messageId,
        error: String(e),
      });
    }
  }
}
