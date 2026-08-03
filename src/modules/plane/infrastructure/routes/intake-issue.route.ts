import { Elysia } from "elysia";
import { createHash, timingSafeEqual } from "node:crypto";
import { ProcessIntakePipelineUseCase, IntakePipelineError } from "../../application/use-cases/process-intake-pipeline";
import { PlaneWriteError } from "../../application/services/create-plane-issue";
import { TaigaWriteError } from "../../../taiga/application/services/create-taiga-issue";
import { validateIntakeBody } from "../../domain/services/intake-validator";
import type { ApiFieldSpec } from "../../../../core/config";
import { log } from "../../../../core/logger";

export interface IntakeIssueRouteDeps {
  intakePipeline: ProcessIntakePipelineUseCase;
  /** HTTP path to mount, taken from the api provider's `endpoint`. */
  endpoint: string;
  /** Provider ref ("api:<alias>") selecting which pipeline this endpoint triggers. */
  triggerRef: string;
  /** API key required in `Authorization: Bearer` or `X-API-Key`. Undefined = no auth (provider opted out). */
  apiKey?: string;
  /** Declarative body validation from the api provider (`fields`). Undefined = no validation. */
  fields?: Record<string, ApiFieldSpec>;
}

function isAuthorized(request: Request, apiKey: string): boolean {
  const bearer = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  const candidate = bearer ?? request.headers.get("x-api-key");
  if (!candidate) return false;
  // Hashing both sides gives equal-length buffers, so comparison stays constant-time.
  const a = createHash("sha256").update(candidate).digest();
  const b = createHash("sha256").update(apiKey).digest();
  return timingSafeEqual(a, b);
}

function parseFormBody(formData: FormData): { body: Record<string, unknown>; files: File[] } {
  const body: Record<string, unknown> = {};
  const files: File[] = [];

  for (const [key, value] of formData.entries()) {
    if (value instanceof File) {
      files.push(value);
      continue;
    }
    const str = value.toString();
    // Try to parse JSON-stringified values (e.g. labels: '["Bug","Urgent"]')
    if (key === "labels" || str.startsWith("[") || str.startsWith("{")) {
      try {
        const parsed = JSON.parse(str);
        body[key] = parsed;
        continue;
      } catch {
        // not JSON, treat as string
      }
    }
    // Accumulate multiple values with same key as array
    if (key in body) {
      const existing = body[key];
      body[key] = Array.isArray(existing) ? [...existing, str] : [existing, str];
    } else {
      body[key] = str;
    }
  }

  return { body, files };
}

export function intakeIssueRoute(deps: IntakeIssueRouteDeps) {
  const { intakePipeline, endpoint, triggerRef, apiKey, fields } = deps;

  return new Elysia().post(endpoint, async ({ request }) => {
    if (apiKey !== undefined && !isAuthorized(request, apiKey)) {
      log.warn("Intake request rejected: invalid or missing API key", { endpoint });
      return new Response(
        JSON.stringify({ ok: false, error: "Unauthorized" }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      );
    }

    const contentType = request.headers.get("content-type") ?? "";
    let body: Record<string, unknown>;
    let files: File[] = [];

    if (contentType.includes("multipart/form-data")) {
      const formData = await request.formData();
      const parsed = parseFormBody(formData);
      body = parsed.body;
      files = parsed.files;
    } else {
      body = (await request.json()) as Record<string, unknown>;
    }

    log.debug("Intake issue request", { body, files: files.length });

    if (fields) {
      const errors = validateIntakeBody(fields, body);
      if (errors.length > 0) {
        log.warn("Intake request rejected: body validation failed", { endpoint, errors });
        return new Response(
          JSON.stringify({ ok: false, error: errors.join("; ") }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        );
      }
    }

    try {
      const result = await intakePipeline.execute(
        {
          body,
          files: files.length > 0 ? files : undefined,
        },
        triggerRef,
      );

      if (!result.ok) {
        return new Response(
          JSON.stringify({ ok: false, error: "No matching intake rules configured" }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        );
      }

      return new Response(
        JSON.stringify({
          ok: true,
          id: result.id,
          issue_id: result.issue_id,
          attachments: result.attachments,
        }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      );
    } catch (e) {
      if (e instanceof IntakePipelineError || e instanceof PlaneWriteError || e instanceof TaigaWriteError) {
        return new Response(
          JSON.stringify({ ok: false, error: e.message }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        );
      }
      throw e;
    }
  });
}
