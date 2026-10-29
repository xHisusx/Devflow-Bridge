import { describe, test, expect } from "bun:test";
import { initials, initialsFromEmail, initialsFromName, nameKey, slugify, transliterate } from "../../../src/core/slug";

describe("transliterate", () => {
  test("maps Cyrillic to Latin, keeping the case of the first letter", () => {
    expect(transliterate("Алексей Махов")).toBe("Aleksey Mahov");
    expect(transliterate("Щука ёж")).toBe("Schuka ezh");
  });

  test("leaves Latin and punctuation untouched", () => {
    expect(transliterate("Fix API v2 (urgent)")).toBe("Fix API v2 (urgent)");
  });
});

describe("slugify", () => {
  test("builds a branch-safe slug from a Cyrillic title", () => {
    expect(slugify("Исправить баг в отчётах")).toBe("ispravit-bag-v-otchetah");
  });

  test("collapses punctuation and trims separators", () => {
    expect(slugify("  Fix: API v2 — (urgent)!  ")).toBe("fix-api-v2-urgent");
  });

  test("cuts long titles on a word boundary", () => {
    const slug = slugify("Очень длинное название задачи которое точно не влезет в лимит", 30);
    expect(slug.length).toBeLessThanOrEqual(30);
    expect(slug.endsWith("-")).toBe(false);
    expect(slug.startsWith("ochen-dlinnoe-nazvanie")).toBe(true);
  });
});

describe("initials", () => {
  test("from a full name", () => {
    expect(initialsFromName("Алексей Махов")).toBe("am");
    expect(initialsFromName("John Ronald Reuel Tolkien")).toBe("jr");
  });

  test("from an email's local part", () => {
    expect(initialsFromEmail("a.makhov@example.com")).toBe("am");
    expect(initialsFromEmail("alexey_makhov@example.com")).toBe("am");
    expect(initialsFromEmail("amakhov@example.com")).toBe("am");
  });

  test("prefers the name, falls back to the email, then to empty", () => {
    expect(initials("Алексей Махов", "other@example.com")).toBe("am");
    expect(initials("", "i.ivanov@example.com")).toBe("ii");
    expect(initials(null, null)).toBe("");
  });
});

describe("nameKey", () => {
  test("the same person keys the same across transliteration schemes", () => {
    const expected = nameKey("Alexey Makhov");
    expect(nameKey("Алексей Махов")).toBe(expected);
    expect(nameKey("Aleksey Mahov")).toBe(expected);
    expect(nameKey("Махов Алексей")).toBe(expected);
    expect(nameKey("makhov, alexey")).toBe(expected);
  });

  test("the -y / -i / -iy endings fold together", () => {
    expect(nameKey("Дмитрий Орлов")).toBe(nameKey("Dmitry Orlov"));
    expect(nameKey("Андрей Сергеев")).toBe(nameKey("Andrei Sergeev"));
    expect(nameKey("Юрий Юрьев")).toBe(nameKey("Yuri Yuriev"));
  });

  test("different people key differently", () => {
    expect(nameKey("Алексей Махов")).not.toBe(nameKey("Иван Петров"));
    expect(nameKey("Alexey Makhov")).not.toBe(nameKey("Alexey Mironov"));
  });

  test("an empty or symbol-only name keys to an empty string", () => {
    expect(nameKey("")).toBe("");
    expect(nameKey("-- ??")).toBe("");
  });
});
