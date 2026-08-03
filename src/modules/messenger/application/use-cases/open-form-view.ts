import type { ProviderRegistry } from "../../../../core/provider-registry";
import type { IMessengerClient } from "../ports/messenger-client.port";
import type { IMessageStore } from "../ports/message-store.port";
import {
  parseFormOpenData,
  formCallbackId,
  toViewPayload,
  FORM_PRIVATE_METADATA_MAX,
  type FormPrivateMetadata,
} from "../../domain/entities/form";
import { log } from "../../../../core/logger";

export interface OpenFormViewInput {
  /** Callback data of the clicked button: "form:<alias>:open". */
  data: string;
  /** trigger_id from the button-click webhook; lives ~3 seconds. */
  triggerId?: string;
  messageId?: number;
  chatId?: number;
}

/**
 * Opens a declaratively configured Pachka modal view in response to a form-open button click.
 * The originating message's correlation (if known) travels in private_metadata so the
 * submission pipeline can reference the source entity via {{meta.*}}.
 */
export class OpenFormViewUseCase {
  constructor(
    private registry: ProviderRegistry,
    private messengerClient: IMessengerClient,
    private messageStore: IMessageStore | null,
  ) {}

  static matches(data: unknown): data is string {
    return typeof data === "string" && parseFormOpenData(data) !== null;
  }

  async execute(input: OpenFormViewInput): Promise<{ ok: boolean; error?: string }> {
    const parsed = parseFormOpenData(input.data);
    if (!parsed) return { ok: false, error: `Invalid form open data: "${input.data}"` };
    const { alias } = parsed;

    const provider = this.registry.getForm(`form:${alias}`);
    if (!provider) {
      log.warn("Form open: provider not found", { form: alias });
      return { ok: false, error: `Form provider "form:${alias}" not found` };
    }

    if (!input.triggerId) {
      log.warn("Form open: missing trigger_id in callback payload", { form: alias });
      return { ok: false, error: "Missing trigger_id (required to open a view)" };
    }

    const meta: FormPrivateMetadata = { formRef: formCallbackId(alias) };
    if (input.messageId != null) {
      meta.messageId = input.messageId;
      const ctx = this.messageStore?.getByPachkaMessageId(input.messageId);
      if (ctx) {
        meta.correlationId = ctx.correlationId;
        meta.target = ctx.target;
      }
    }
    if (input.chatId != null) meta.chatId = input.chatId;

    let privateMetadata: string | undefined = JSON.stringify(meta);
    if (privateMetadata.length > FORM_PRIVATE_METADATA_MAX) {
      log.warn("Form open: private_metadata exceeds limit, dropping", { form: alias });
      privateMetadata = undefined;
    }

    const started = performance.now();
    try {
      await this.messengerClient.openView(input.triggerId, toViewPayload(provider), {
        callbackId: formCallbackId(alias),
        privateMetadata,
      });
      log.info("Form view opened", { form: alias, latencyMs: Math.round(performance.now() - started) });
      return { ok: true };
    } catch (e) {
      // Most likely trigger_expired: the 3s window closed before /views/open landed.
      log.error("Failed to open form view", {
        form: alias,
        latencyMs: Math.round(performance.now() - started),
        error: String(e),
      });
      return { ok: false, error: String(e) };
    }
  }
}
