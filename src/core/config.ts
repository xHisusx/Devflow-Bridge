import { dirname, join } from "node:path";
import { type Rule, parseRef, isNotifyContent } from "../modules/messenger/domain/entities/notification";
import { FORM_INTERACTIVE_TYPES, type FormBlock } from "../modules/messenger/domain/entities/form";
import { getProviderOutputs } from "./provider-schema";

// ── Provider types ──

export interface PlaneProvider {
  type: "plane";
  alias: string;
  baseUrl: string;
  workspace: string;
  project: string;
}

export interface PachkaProvider {
  type: "pachka";
  alias: string;
  chatId: number;
}

export interface WebhookProvider {
  type: "webhook";
  alias: string;
  url: string;
}

/** Declarative validation for one intake body field. */
export interface ApiFieldSpec {
  /** Reject the request (400) when the field is missing or blank. */
  required?: boolean;
  /** Like `required`, but only when another body field equals `value` (compared as strings). */
  requiredIf?: { field: string; value: string };
  /** Allowed values; any other value is rejected (400) with the list in the error. */
  values?: string[];
}

export interface ApiProvider {
  type: "api";
  alias: string;
  endpoint: string;
  /**
   * Set to false to expose the endpoint without an API key (public intake).
   * Default: true — startup fails unless INTAKE_API_KEY_<ALIAS> or INTAKE_API_KEY is set.
   */
  auth?: boolean;
  /** Body validation: field name -> spec. Checked before the pipeline runs. */
  fields?: Record<string, ApiFieldSpec>;
}

export type TaigaEntity = "issue" | "user_story" | "task";

export interface TaigaFeedbackButton {
  text: string;
  /** Feedback action key, must exist in `statuses` (e.g. "accept", "pause", "close", "resume"). */
  action: string;
}

/**
 * Pachka -> Taiga feedback loop: callback buttons on notification messages move the Taiga item
 * between statuses. "accept"/"resume" also assign the clicking user, matched by the work email
 * from a Pachka custom profile field.
 */
export interface TaigaFeedbackConfig {
  /** Action key -> Taiga status name (project-specific, matched case-insensitively). */
  statuses: Record<string, string>;
  /** Taiga status name -> buttons shown on the message after the transition (omit to clear). */
  buttons?: Record<string, TaigaFeedbackButton[]>;
  /** Taiga status name -> display label for messages (e.g. "In progress" -> "В процессе 🚀"). */
  statusLabels?: Record<string, string>;
  /** Name of the Pachka custom profile field holding the work email. Default: "Рабочая почта". */
  workEmailField?: string;
}

export interface TaigaProvider {
  type: "taiga";
  alias: string;
  /** Root URL of the Taiga instance (without /api/v1), e.g. "https://api.taiga.io". */
  baseUrl: string;
  /** Project slug. */
  project: string;
  /** Web UI root for building item links; defaults to baseUrl (self-hosted serves both). */
  webUrl?: string;
  /** Which Taiga entity `to: taiga:*` steps create. Default: "issue". */
  entity?: TaigaEntity;
  /** Taiga priority name -> display label for messages (e.g. "Critical" -> "Критическая"). */
  priorityLabels?: Record<string, string>;
  feedback?: TaigaFeedbackConfig;
}

/**
 * Declarative Pachka modal form (view). The definition (title/blocks) can live inline or in an
 * external JSON file referenced by `file` (path relative to the config directory). File contents:
 * `{ "title", "submit_text"?/"submitText"?, "close_text"?/"closeText"?, "blocks": [...] }`.
 * Inline provider fields take precedence over the file's. Resolved once at startup by loadConfig.
 */
export interface FormProvider {
  type: "form";
  alias: string;
  /** Path to a form definition JSON, relative to the config directory (e.g. "forms/support.json"). */
  file?: string;
  /** Modal title (≤24 chars). */
  title?: string;
  submitText?: string;
  closeText?: string;
  /** Pachka-native view blocks (snake_case, pass-through). */
  blocks?: FormBlock[];
}

export type Provider = PlaneProvider | PachkaProvider | WebhookProvider | ApiProvider | TaigaProvider | FormProvider;

// ── Config ──

export interface Config {
  providers: Provider[];
  rules: Rule[][];
}

/**
 * Load the config. Path resolution: explicit argument -> CONFIG_PATH env ->
 * config/default.json -> config.json (legacy root location).
 */
export async function loadConfig(path?: string): Promise<Config> {
  const candidates = path
    ? [path]
    : ([process.env.CONFIG_PATH, "config/default.json", "config.json"].filter(Boolean) as string[]);

  for (const candidate of candidates) {
    if (await Bun.file(candidate).exists()) {
      const config = (await Bun.file(candidate).json()) as Config;
      await resolveFormProviders(config, dirname(candidate));
      return config;
    }
  }
  throw new Error(`Config file not found, tried: ${candidates.join(", ")}`);
}

/**
 * Inline external form definition files into their `form` providers. A missing/broken file or a
 * form left without blocks is a startup error (same policy as missing API keys).
 */
export async function resolveFormProviders(config: Config, configDir: string): Promise<void> {
  for (const p of config.providers ?? []) {
    if (p.type !== "form") continue;

    if (p.file) {
      const filePath = join(configDir, p.file);
      const file = Bun.file(filePath);
      if (!(await file.exists())) {
        throw new Error(`Form provider "${p.alias}": file not found: ${filePath}`);
      }
      let def: Record<string, unknown>;
      try {
        def = await file.json();
      } catch (e) {
        throw new Error(`Form provider "${p.alias}": invalid JSON in ${filePath}: ${String(e)}`);
      }
      // Inline provider fields win over the file's; both camelCase and snake_case keys accepted.
      p.title ??= def.title as string | undefined;
      p.submitText ??= (def.submitText ?? def.submit_text) as string | undefined;
      p.closeText ??= (def.closeText ?? def.close_text) as string | undefined;
      p.blocks ??= def.blocks as FormBlock[] | undefined;
    }

    if (!p.blocks || p.blocks.length === 0) {
      throw new Error(`Form provider "${p.alias}": no "blocks" defined (inline or via "file")`);
    }
  }
}

// ── Validation ──

export function validateConfig(
  config: Config,
  registry: { get(ref: string): Provider | undefined },
  log: { warn: (msg: string) => void },
): void {
  // Validate unique aliases
  const seen = new Set<string>();
  for (const p of config.providers) {
    const ref = `${p.type}:${p.alias}`;
    if (seen.has(ref)) {
      log.warn(`Provider "${ref}": duplicate alias`);
    }
    seen.add(ref);
  }

  validateFormProviders(config, log);

  for (const pipeline of config.rules) {
    // Map: ref → fields exposed by that step (for subsequent steps)
    const exposedByRef = new Map<string, readonly string[]>();

    for (let i = 0; i < pipeline.length; i++) {
      const rule = pipeline[i];
      const label = `Rule [${rule.from} → ${rule.to}]`;

      if (!rule.on?.content) {
        log.warn(`${label}: "on.content" is required`);
      }

      // Validate provider references
      const fromProvider = registry.get(rule.from);
      if (!fromProvider) {
        log.warn(`${label}: provider "${rule.from}" not found`);
      }
      const toProvider = registry.get(rule.to);
      if (!toProvider) {
        log.warn(`${label}: provider "${rule.to}" not found`);
      }

      // Determine what `from` exposes to this step
      let availableFields: readonly string[] = [];
      if (i === 0) {
        if (fromProvider && fromProvider.type !== "api" && fromProvider.type !== "plane" && fromProvider.type !== "form") {
          log.warn(`${label}: first step must have "from" of type "api", "plane" or "form"`);
        }
        // For the first step, `from` is the initial trigger/source. Available fields = trigger schema.
        const { type } = parseRef(rule.from);
        availableFields = getProviderOutputs(type, "trigger");
      } else {
        // Subsequent steps: `from` must reference a previous step's `to`
        const upstreamExposed = exposedByRef.get(rule.from);
        if (!upstreamExposed) {
          log.warn(`${label}: "from: ${rule.from}" must reference a previous step's "to" in this pipeline`);
        } else {
          availableFields = upstreamExposed;
        }
      }

      // Validate that all template roots used in content exist in availableFields
      if (rule.on?.content && availableFields.length > 0) {
        const usedRoots = collectTemplateRoots(rule.on.content);
        for (const root of usedRoots) {
          if (!availableFields.includes(root)) {
            log.warn(
              `${label}: template "{{${root}...}}" references field not exposed by ${rule.from}. ` +
                `Available: [${availableFields.join(", ")}]`,
            );
          }
        }
      }

      // Validate `outputs` declaration against provider schema
      if (rule.on?.outputs && toProvider) {
        const providerSchema = getProviderOutputs(toProvider.type);
        for (const field of rule.on.outputs) {
          if (!providerSchema.includes(field)) {
            log.warn(
              `${label}: outputs field "${field}" not in ${toProvider.type} schema. ` +
                `Available: [${providerSchema.join(", ")}]`,
            );
          }
        }
      }

      // Record what this step exposes for subsequent steps
      if (toProvider) {
        const schema = getProviderOutputs(toProvider.type);
        exposedByRef.set(rule.to, rule.on?.outputs ?? schema);
      }

      // Forms are triggers only — a form cannot be a step target
      if (toProvider?.type === "form") {
        log.warn(`${label}: "to: ${rule.to}" is invalid — forms can only be a pipeline source`);
      }

      // Validate form references in buttons
      if (rule.on?.content && isNotifyContent(rule.on.content)) {
        const buttonsAction = rule.on.content.actions?.find((a) => a.type === "buttons");
        if (buttonsAction && "buttons" in buttonsAction) {
          for (const b of buttonsAction.buttons) {
            if (!b.form) continue;
            if (b.url || b.callbackData) {
              log.warn(`${label}: button "${b.text}": "form" excludes "url"/"callbackData"`);
            }
            if (!registry.get(`form:${b.form}`)) {
              log.warn(`${label}: button "${b.text}": form provider "form:${b.form}" not found`);
            }
          }
        }
      }

      // Validate target-specific content
      if (toProvider?.type === "plane" || toProvider?.type === "taiga") {
        const content = rule.on?.content;
        if (content && !("name" in content)) {
          log.warn(`${label}: ${toProvider.type} content must include "name" mapping`);
        }
      } else if (toProvider?.type === "pachka" || toProvider?.type === "webhook") {
        const content = rule.on?.content;
        if (content && !isNotifyContent(content)) {
          log.warn(`${label}: notify content must include "message"`);
        }
      }
    }
  }
}

const FORM_OPTION_TYPES = new Set(["select", "radio", "checkbox"]);

function validateFormProviders(config: Config, log: { warn: (msg: string) => void }): void {
  for (const p of config.providers) {
    if (p.type !== "form") continue;
    const label = `Form "${p.alias}"`;

    if (!p.title) {
      log.warn(`${label}: "title" is required`);
    } else if (p.title.length > 24) {
      log.warn(`${label}: title exceeds 24 characters`);
    }

    const blocks = p.blocks ?? [];
    if (blocks.length === 0) log.warn(`${label}: "blocks" is empty`);
    if (blocks.length > 100) log.warn(`${label}: more than 100 blocks`);

    const names = new Set<string>();
    for (const b of blocks) {
      if (!b.type) {
        log.warn(`${label}: block without "type"`);
        continue;
      }
      if (!FORM_INTERACTIVE_TYPES.has(b.type)) continue;
      if (!b.name) {
        log.warn(`${label}: "${b.type}" block requires "name"`);
      } else if (names.has(b.name)) {
        log.warn(`${label}: duplicate block name "${b.name}"`);
      } else {
        names.add(b.name);
      }
      if (FORM_OPTION_TYPES.has(b.type) && !Array.isArray((b as Record<string, unknown>).options)) {
        log.warn(`${label}: "${b.type}" block "${b.name ?? "?"}" requires "options"`);
      }
    }

    const ref = `form:${p.alias}`;
    if (!config.rules.some((pipe) => pipe[0]?.from === ref)) {
      log.warn(`${label}: no pipeline with "from: ${ref}" — submissions will be ignored`);
    }
  }
}

/** Walk a content object recursively, collecting root keys from every {{path}} template it contains. */
function collectTemplateRoots(value: unknown, acc: Set<string> = new Set()): Set<string> {
  if (typeof value === "string") {
    const re = /\{\{([\w.]+)\}\}/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(value)) !== null) {
      const root = m[1].split(".")[0];
      acc.add(root);
    }
  } else if (Array.isArray(value)) {
    for (const v of value) collectTemplateRoots(v, acc);
  } else if (value && typeof value === "object") {
    for (const v of Object.values(value)) collectTemplateRoots(v, acc);
  }
  return acc;
}
