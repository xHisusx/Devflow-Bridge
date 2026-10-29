/**
 * Latin transliteration and slugs — used to build git branch names out of Cyrillic task titles
 * ("Исправить баг в отчётах" -> "ispravit-bag-v-otchetah") and assignee initials ("Алексей Махов" -> "am").
 */

const CYRILLIC_MAP: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i",
  й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t",
  у: "u", ф: "f", х: "h", ц: "c", ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "",
  э: "e", ю: "yu", я: "ya",
  // Ukrainian / Belarusian letters that show up in names
  і: "i", ї: "yi", є: "ye", ґ: "g", ў: "u",
};

/** Transliterate Cyrillic to Latin, preserving the case of the first letter. */
export function transliterate(input: string): string {
  let out = "";
  for (const ch of input) {
    const lower = ch.toLowerCase();
    const mapped = CYRILLIC_MAP[lower];
    if (mapped === undefined) {
      out += ch;
      continue;
    }
    out += ch === lower || mapped === "" ? mapped : mapped[0].toUpperCase() + mapped.slice(1);
  }
  return out;
}

/**
 * Branch-safe slug: transliterated, lower-cased, non-alphanumerics collapsed to "-".
 * Longer input is cut on a word boundary when one is reasonably close to the limit.
 */
export function slugify(input: string, maxLength = 60): string {
  const base = transliterate(input)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  if (base.length <= maxLength) return base;
  const cut = base.slice(0, maxLength);
  const lastDash = cut.lastIndexOf("-");
  const trimmed = lastDash > maxLength / 2 ? cut.slice(0, lastDash) : cut;
  return trimmed.replace(/-+$/, "");
}

/** "Алексей Махов" -> "am" (transliterated first letters, at most `max` of them). */
export function initialsFromName(fullName: string, max = 2): string {
  const parts = transliterate(fullName)
    .split(/[\s.]+/)
    .map((p) => p.replace(/[^A-Za-z0-9]/g, ""))
    .filter(Boolean);
  return parts
    .slice(0, max)
    .map((p) => p[0].toLowerCase())
    .join("");
}

/**
 * Initials from an email's local part: "a.makhov@x" / "alexey_makhov@x" -> "am",
 * single-word locals fall back to their first two characters ("amakhov@x" -> "am").
 */
export function initialsFromEmail(email: string): string {
  const local = email.split("@")[0] ?? "";
  const parts = local.split(/[._+\-\d]+/).filter(Boolean);
  if (parts.length === 0) return "";
  if (parts.length === 1) return parts[0].slice(0, 2).toLowerCase();
  return parts
    .slice(0, 2)
    .map((p) => p[0].toLowerCase())
    .join("");
}

/** Initials for a branch name: prefer the full name, fall back to the email, else "". */
export function initials(fullName?: string | null, email?: string | null): string {
  const fromName = fullName ? initialsFromName(fullName) : "";
  if (fromName) return fromName;
  return email ? initialsFromEmail(email) : "";
}

/**
 * Loose key for matching the same person written differently across systems — Cyrillic in the
 * tracker, Latin in git ("Алексей Махов" / "Alexey Makhov" / "Aleksey Mahov" all key the same).
 * Transliterates, then folds the digraphs and name endings that differ between transliteration
 * schemes, and sorts the parts so "Махов Алексей" matches "Alexey Makhov".
 *
 * Deliberately lossy: only ever used to pick a unique candidate out of a known member list.
 */
export function nameKey(name: string): string {
  const latin = transliterate(name)
    .toLowerCase()
    .replace(/[^a-z]+/g, " ")
    .trim();

  const tokens = latin
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => {
      const folded = token
        .replace(/shch|sch/g, "s")
        .replace(/ks/g, "x")
        .replace(/kh/g, "h")
        .replace(/zh/g, "j")
        .replace(/ch|sh|ts/g, "c")
        .replace(/[yi]([aeiou])/g, "$1")
        .replace(/(.)\1+/g, "$1")
        .replace(/[yi]+$/g, "");
      return folded || token;
    })
    .sort();

  return tokens.join(" ");
}
