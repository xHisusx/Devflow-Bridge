import { describe, test, expect } from "bun:test";
import { resolve, mapContent } from "../../../src/modules/plane/domain/services/content-mapper";

describe("resolve", () => {
  test("extracts field via {{path}} whole-value template", () => {
    expect(resolve("{{body.name}}", { body: { name: "Test" } })).toBe("Test");
  });

  test("extracts nested field", () => {
    expect(resolve("{{body.user.email}}", { body: { user: { email: "a@b.com" } } })).toBe("a@b.com");
  });

  test("extracts flat field (no body namespace)", () => {
    expect(resolve("{{name}}", { name: "Test" })).toBe("Test");
  });

  test("returns undefined for missing path", () => {
    expect(resolve("{{body.missing}}", { body: { name: "Test" } })).toBeUndefined();
  });

  test("returns undefined for missing nested path", () => {
    expect(resolve("{{body.a.b.c}}", { body: { a: { x: 1 } } })).toBeUndefined();
  });

  test("returns static string as-is (no templates)", () => {
    expect(resolve("Support", {})).toBe("Support");
  });

  test("returns static array as-is", () => {
    expect(resolve(["Bug", "Support"], {})).toEqual(["Bug", "Support"]);
  });

  test("returns static number as-is", () => {
    expect(resolve(42, {})).toBe(42);
  });

  test("extracts array via whole-value template", () => {
    expect(resolve("{{body.labels}}", { body: { labels: ["Bug", "Urgent"] } })).toEqual(["Bug", "Urgent"]);
  });

  test("interpolates multiple templates in a string", () => {
    expect(resolve("Hello {{body.name}}!", { body: { name: "World" } })).toBe("Hello World!");
  });

  test("resolves templates inside arrays", () => {
    expect(resolve(["{{body.section}}"], { body: { section: "KPI" } })).toEqual(["KPI"]);
  });

  test("flattens array-valued templates inside arrays", () => {
    expect(
      resolve(["{{body.section}}", "{{body.labels}}"], {
        body: { section: "KPI", labels: ["Bug", "Urgent"] },
      }),
    ).toEqual(["KPI", "Bug", "Urgent"]);
  });

  test("drops missing values when resolving arrays", () => {
    expect(resolve(["{{body.section}}", "{{body.labels}}"], { body: { section: "KPI" } })).toEqual([
      "KPI",
    ]);
  });

  test("mixes literals and templates inside arrays", () => {
    expect(resolve(["Support", "{{body.section}}"], { body: { section: "KPI" } })).toEqual([
      "Support",
      "KPI",
    ]);
  });

  test("equality conditional keeps block on match", () => {
    expect(
      resolve("{{#body.type=Ошибка}}Дата: {{body.date}} {{/body.type}}x", {
        body: { type: "Ошибка", date: "28.07" },
      }),
    ).toBe("Дата: 28.07 x");
  });

  test("equality conditional drops block on mismatch", () => {
    expect(
      resolve("{{#body.type=Ошибка}}Дата: {{body.date}} {{/body.type}}x", {
        body: { type: "Вопрос", date: "28.07" },
      }),
    ).toBe("x");
  });

  test("truthy conditional keeps block when value present", () => {
    expect(
      resolve("{{body.phone}}{{#body.ext}} (доб. {{body.ext}}){{/body.ext}}", {
        body: { phone: "123", ext: "45" },
      }),
    ).toBe("123 (доб. 45)");
  });

  test("truthy conditional drops block when value empty or missing", () => {
    expect(resolve("{{body.phone}}{{#body.ext}} (доб. {{body.ext}}){{/body.ext}}", {
      body: { phone: "123", ext: "" },
    })).toBe("123");
    expect(resolve("{{body.phone}}{{#body.ext}} (доб. {{body.ext}}){{/body.ext}}", {
      body: { phone: "123" },
    })).toBe("123");
  });

  test("interpolation with missing path yields empty string", () => {
    expect(resolve("Hi {{body.missing}}x", { body: {} })).toBe("Hi x");
  });
});

describe("mapContent", () => {
  test("maps dynamic fields from source", () => {
    const mapping = { name: "{{body.name}}", description: "{{body.desc}}" };
    const source = { body: { name: "Test issue", desc: "<p>Details</p>" } };
    const result = mapContent(mapping, source);
    expect(result.name).toBe("Test issue");
    expect(result.description).toBe("<p>Details</p>");
  });

  test("maps static values", () => {
    const mapping = { name: "{{body.name}}", labels: ["Support"] };
    const result = mapContent(mapping, { body: { name: "Test" } });
    expect(result.name).toBe("Test");
    expect(result.labels).toEqual(["Support"]);
  });

  test("mixes dynamic and static", () => {
    const mapping = {
      name: "{{body.title}}",
      description: "{{body.details}}",
      labels: ["Support"],
      priority: "medium",
    };
    const source = { body: { title: "Bug report", details: "<p>Broken</p>" } };
    const result = mapContent(mapping, source);
    expect(result.name).toBe("Bug report");
    expect(result.description).toBe("<p>Broken</p>");
    expect(result.labels).toEqual(["Support"]);
    expect(result.priority).toBe("medium");
  });

  test("missing source fields resolve to undefined", () => {
    const mapping = { name: "{{body.name}}", description: "{{body.desc}}" };
    const result = mapContent(mapping, { body: { name: "Test" } });
    expect(result.name).toBe("Test");
    expect(result.description).toBeUndefined();
  });

  test("remaps field names", () => {
    const mapping = { name: "{{body.subject}}", description: "{{body.message}}" };
    const source = { body: { subject: "Help!", message: "<p>I need help</p>" } };
    const result = mapContent(mapping, source);
    expect(result.name).toBe("Help!");
    expect(result.description).toBe("<p>I need help</p>");
  });
});
