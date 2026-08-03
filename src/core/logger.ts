export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export class Logger {
  private level: number;

  constructor(level?: LogLevel) {
    const resolved =
      level ??
      (process.env.LOG_LEVEL as LogLevel | undefined) ??
      (process.env.NODE_ENV === "test" ? "debug" : "info");
    this.level = LEVELS[resolved] ?? LEVELS.info;
  }

  debug(msg: string, ctx?: Record<string, unknown>): void {
    if (this.level <= LEVELS.debug) this.write("DEBUG", msg, ctx);
  }

  info(msg: string, ctx?: Record<string, unknown>): void {
    if (this.level <= LEVELS.info) this.write("INFO", msg, ctx);
  }

  warn(msg: string, ctx?: Record<string, unknown>): void {
    if (this.level <= LEVELS.warn) this.write("WARN", msg, ctx);
  }

  error(msg: string, ctx?: Record<string, unknown>): void {
    if (this.level <= LEVELS.error) this.write("ERROR", msg, ctx);
  }

  private write(level: string, msg: string, ctx?: Record<string, unknown>): void {
    const ts = new Date().toISOString();
    const line = ctx
      ? `${ts} [${level}] ${msg} ${JSON.stringify(ctx)}`
      : `${ts} [${level}] ${msg}`;

    if (level === "ERROR") console.error(line);
    else if (level === "WARN") console.warn(line);
    else console.log(line);
  }
}

export const log = new Logger();
