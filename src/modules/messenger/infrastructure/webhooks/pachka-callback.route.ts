import { Elysia } from "elysia";
import type { IMessageStore } from "../../application/ports/message-store.port";
import type { IMessengerClient } from "../../application/ports/messenger-client.port";
import { HandleTaigaFeedbackUseCase } from "../../../taiga/application/use-cases/handle-taiga-feedback";
import { OpenFormViewUseCase } from "../../application/use-cases/open-form-view";
import { ProcessFormSubmissionUseCase } from "../../application/use-cases/process-form-submission";
import { log } from "../../../../core/logger";

export interface PachkaCallbackRouteDeps {
  messengerClient: IMessengerClient | null;
  messageStore: IMessageStore | null;
  taigaFeedback?: HandleTaigaFeedbackUseCase | null;
  openFormView?: OpenFormViewUseCase | null;
  formSubmission?: ProcessFormSubmissionUseCase | null;
}

/** Outgoing Pachka webhook: button clicks (type: "button") and form submissions (type: "view"). */
interface PachkaCallbackPayload {
  type?: "button" | "view" | string;
  event?: string;
  message_id?: number;
  user_id?: number;
  chat_id?: number;
  /** Button clicks carry a string; view submissions carry the fields object. */
  data?: string | Record<string, unknown>;
  trigger_id?: string;
  callback_id?: string;
  private_metadata?: string;
  /** Unix seconds of the event on Pachka's side — used to measure webhook delivery latency. */
  webhook_timestamp?: number;
}

export function pachkaCallbackRoute(deps: PachkaCallbackRouteDeps) {
  const { messengerClient, messageStore, taigaFeedback, openFormView, formSubmission } = deps;

  return new Elysia()
    .post("/webhook/pachka", async ({ request }) => {
      if (!messengerClient || !messageStore) {
        return { ok: false, error: "Pachka API not configured" };
      }

      const payload = (await request.json()) as PachkaCallbackPayload;

      log.debug("Pachka callback", { payload });

      // Form submission: ack immediately (Pachka closes the modal on 200 within 3s),
      // run the pipeline in the background.
      if (
        payload.type === "view" &&
        payload.event === "submit" &&
        formSubmission &&
        ProcessFormSubmissionUseCase.matches(payload.callback_id)
      ) {
        const fields =
          typeof payload.data === "object" && payload.data !== null ? payload.data : {};
        formSubmission
          .execute({
            callbackId: payload.callback_id,
            data: fields,
            userId: payload.user_id,
            chatId: payload.chat_id,
            privateMetadata: payload.private_metadata,
          })
          .catch((e) =>
            log.error("Form submission pipeline failed", {
              callbackId: payload.callback_id,
              error: String(e),
            }),
          );
        return new Response(null, { status: 200 });
      }

      // Form-open button: must call /views/open before the 3s trigger_id expires — awaited.
      if (openFormView && OpenFormViewUseCase.matches(payload.data)) {
        const result = await openFormView.execute({
          data: payload.data,
          triggerId: payload.trigger_id,
          messageId: payload.message_id,
          chatId: payload.chat_id,
          eventAgeMs: payload.webhook_timestamp
            ? Date.now() - payload.webhook_timestamp * 1000
            : undefined,
        });
        return { ok: result.ok, ...(result.error ? { error: result.error } : {}) };
      }

      const buttonData = typeof payload.data === "string" ? payload.data : undefined;

      if (taigaFeedback && HandleTaigaFeedbackUseCase.matches(buttonData)) {
        try {
          const result = await taigaFeedback.execute({
            data: buttonData,
            pachkaUserId: payload.user_id,
            messageId: payload.message_id,
          });
          return { ok: result.ok, ...(result.error ? { error: result.error } : {}) };
        } catch (e) {
          log.error("Taiga feedback failed", { data: buttonData, error: String(e) });
          return { ok: false, error: String(e) };
        }
      }

      if (payload.message_id) {
        const ctx = messageStore.getByPachkaMessageId(payload.message_id);
        if (ctx) {
          log.debug(`Button click on ${ctx.correlationId}`, { target: ctx.target, data: buttonData });
        }
      }

      return { ok: true };
    });
}
