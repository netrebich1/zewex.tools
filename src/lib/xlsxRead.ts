/**
 * Минимальное чтение XLSX без зависимостей: zip разбирается вручную (inflate из zlib), листы — регулярками.
 * Отдаёт все листы как массивы строк (текст ячеек). Формулы не считаются — берётся сохранённое значение.
 */
import { inflateRawSync } from "zlib";

function unzip(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  // Конец центрального каталога: ищем подпись с конца (после неё может идти комментарий до 64 КБ)
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("Файл не похож на XLSX (не zip)");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    p += 46 + nameLen + extraLen + commentLen;
    if (buf.readUInt32LE(local) !== 0x04034b50) continue;
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + compSize);
    if (method === 0) out.set(name, Buffer.from(data));
    else if (method === 8) out.set(name, inflateRawSync(data));
  }
  return out;
}

const unescapeXml = (s: string) =>
  s.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-f]+);/gi, (_, e: string) => {
    const k = e.toLowerCase();
    if (k === "lt") return "<";
    if (k === "gt") return ">";
    if (k === "amp") return "&";
    if (k === "quot") return '"';
    if (k === "apos") return "'";
    return String.fromCodePoint(k.startsWith("#x") ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10));
  });

/** Весь текст внутри <t>…</t> (у строк с форматированием их несколько). */
const textOf = (xml: string) => Array.from(xml.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g), (m) => unescapeXml(m[1] ?? "")).join("");

function colIndex(ref: string): number {
  const letters = /^[A-Z]+/.exec(ref)?.[0] ?? "A";
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

export type XlsxSheet = { name: string; rows: string[][] };

export function readXlsx(buf: Buffer): XlsxSheet[] {
  const files = unzip(buf);
  const shared = Array.from((files.get("xl/sharedStrings.xml")?.toString("utf8") ?? "").matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g), (m) => textOf(m[1] ?? ""));
  // Порядок и имена листов — из workbook.xml и его связей
  const wb = files.get("xl/workbook.xml")?.toString("utf8") ?? "";
  const rels = files.get("xl/_rels/workbook.xml.rels")?.toString("utf8") ?? "";
  const target = new Map(Array.from(rels.matchAll(/<Relationship\b[^>]*>/g), (m) => [/Id="([^"]+)"/.exec(m[0])?.[1] ?? "", /Target="([^"]+)"/.exec(m[0])?.[1] ?? ""]));
  const sheets: Array<{ name: string; path: string }> = Array.from(wb.matchAll(/<sheet\b[^>]*>/g), (m) => {
    const name = unescapeXml(/name="([^"]*)"/.exec(m[0])?.[1] ?? "");
    const rid = /r:id="([^"]+)"/.exec(m[0])?.[1] ?? "";
    const t = (target.get(rid) ?? "").replace(/^\/?xl\//, "").replace(/^\//, "");
    return { name, path: t ? `xl/${t}` : "" };
  }).filter((s) => s.path && files.has(s.path));
  if (!sheets.length) for (const k of files.keys()) if (/^xl\/worksheets\/sheet\d+\.xml$/.test(k)) sheets.push({ name: k, path: k });

  return sheets.map(({ name, path }) => {
    const xml = files.get(path)!.toString("utf8");
    const rows: string[][] = [];
    for (const rm of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
      const rowNum = Number(/\br="(\d+)"/.exec(rm[1] ?? "")?.[1] ?? rows.length + 1);
      const row: string[] = [];
      for (const cm of (rm[2] ?? "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = cm[1] ?? "";
        const body = cm[2] ?? "";
        const ref = /\br="([A-Z]+)\d*"/.exec(attrs)?.[1];
        const idx = ref ? colIndex(ref) : row.length;
        const type = /\bt="([^"]+)"/.exec(attrs)?.[1];
        const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
        let value = "";
        if (type === "s") value = shared[Number(v)] ?? "";
        else if (type === "inlineStr") value = textOf(body);
        else if (type === "b") value = v === "1" ? "TRUE" : "FALSE";
        else value = v !== undefined ? unescapeXml(v) : "";
        row[idx] = value;
      }
      rows[rowNum - 1] = Array.from(row, (x) => x ?? "");
    }
    return { name, rows: Array.from(rows, (r) => r ?? []) };
  });
}
