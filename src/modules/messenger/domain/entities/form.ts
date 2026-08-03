// Pachka modal view (form) domain types.
// Blocks are pass-through Pachka-native JSON (snake_case keys), sent verbatim to POST /views/open.

export interface FormBlock {
  type: string;
  name?: string;
  [key: string]: unknown;
}

/** Block types that carry a `name` and produce a value in the submission payload. */
export const FORM_INTERACTIVE_TYPES: ReadonlySet<string> = new Set([
  "input",
  "select",
  "radio",
  "checkbox",
  "date",
  "time",
  "file_input",
]);

export const FORM_CALLBACK_PREFIX = "form:";

/** Pachka's limit for the private_metadata string on /views/open. */
export const FORM_PRIVATE_METADATA_MAX = 3000;

/** Data-button payload that opens the form: "form:<alias>:open". */
export function buildFormOpenData(alias: string): string {
  return `${FORM_CALLBACK_PREFIX}${alias}:open`;
}

const OPEN_SUFFIX = ":open";

export function parseFormOpenData(data: string): { alias: string } | null {
  if (!data.startsWith(FORM_CALLBACK_PREFIX) || !data.endsWith(OPEN_SUFFIX)) return null;
  const alias = data.slice(FORM_CALLBACK_PREFIX.length, -OPEN_SUFFIX.length);
  return alias ? { alias } : null;
}

/** callback_id sent on view open and echoed back in the submit webhook: "form:<alias>". */
export function formCallbackId(alias: string): string {
  return `${FORM_CALLBACK_PREFIX}${alias}`;
}

/** Camel-case form definition as declared in config (provider fields or an external form file). */
export interface FormDefinition {
  title?: string;
  submitText?: string;
  closeText?: string;
  blocks?: FormBlock[];
}

/** The `view` object for POST /views/open (Pachka-native keys). */
export interface FormViewPayload {
  title: string;
  submit_text?: string;
  close_text?: string;
  blocks: FormBlock[];
}

export function toViewPayload(form: FormDefinition): FormViewPayload {
  return {
    title: form.title ?? "",
    ...(form.submitText ? { submit_text: form.submitText } : {}),
    ...(form.closeText ? { close_text: form.closeText } : {}),
    blocks: form.blocks ?? [],
  };
}

/** Correlation payload carried through private_metadata; available to pipelines as {{meta.*}}. */
export interface FormPrivateMetadata {
  formRef: string;
  messageId?: number;
  chatId?: number;
  correlationId?: string;
  target?: string;
}
