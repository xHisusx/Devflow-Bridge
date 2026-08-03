import { describe, test, expect } from "bun:test";
import { validateIntakeBody } from "../../../src/modules/plane/domain/services/intake-validator";

const SECTIONS = ["Реестр контрактов", "KPI", "Аналитическая отчетность"];

describe("validateIntakeBody", () => {
  test("valid body passes", () => {
    const errors = validateIntakeBody(
      { section: { required: true, values: SECTIONS } },
      { name: "Test", section: "KPI" },
    );
    expect(errors).toEqual([]);
  });

  test("missing required field", () => {
    const errors = validateIntakeBody(
      { section: { required: true, values: SECTIONS } },
      { name: "Test" },
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('"section" is required');
  });

  test("blank string counts as missing", () => {
    const errors = validateIntakeBody(
      { section: { required: true } },
      { section: "   " },
    );
    expect(errors).toEqual(['Field "section" is required']);
  });

  test("value outside enum rejected with allowed list", () => {
    const errors = validateIntakeBody(
      { section: { required: true, values: SECTIONS } },
      { section: "Другое" },
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('invalid value "Другое"');
    expect(errors[0]).toContain("Реестр контрактов");
  });

  test("enum comparison is case-sensitive", () => {
    const errors = validateIntakeBody(
      { section: { values: SECTIONS } },
      { section: "kpi" },
    );
    expect(errors).toHaveLength(1);
  });

  test("optional field absent is fine", () => {
    const errors = validateIntakeBody(
      { section: { values: SECTIONS } },
      { name: "Test" },
    );
    expect(errors).toEqual([]);
  });

  test("required without values only checks presence", () => {
    const errors = validateIntakeBody(
      { email: { required: true } },
      { email: "a@b.com" },
    );
    expect(errors).toEqual([]);
  });

  describe("requiredIf", () => {
    const FIELDS = {
      discoveredAt: { requiredIf: { field: "type", value: "Ошибка" } },
    };

    test("missing field rejected when condition matches", () => {
      const errors = validateIntakeBody(FIELDS, { type: "Ошибка" });
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain('"discoveredAt" is required when "type" is "Ошибка"');
    });

    test("missing field ok when condition does not match", () => {
      expect(validateIntakeBody(FIELDS, { type: "Вопрос" })).toEqual([]);
    });

    test("missing field ok when condition field absent", () => {
      expect(validateIntakeBody(FIELDS, {})).toEqual([]);
    });

    test("present field passes when condition matches", () => {
      expect(validateIntakeBody(FIELDS, { type: "Ошибка", discoveredAt: "28.07.2026" })).toEqual([]);
    });
  });

  test("multiple errors accumulate", () => {
    const errors = validateIntakeBody(
      { section: { required: true, values: SECTIONS }, email: { required: true } },
      {},
    );
    expect(errors).toHaveLength(2);
  });
});
