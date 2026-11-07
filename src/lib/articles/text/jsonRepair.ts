/**
 * Единый «мягкий JSON» для ответов моделей: порт _shared/jsonRepair.ts (parseModelJson, repairTruncatedJson)
 * и помощников из stage7-write-sections (extractJsonFromResponse, balanceJsonClosers, extractSectionsFromTruncated,
 * extractLikelySectionObjects, toSectionList). Аудит 03, §8: четыре реализации → одна.
 */

export type JsonRecord = Record<string, unknown>;

/**
 * Достраивает обрезанный JSON: модель может упереться в лимит длины ответа посреди массива.
 * Закрываем строку, отбрасываем незавершённый элемент и добавляем недостающие скобки. (оригинал: jsonRepair.ts:7-37)
 */
export function repairTruncatedJson(src: string): string {
  const stack: string[] = [];
  let inStr = false, esc = false, lastGoodIdx = -1;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === "{" || c === "[") stack.push(c === "{" ? "}" : "]");
    else if (c === "}" || c === "]") stack.pop();
    if ((c === "," || c === "}" || c === "]") && stack.length <= 2) lastGoodIdx = i;
  }
  let out = src;
  if (inStr || stack.length) {
    if (lastGoodIdx > 0) out = src.slice(0, src[lastGoodIdx] === "," ? lastGoodIdx : lastGoodIdx + 1);
    const st: string[] = [];
    let s2 = false, e2 = false;
    for (const c of out) {
      if (s2) { if (e2) e2 = false; else if (c === "\\") e2 = true; else if (c === '"') s2 = false; continue; }
      if (c === '"') s2 = true;
      else if (c === "{" || c === "[") st.push(c === "{" ? "}" : "]");
      else if (c === "}" || c === "]") st.pop();
    }
    out += st.reverse().join("");
  }
  return out;
}

/** Мягкий разбор JSON-ответа модели: фенсы, обрамляющий текст, обрыв. Бросает, если не вышло. (оригинал: jsonRepair.ts:40-56) */
export function parseModelJson(text: string): unknown {
  const cleaned = String(text || "")
    .replace(/^\s*```(?:json)?/i, "")
    .replace(/```\s*$/, "")
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch { /* ниже пробуем починить */ }
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  const slice = start !== -1 && end > start ? cleaned.slice(start, end + 1) : cleaned;
  try {
    return JSON.parse(slice);
  } catch { /* последняя попытка — достроить обрыв */ }
  const body = start !== -1 ? cleaned.slice(start) : cleaned;
  return JSON.parse(repairTruncatedJson(body));
}

/** То же, но null вместо исключения. */
export function parseModelJsonSafe(text: string): unknown | null {
  try { return parseModelJson(text); } catch { return null; }
}

/** Закрывает незакрытые строки и скобки. (оригинал: stage7-write-sections:2596-2618) */
export function balanceJsonClosers(text: string): string {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;

  for (const ch of text) {
    if (escaped) { escaped = false; continue; }
    if (ch === "\\") { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;

    if (ch === "{" || ch === "[") stack.push(ch);
    else if (ch === "}" && stack[stack.length - 1] === "{") stack.pop();
    else if (ch === "]" && stack[stack.length - 1] === "[") stack.pop();
  }

  let repaired = text;
  if (inString) repaired += '"';
  for (let i = stack.length - 1; i >= 0; i--) {
    repaired += stack[i] === "{" ? "}" : "]";
  }
  return repaired;
}

/** Посимвольный проход по массиву `sections`: вытаскивает целые объекты из обрезанного JSON. (оригинал: 2620-2653) */
export function extractSectionsFromTruncated(content: string): JsonRecord[] {
  const markerMatch = /["']?sections["']?\s*:/i.exec(content);
  if (!markerMatch) return [];
  const arrayStart = content.indexOf("[", markerMatch.index);
  if (arrayStart === -1) return [];

  const sections: JsonRecord[] = [];
  let inString = false, escaped = false, arrayDepth = 0, objectDepth = 0, objectStart = -1;

  for (let i = arrayStart; i < content.length; i++) {
    const ch = content[i];
    if (escaped) { escaped = false; continue; }
    if (ch === "\\") { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;

    if (ch === "[") { arrayDepth++; continue; }
    if (ch === "]") { arrayDepth--; if (arrayDepth <= 0) break; continue; }
    if (arrayDepth < 1) continue;
    if (ch === "{") { if (arrayDepth === 1 && objectDepth === 0) objectStart = i; objectDepth++; continue; }
    if (ch === "}") {
      objectDepth--;
      if (arrayDepth === 1 && objectDepth === 0 && objectStart !== -1) {
        try {
          const obj = JSON.parse(content.slice(objectStart, i + 1));
          if (obj && typeof obj === "object") sections.push(obj as JsonRecord);
        } catch { /* пропускаем битый объект */ }
        objectStart = -1;
      }
    }
  }
  return sections;
}

/** Последний рубеж: объекты `{…}` 40–3000 символов с section_number и текстом. (оригинал: 2655-2680) */
export function extractLikelySectionObjects(content: string, expectedSectionNumbers: number[]): JsonRecord[] {
  if (!content) return [];
  const objects: JsonRecord[] = [];
  const withExpected = new Set(expectedSectionNumbers);

  const candidates = content.match(/\{[\s\S]{40,3000}?\}/g) || [];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as JsonRecord;
      if (!parsed || typeof parsed !== "object") continue;
      const sectionNum = Number(parsed.section_number ?? parsed.section ?? NaN);
      const hasHtml = typeof parsed.html_content === "string" || typeof parsed.html === "string" || typeof parsed.content === "string";
      if (Number.isFinite(sectionNum) && hasHtml && (withExpected.size === 0 || withExpected.has(sectionNum))) {
        objects.push({ ...parsed, section_number: sectionNum });
      }
    } catch { /* битый кандидат */ }
  }
  return objects;
}

/**
 * Разбор ответа писателя секций: прямой JSON → границы → чистка висячих запятых, лишних `\` и управляющих символов
 * → балансировка скобок → извлечение целых секций из обрыва. (оригинал: stage7-write-sections:2543-2594)
 */
export function extractJsonFromResponse(response: string): unknown {
  const cleaned = (typeof response === "string" ? response : JSON.stringify(response ?? ""))
    .replace(/```json\s*/gi, "")
    .replace(/```\s*/g, "")
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch { /* дальше */ }

  const jsonStart = cleaned.search(/[\{\[]/);
  if (jsonStart === -1) throw new Error("В ответе модели нет JSON");

  const startChar = cleaned[jsonStart];
  const endChar = startChar === "[" ? "]" : "}";
  const jsonEnd = cleaned.lastIndexOf(endChar);

  if (jsonEnd > jsonStart) {
    const candidate = cleaned.substring(jsonStart, jsonEnd + 1);
    try {
      return JSON.parse(candidate);
    } catch { /* дальше */ }

    const fixed = candidate
      .replace(/,\s*}/g, "}")
      .replace(/,\s*]/g, "]")
      .replace(/\\([^"\\/bfnrtu])/g, "$1")
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");

    try {
      return JSON.parse(fixed);
    } catch { /* дальше */ }

    try {
      return JSON.parse(balanceJsonClosers(fixed));
    } catch { /* дальше */ }
  }

  const recovered = extractSectionsFromTruncated(cleaned);
  if (recovered.length > 0) return { sections: recovered };

  throw new Error("Не удалось разобрать JSON ответа модели");
}

/** Принимает {sections:[...]}, массив, {"1":{...},"2":{...}}, {"section_1":{...}} или одиночный объект. (оригинал: 3292-3304) */
export function toSectionList(parsed: unknown): JsonRecord[] {
  if (Array.isArray(parsed)) return parsed.filter((x) => x && typeof x === "object") as JsonRecord[];
  if (!parsed || typeof parsed !== "object") return [];
  const p = parsed as JsonRecord;
  const inner = p.sections ?? p.Sections ?? p.items ?? p.data;
  if (Array.isArray(inner)) return inner.filter((x) => x && typeof x === "object") as JsonRecord[];
  if (inner && typeof inner === "object") return toSectionList(inner);
  if (p.html_content || p.h2_heading || p.html) return [p];
  const keyed = Object.entries(p)
    .filter(([k, v]) => /^(section[_\s-]*)?\d+$/i.test(k) && v && typeof v === "object")
    .map(([k, v]) => ({ section_number: Number(k.replace(/\D/g, "")), ...(v as JsonRecord) }))
    .sort((a, b) => a.section_number - b.section_number);
  return keyed.length ? keyed : [p];
}
