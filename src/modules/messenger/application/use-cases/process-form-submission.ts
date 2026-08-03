import type { Config } from "../../../../core/config";
import type { Rule } from "../../domain/entities/notification";
import type { IMessengerClient } from "../ports/messenger-client.port";
import { FORM_CALLBACK_PREFIX } from "../../domain/entities/form";
import { formatReceivedAt } from "../../../plane/application/use-cases/process-intake-pipeline";
import { log } from "../../../../core/logger";

/** Structural dependency on the pipeline engine (implemented by ProcessIntakePipelineUseCase). */
export interface FormPipelineRunner {
  run(pipeline: Rule[], triggerOutputs: Record<string, unknown>, files?: File[]): Promise<unknown>;
}

export interface FormSubmissionInput {
  /** callback_id echoed by Pachka: "form:<alias>". */
  callbackId: string;
  /** Submitted fields keyed by block name. */
  data?: Record<string, unknown>;
  userId?: number;
  chatId?: number;
  privateMetadata?: string;
}

/**
 * Runs the pipeline whose first step is `from: "form:<alias>"` with the submitted form data
 * as trigger outputs. Success = the pipeline completed without throwing (form pipelines may
 * have no plane/taiga step, so the intake result's `ok` flag is not authoritative here).
 */
export class ProcessFormSubmissionUseCase {
  constructor(
    private config: Config,
    private pipelineRunner: FormPipelineRunner,
    private messengerClient: IMessengerClient | null,
  ) {}

  static matches(callbackId: unknown): callbackId is string {
    return typeof callbackId === "string" && callbackId.startsWith(FORM_CALLBACK_PREFIX);
  }

  async execute(input: FormSubmissionInput): Promise<{ ok: boolean; error?: string }> {
    const pipeline = this.config.rules.find((p) => p.length > 0 && p[0].from === input.callbackId);
    if (!pipeline) {
      log.warn("Form submission: no pipeline configured", { callbackId: input.callbackId });
      return { ok: false, error: `No pipeline with "from: ${input.callbackId}"` };
    }

    const data = normalizeFormData(input.data ?? {});

    let user: unknown = null;
    if (input.userId != null && this.messengerClient) {
      try {
        user = await this.messengerClient.getUser(input.userId);
      } catch (e) {
        log.debug("Form submission: getUser failed", { userId: input.userId, error: String(e) });
      }
    }

    const trigger: Record<string, unknown> = {
      data,
      user,
      userId: input.userId ?? null,
      chatId: input.chatId ?? null,
      receivedAt: formatReceivedAt(new Date()),
      meta: safeParseJson(input.privateMetadata),
    };

    log.info("Form submission received", {
      form: input.callbackId,
      fields: Object.keys(data).length,
      userId: input.userId,
    });

    await this.pipelineRunner.run(pipeline, trigger);
    return { ok: true };
  }
}

/**
 * file_input values arrive as arrays of { name, size, url } objects, which stringify uselessly
 * in templates. Normalize them to a "[name](url), ..." markdown string (URLs live ~1 hour).
 * All other values pass through untouched.
 */
function normalizeFormData(data: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    result[key] = isFileArray(value)
      ? value.map((f) => `[${f.name ?? f.url}](${f.url})`).join(", ")
      : value;
  }
  return result;
}

function isFileArray(value: unknown): value is { name?: string; url: string }[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (v) => typeof v === "object" && v !== null && typeof (v as { url?: unknown }).url === "string",
    )
  );
}

function safeParseJson(value: string | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}
