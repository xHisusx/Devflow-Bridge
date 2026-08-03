import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { Logger } from "../../../src/core/logger";

describe("Logger", () => {
  let logOutput: string[];
  let origLog: typeof console.log;
  let origWarn: typeof console.warn;
  let origError: typeof console.error;

  beforeEach(() => {
    logOutput = [];
    origLog = console.log;
    origWarn = console.warn;
    origError = console.error;
    console.log = (...args: any[]) => logOutput.push(args.join(" "));
    console.warn = (...args: any[]) => logOutput.push(args.join(" "));
    console.error = (...args: any[]) => logOutput.push(args.join(" "));
  });

  afterEach(() => {
    console.log = origLog;
    console.warn = origWarn;
    console.error = origError;
  });

  test("debug messages visible at debug level", () => {
    const logger = new Logger("debug");
    logger.debug("test msg");
    expect(logOutput.length).toBe(1);
    expect(logOutput[0]).toContain("[DEBUG]");
    expect(logOutput[0]).toContain("test msg");
  });

  test("debug messages suppressed at info level", () => {
    const logger = new Logger("info");
    logger.debug("hidden");
    expect(logOutput.length).toBe(0);
  });

  test("info messages visible at info level", () => {
    const logger = new Logger("info");
    logger.info("visible");
    expect(logOutput.length).toBe(1);
    expect(logOutput[0]).toContain("[INFO]");
  });

  test("warn messages visible at warn level", () => {
    const logger = new Logger("warn");
    logger.warn("warning");
    expect(logOutput.length).toBe(1);
    expect(logOutput[0]).toContain("[WARN]");
  });

  test("error always visible", () => {
    const logger = new Logger("error");
    logger.error("critical");
    expect(logOutput.length).toBe(1);
    expect(logOutput[0]).toContain("[ERROR]");
  });

  test("lower levels suppressed at error level", () => {
    const logger = new Logger("error");
    logger.debug("no");
    logger.info("no");
    logger.warn("no");
    expect(logOutput.length).toBe(0);
  });

  test("context object appended as JSON", () => {
    const logger = new Logger("debug");
    logger.debug("msg", { key: "val" });
    expect(logOutput[0]).toContain('{"key":"val"}');
  });

  test("includes ISO timestamp", () => {
    const logger = new Logger("info");
    logger.info("test");
    // ISO 8601 pattern: YYYY-MM-DDTHH:mm:ss
    expect(logOutput[0]).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});
