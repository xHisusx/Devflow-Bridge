import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveFormProviders, validateConfig } from "../../../src/core/config";
import type { Config, Provider, FormProvider } from "../../../src/core/config";
import type { Rule } from "../../../src/modules/messenger/domain/entities/notification";
import { ProviderRegistry } from "../../../src/core/provider-registry";

const BLOCKS = [{ type: "input", name: "summary", label: "Кратко" }];

function makeConfig(providers: Provider[], rules: Rule[][] = []): Config {
  return { providers, rules };
}

describe("resolveFormProviders", () => {
  test("loads an external form file (snake_case keys) relative to the config dir", async () => {
    const dir = mkdtempSync(join(tmpdir(), "plane-pachka-forms-"));
    try {
      mkdirSync(join(dir, "forms"));
      writeFileSync(
        join(dir, "forms", "support.json"),
        JSON.stringify({ title: "Заявка", submit_text: "Отправить", close_text: "Отмена", blocks: BLOCKS }),
      );

      const provider: FormProvider = { type: "form", alias: "support", file: "forms/support.json" };
      await resolveFormProviders(makeConfig([provider]), dir);

      expect(provider.title).toBe("Заявка");
      expect(provider.submitText).toBe("Отправить");
      expect(provider.closeText).toBe("Отмена");
      expect(provider.blocks).toEqual(BLOCKS);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("inline provider fields take precedence over the file's", async () => {
    const dir = mkdtempSync(join(tmpdir(), "plane-pachka-forms-"));
    try {
      writeFileSync(
        join(dir, "support.json"),
        JSON.stringify({ title: "Из файла", submitText: "Из файла", blocks: BLOCKS }),
      );

      const provider: FormProvider = { type: "form", alias: "support", file: "support.json", title: "Инлайн" };
      await resolveFormProviders(makeConfig([provider]), dir);

      expect(provider.title).toBe("Инлайн");
      expect(provider.submitText).toBe("Из файла");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("throws when the form file is missing", async () => {
    const provider: FormProvider = { type: "form", alias: "support", file: "no-such.json" };

    expect(resolveFormProviders(makeConfig([provider]), tmpdir())).rejects.toThrow("file not found");
  });

  test("throws when no blocks are defined inline or via file", async () => {
    const provider: FormProvider = { type: "form", alias: "support", title: "Заявка" };

    expect(resolveFormProviders(makeConfig([provider]), tmpdir())).rejects.toThrow('no "blocks"');
  });

  test("inline-only provider passes without a file", async () => {
    const provider: FormProvider = { type: "form", alias: "support", title: "Заявка", blocks: BLOCKS };

    await resolveFormProviders(makeConfig([provider]), tmpdir());
    expect(provider.blocks).toEqual(BLOCKS);
  });
});

describe("validateConfig — forms", () => {
  const FORM: FormProvider = { type: "form", alias: "support", title: "Заявка", blocks: BLOCKS };
  const PACHKA: Provider = { type: "pachka", alias: "helpdesk", chatId: 555 };
  const PLANE: Provider = {
    type: "plane", alias: "dev", baseUrl: "http://plane.test", workspace: "team", project: "Backend",
  };

  const SUBMIT_PIPELINE: Rule[] = [
    { from: "form:support", to: "pachka:helpdesk", on: { content: { message: "📬 {{data.summary}}" } } },
  ];

  function collect(providers: Provider[], rules: Rule[][]): string[] {
    const warnings: string[] = [];
    validateConfig(makeConfig(providers, rules), new ProviderRegistry(providers), {
      warn: (msg) => warnings.push(msg),
    });
    return warnings;
  }

  test("a well-formed form pipeline produces no warnings", () => {
    const warnings = collect([FORM, PACHKA], [SUBMIT_PIPELINE]);
    expect(warnings).toEqual([]);
  });

  test("form trigger may reference data/user/meta template roots", () => {
    const pipeline: Rule[] = [
      {
        from: "form:support",
        to: "pachka:helpdesk",
        on: { content: { message: "{{data.summary}} {{user.first_name}} {{meta.correlationId}} {{receivedAt}}" } },
      },
    ];
    const warnings = collect([FORM, PACHKA], [pipeline]).filter((w) => w.includes("not exposed"));
    expect(warnings).toEqual([]);
  });

  test("warns on missing title, overlong title, block without name, duplicate names, missing options", () => {
    const broken: FormProvider = {
      type: "form",
      alias: "bad",
      title: "Очень длинный заголовок формы, который не влезает",
      blocks: [
        { type: "input", label: "no name" },
        { type: "input", name: "x", label: "a" },
        { type: "input", name: "x", label: "b" },
        { type: "select", name: "y", label: "c" },
      ],
    };
    const warnings = collect([broken], []);

    expect(warnings.some((w) => w.includes("title exceeds 24"))).toBe(true);
    expect(warnings.some((w) => w.includes('requires "name"'))).toBe(true);
    expect(warnings.some((w) => w.includes('duplicate block name "x"'))).toBe(true);
    expect(warnings.some((w) => w.includes('requires "options"'))).toBe(true);
    expect(warnings.some((w) => w.includes("no pipeline"))).toBe(true);

    const noTitle: FormProvider = { type: "form", alias: "empty", blocks: BLOCKS };
    expect(collect([noTitle], []).some((w) => w.includes('"title" is required'))).toBe(true);
  });

  test("first pipeline step may be from: form:*, but to: form:* warns", () => {
    const firstStepWarnings = collect([FORM, PACHKA], [SUBMIT_PIPELINE]).filter((w) =>
      w.includes("first step"),
    );
    expect(firstStepWarnings).toEqual([]);

    const toForm: Rule[] = [
      { from: "plane:dev", to: "form:support", on: { content: { message: "x" } } },
    ];
    const warnings = collect([FORM, PLANE], [toForm]);
    expect(warnings.some((w) => w.includes("forms can only be a pipeline source"))).toBe(true);
  });

  test("warns when a button references an unknown form or mixes form with url/callbackData", () => {
    const pipeline: Rule[] = [
      {
        from: "plane:dev",
        to: "pachka:helpdesk",
        on: {
          content: {
            message: "x",
            actions: [
              {
                type: "buttons",
                buttons: [
                  { text: "Открыть форму", form: "ghost" },
                  { text: "Смешано", form: "support", url: "https://x" },
                ],
              },
            ],
          },
        },
      },
    ];
    const warnings = collect([FORM, PLANE, PACHKA, ...[]], [pipeline]);

    expect(warnings.some((w) => w.includes('form provider "form:ghost" not found'))).toBe(true);
    expect(warnings.some((w) => w.includes('"form" excludes'))).toBe(true);
  });
});
