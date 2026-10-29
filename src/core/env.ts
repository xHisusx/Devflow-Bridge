import { log } from "./logger";

/**
 * Make the project's `.env` the authority on credentials.
 *
 * Bun loads `.env` by itself, but it never overwrites a variable the process already inherited.
 * Anything exported before the bridge starts — a Windows user environment variable, a shell
 * profile, `docker run -e` — therefore silently beats the file, and the bridge authenticates as
 * somebody else with nothing in the log to say where the value came from (this cost us a Taiga
 * 401 that looked like a broken token). Values from the file win; `DOTENV_OVERRIDE=false` keeps
 * the inherited environment instead, for setups that deliberately inject env from outside.
 */
export async function loadDotEnv(path?: string): Promise<string[]> {
  const file = path ?? process.env.ENV_FILE ?? ".env";
  const handle = Bun.file(file);
  if (!(await handle.exists())) return [];

  const values = parseDotEnv(await handle.text());
  if (process.env.DOTENV_OVERRIDE === "false") {
    log.debug(`DOTENV_OVERRIDE=false: ${file} will not override the environment`);
    return [];
  }

  const overridden: string[] = [];
  for (const [key, value] of Object.entries(values)) {
    const current = process.env[key];
    if (current !== undefined && current !== value) overridden.push(key);
    process.env[key] = value;
  }

  if (overridden.length > 0) {
    // Names only — these are secrets. The warning is the whole point: it names the variables that
    // would otherwise have been taken from the shell instead of the file.
    log.warn(
      `${file} overrode variables inherited from the environment: ${overridden.join(", ")}`,
    );
  }
  return overridden;
}

/**
 * Minimal `KEY=value` parser: `#` comments, blank lines and an optional `export ` prefix are
 * ignored, surrounding quotes are stripped, and `\n` inside a double-quoted value becomes a
 * newline. An inline `#` is part of the value (quote it if that is not what you meant).
 */
export function parseDotEnv(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim().replace(/^export\s+/, "");
    if (!line || line.startsWith("#")) continue;

    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    let value = line.slice(eq + 1).trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.length > 1 && value.endsWith(quote)) {
      value = value.slice(1, -1);
      if (quote === '"') value = value.replace(/\\n/g, "\n");
    }
    result[key] = value;
  }
  return result;
}
