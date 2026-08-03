import { describe, test, expect } from "bun:test";
import { renderMessage } from "../../../src/modules/plane/domain/services/template-renderer";

describe("renderMessage", () => {
  test("replaces placeholders", () => {
    expect(renderMessage("{{project}} #{{seq}}", { project: "Backend", seq: "42" })).toBe("Backend #42");
  });

  test("missing placeholder becomes empty string", () => {
    expect(renderMessage("{{project}} {{unknown}}", { project: "X" })).toBe("X ");
  });

  test("no placeholders returns string as-is", () => {
    expect(renderMessage("plain text", {})).toBe("plain text");
  });

  test("replaces all available placeholders", () => {
    const vars = {
      project: "API",
      seq: "1",
      title: "Fix bug",
      state: "Done",
      stateGroup: "completed",
      priority: "high",
      action: "updated",
      entity: "issue",
      issueId: "uuid-123",
      issueUrl: "http://example.com/issue/1",
    };
    const tmpl = "{{project}} #{{seq}} {{title}} {{state}} {{stateGroup}} {{priority}} {{action}} {{entity}} {{issueId}} {{issueUrl}}";
    const result = renderMessage(tmpl, vars);
    expect(result).toBe("API #1 Fix bug Done completed high updated issue uuid-123 http://example.com/issue/1");
  });

  test("handles repeated placeholders", () => {
    expect(renderMessage("{{a}}-{{a}}", { a: "x" })).toBe("x-x");
  });
});

describe("renderMessage — conditional blocks {{#path=value}}...{{/path}}", () => {
  test("keeps the block body when the value matches", () => {
    expect(
      renderMessage("{{#priority=Критическая}}🚨 СРОЧНО\n{{/priority}}Запрос: {{title}}", {
        priority: "Критическая",
        title: "X",
      }),
    ).toBe("🚨 СРОЧНО\nЗапрос: X");
  });

  test("drops the block when the value does not match or is missing", () => {
    const tmpl = "{{#priority=Критическая}}🚨 СРОЧНО\n{{/priority}}Запрос: {{title}}";
    expect(renderMessage(tmpl, { priority: "Низкая", title: "X" })).toBe("Запрос: X");
    expect(renderMessage(tmpl, { title: "X" })).toBe("Запрос: X");
  });

  test("supports dotted paths and placeholders inside the block body", () => {
    expect(
      renderMessage("{{#data.type=Bug}}Ошибка от {{user.name}}!{{/data.type}}", {
        data: { type: "Bug" },
        user: { name: "Ann" },
      }),
    ).toBe("Ошибка от Ann!");
  });

  test("multiple independent blocks are evaluated separately", () => {
    const tmpl = "{{#a=1}}A{{/a}}{{#b=2}}B{{/b}}";
    expect(renderMessage(tmpl, { a: "1", b: "0" })).toBe("A");
    expect(renderMessage(tmpl, { a: "0", b: "2" })).toBe("B");
  });
});
