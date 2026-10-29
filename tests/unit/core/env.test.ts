import { describe, expect, it, afterEach } from "bun:test";
import { loadDotEnv, parseDotEnv } from "../../../src/core/env";

const TMP = `${import.meta.dir}/.env.test-tmp`;
const KEYS = ["TEST_DOTENV_A", "TEST_DOTENV_B", "DOTENV_OVERRIDE", "ENV_FILE"];

async function writeEnv(text: string): Promise<string> {
  await Bun.write(TMP, text);
  return TMP;
}

afterEach(async () => {
  for (const key of KEYS) delete process.env[key];
  try {
    await Bun.file(TMP).unlink();
  } catch {
    // the test may not have written it
  }
});

describe("parseDotEnv", () => {
  it("reads KEY=value, skipping comments and blank lines", () => {
    expect(
      parseDotEnv("# comment\n\nA=1\nB = two words \n export C=3\n"),
    ).toEqual({ A: "1", B: "two words", C: "3" });
  });

  it("strips surrounding quotes and unescapes \\n in double-quoted values", () => {
    expect(parseDotEnv(`A="line1\\nline2"\nB='raw\\n'\n`)).toEqual({
      A: "line1\nline2",
      B: "raw\\n",
    });
  });

  it("keeps values that contain = and #", () => {
    expect(parseDotEnv("TOKEN=abc==\nPASS=p#ssword")).toEqual({
      TOKEN: "abc==",
      PASS: "p#ssword",
    });
  });

  it("ignores lines without a key", () => {
    expect(parseDotEnv("=orphan\nnot a pair\n1BAD=x\nOK=y")).toEqual({ OK: "y" });
  });
});

describe("loadDotEnv", () => {
  it("overrides a variable inherited from the shell and reports it", async () => {
    process.env.TEST_DOTENV_A = "from-shell";
    const overridden = await loadDotEnv(await writeEnv("TEST_DOTENV_A=from-file\nTEST_DOTENV_B=new\n"));

    expect(process.env.TEST_DOTENV_A).toBe("from-file");
    expect(process.env.TEST_DOTENV_B).toBe("new");
    // only the shadowed one is reported; a variable the file simply introduces is not an override
    expect(overridden).toEqual(["TEST_DOTENV_A"]);
  });

  it("leaves the environment alone with DOTENV_OVERRIDE=false", async () => {
    process.env.DOTENV_OVERRIDE = "false";
    process.env.TEST_DOTENV_A = "from-shell";
    const overridden = await loadDotEnv(await writeEnv("TEST_DOTENV_A=from-file\n"));

    expect(process.env.TEST_DOTENV_A).toBe("from-shell");
    expect(overridden).toEqual([]);
  });

  it("is a no-op when the file does not exist", async () => {
    expect(await loadDotEnv(`${TMP}.missing`)).toEqual([]);
  });

  it("takes the path from ENV_FILE", async () => {
    process.env.ENV_FILE = await writeEnv("TEST_DOTENV_B=via-env-file\n");
    await loadDotEnv();
    expect(process.env.TEST_DOTENV_B).toBe("via-env-file");
  });
});
