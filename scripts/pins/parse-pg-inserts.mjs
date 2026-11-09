/**
 * Разбор дампа вида `INSERT INTO public.<table> VALUES (...) ON CONFLICT DO NOTHING;`
 * (docs/replicate/*.sql из Lovable). Колонок в дампе нет, поэтому вызывающий код
 * передаёт их список и порядок; арность каждой строки проверяется.
 *
 * Значения: 'строка' (с '' как экранированием), NULL, числа, true/false,
 * '{a,b,"c d"}' (text[] → массив), '{"k":1}' / '[...]' (jsonb → объект), даты (строкой).
 */
import { readFileSync } from "fs";

export function parseInsertFile(path, { table, columns }) {
  const text = readFileSync(path, "utf8");
  const rows = [];
  let pos = 0;
  const prefixRe = /INSERT INTO (?:public\.)?"?(\w+)"?\s+VALUES\s*\(/g;
  for (;;) {
    prefixRe.lastIndex = pos;
    const m = prefixRe.exec(text);
    if (!m) break;
    if (table && m[1] !== table) throw new Error(`Ожидалась таблица ${table}, в файле ${m[1]}`);
    let i = m.index + m[0].length;
    const values = [];
    for (;;) {
      i = skipWs(text, i);
      const [val, next] = readValue(text, i);
      values.push(val);
      i = skipWs(text, next);
      if (text[i] === ",") {
        i++;
        continue;
      }
      if (text[i] === ")") {
        i++;
        break;
      }
      throw new Error(`Неожиданный символ «${text[i]}» на позиции ${i}`);
    }
    if (values.length !== columns.length) {
      throw new Error(`${table ?? m[1]}: в строке ${values.length} значений, ожидалось ${columns.length} (${columns.join(", ")})`);
    }
    const row = {};
    columns.forEach((c, k) => (row[c] = values[k]));
    rows.push(row);
    const end = text.indexOf(";", i);
    pos = end === -1 ? text.length : end + 1;
  }
  return rows;
}

function skipWs(t, i) {
  while (i < t.length && /\s/.test(t[i])) i++;
  return i;
}

function readValue(t, i) {
  if (t[i] === "'") {
    let j = i + 1;
    let out = "";
    for (;;) {
      const q = t.indexOf("'", j);
      if (q === -1) throw new Error("Незакрытая строка");
      out += t.slice(j, q);
      if (t[q + 1] === "'") {
        out += "'";
        j = q + 2;
        continue;
      }
      return [coerce(out), q + 1];
    }
  }
  const m = /^(NULL|true|false|-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)/i.exec(t.slice(i, i + 64));
  if (!m) throw new Error(`Не удалось прочитать значение около: ${t.slice(i, i + 40)}`);
  const raw = m[1];
  const next = i + raw.length;
  if (/^null$/i.test(raw)) return [null, next];
  if (/^true$/i.test(raw)) return [true, next];
  if (/^false$/i.test(raw)) return [false, next];
  return [Number(raw), next];
}

/** Строка из дампа: jsonb → объект, text[] → массив, остальное как есть. */
function coerce(s) {
  if (s.length >= 2 && (s[0] === "{" || s[0] === "[")) {
    // jsonb: начинается с {" или [ ; text[]: {a,b} без кавычек-ключей
    if (s[0] === "[" || /^\{\s*"/.test(s) || s === "{}" ) {
      try {
        const v = JSON.parse(s);
        // '{}' одинаково для пустого jsonb и пустого text[] — отдаём объект, вызывающий код решит
        return v;
      } catch {
        /* text[] ниже */
      }
    }
    if (s[0] === "{" && s[s.length - 1] === "}") return parsePgArray(s);
  }
  return s;
}

export function parsePgArray(s) {
  const inner = s.slice(1, -1);
  if (!inner.trim()) return [];
  const out = [];
  let i = 0;
  while (i <= inner.length) {
    if (inner[i] === '"') {
      let j = i + 1;
      let v = "";
      while (j < inner.length && inner[j] !== '"') {
        if (inner[j] === "\\") j++;
        v += inner[j++];
      }
      out.push(v);
      i = j + 1;
      if (inner[i] === ",") i++;
      else if (i >= inner.length) break;
    } else {
      let j = inner.indexOf(",", i);
      if (j === -1) j = inner.length;
      const v = inner.slice(i, j);
      out.push(v === "NULL" ? null : v);
      i = j + 1;
      if (j === inner.length) break;
    }
  }
  return out;
}

/** '{}' из дампа может быть и пустым массивом, и пустым объектом. */
export const asArray = (v) => (Array.isArray(v) ? v : v && typeof v === "object" && !Object.keys(v).length ? [] : v == null ? [] : [String(v)]);
export const asObject = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : Array.isArray(v) && !v.length ? {} : {});
