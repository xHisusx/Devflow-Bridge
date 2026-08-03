import { describe, test, expect } from "bun:test";
import { validateConfig } from "../../../src/core/config";
import type { Config, Provider } from "../../../src/core/config";
import type { Rule } from "../../../src/modules/messenger/domain/entities/notification";
import { ProviderRegistry } from "../../../src/core/provider-registry";

const PROVIDERS: Provider[] = [
  { type: "plane", alias: "dev", baseUrl: "http://plane.test", workspace: "team", project: "Backend" },
  { type: "pachka", alias: "support", chatId: 12345 },
  { type: "api", alias: "intake", endpoint: "/api/plane/intake-issues" },
];

const registry = new ProviderRegistry(PROVIDERS);

/** Run validateConfig and return all warnings it emitted. */
function collectWarnings(rules: Rule[][], providers = PROVIDERS): string[] {
  const warnings: string[] = [];
  const config: Config = { providers, rules };
  validateConfig(config, registry, { warn: (msg) => warnings.push(msg) });
  return warnings;
}

describe("validateConfig — plane trigger role", () => {
  test("plane trigger may reference webhook-only fields (assignee/state/priority)", () => {
    const rule: Rule = {
      from: "plane:dev",
      to: "pachka:support",
      on: {
        action: "update",
        state: "Review",
        content: { message: "{{assignee}} → {{state}} ({{priority}}) [{{identifier}}]({{issueUrl}})" },
      },
    };

    const exposureWarnings = collectWarnings([[rule]]).filter((w) => w.includes("not exposed"));
    expect(exposureWarnings).toEqual([]);
  });

  test("plane trigger referencing an unknown field still warns", () => {
    const rule: Rule = {
      from: "plane:dev",
      to: "pachka:support",
      on: { content: { message: "{{bogus}}" } },
    };

    const exposureWarnings = collectWarnings([[rule]]).filter((w) => w.includes("not exposed"));
    expect(exposureWarnings.length).toBe(1);
    expect(exposureWarnings[0]).toContain("{{bogus");
  });

  test("plane trigger referencing a step-only field (name) warns — name is not a trigger output", () => {
    const rule: Rule = {
      from: "plane:dev",
      to: "pachka:support",
      on: { content: { message: "{{name}}" } },
    };

    const exposureWarnings = collectWarnings([[rule]]).filter((w) => w.includes("not exposed"));
    expect(exposureWarnings.length).toBe(1);
    expect(exposureWarnings[0]).toContain("{{name");
  });
});

describe("validateConfig — plane step role (intake pipeline)", () => {
  const PLANE_STEP: Rule = {
    from: "api:intake",
    to: "plane:dev",
    on: {
      action: "create",
      entity: "task",
      content: { name: "{{body.name}}", description: "{{body.description}}", labels: "{{body.labels}}" },
      outputs: ["issueId", "issueUrl", "seq", "identifier", "name", "description", "labels"],
    },
  };

  test("downstream step may reference declared step outputs (name/issueUrl)", () => {
    const notify: Rule = {
      from: "plane:dev",
      to: "pachka:support",
      on: {
        content: {
          message: "📬 {{name}}",
          actions: [{ type: "buttons", buttons: [{ text: "Open", url: "{{issueUrl}}" }] }],
        },
      },
    };

    const exposureWarnings = collectWarnings([[PLANE_STEP, notify]]).filter((w) => w.includes("not exposed"));
    expect(exposureWarnings).toEqual([]);
  });

  test("downstream step referencing a non-declared output warns", () => {
    const notify: Rule = {
      from: "plane:dev",
      to: "pachka:support",
      // workspace is a plane step field but NOT in the upstream `outputs` declaration
      on: { content: { message: "{{workspace}}" } },
    };

    const exposureWarnings = collectWarnings([[PLANE_STEP, notify]]).filter((w) => w.includes("not exposed"));
    expect(exposureWarnings.length).toBe(1);
    expect(exposureWarnings[0]).toContain("{{workspace");
  });
});
