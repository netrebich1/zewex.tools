/** Мягкий разбор JSON из ответа модели: срезает ```json-обёртки и текст вокруг. */
export function parseJsonLenient<T = unknown>(text: string): T | null {
  if (!text) return null;
  let s = text.trim();
  s = s.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  try {
    return JSON.parse(s) as T;
  } catch {
    /* ниже */
  }
  const start = Math.min(...["{", "["].map((c) => (s.indexOf(c) === -1 ? Infinity : s.indexOf(c))));
  if (!Number.isFinite(start)) return null;
  const open = s[start];
  const close = open === "{" ? "}" : "]";
  const end = s.lastIndexOf(close);
  if (end <= start) return null;
  let candidate = s.slice(start, end + 1);
  // типичные поломки: висячие запятые, одинарные кавычки вокруг ключей
  candidate = candidate.replace(/,\s*([}\]])/g, "$1");
  try {
    return JSON.parse(candidate) as T;
  } catch {
    return null;
  }
}
