/**
 * Таблица кластеров с Google Диска для режима «EMD по ключам».
 * Берётся по ссылке: файлу (xlsx или Google Таблице) нужен доступ «Все, у кого есть ссылка — читатель».
 */
import { readXlsx } from "@/lib/xlsxRead";
import { parseEmdRows, type EmdCluster } from "./emd";

export function driveFileId(url: string): string | null {
  const u = url.trim();
  const m = /\/d\/([a-zA-Z0-9_-]{20,})/.exec(u) ?? /[?&]id=([a-zA-Z0-9_-]{20,})/.exec(u);
  if (m) return m[1]!;
  return /^[a-zA-Z0-9_-]{25,}$/.test(u) ? u : null;
}

async function download(url: string): Promise<{ buf: Buffer; name: string } | null> {
  const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(60_000) }).catch(() => null);
  if (!res?.ok) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  // xlsx — zip: начинается с PK. HTML вместо файла — значит, Google просит войти (нет доступа по ссылке)
  if (buf.length < 4 || buf.readUInt32LE(0) !== 0x04034b50) return null;
  const cd = res.headers.get("content-disposition") ?? "";
  const name = decodeURIComponent(/filename\*=UTF-8''([^;]+)/i.exec(cd)?.[1] ?? /filename="([^"]+)"/i.exec(cd)?.[1] ?? "");
  return { buf, name };
}

export type EmdTable = { fileName: string; clusters: Array<EmdCluster & { country: string }>; problems: string[]; rows: number };

/** Скачать таблицу и разобрать кластеры. Бросает понятную ошибку. */
export async function loadEmdTable(url: string): Promise<EmdTable> {
  const id = driveFileId(url);
  if (!id) throw new Error("Не похоже на ссылку Google Диска: нужна ссылка вида docs.google.com/spreadsheets/d/… или drive.google.com/file/d/…");
  const file =
    (await download(`https://docs.google.com/spreadsheets/d/${id}/export?format=xlsx`)) ??
    (await download(`https://drive.google.com/uc?export=download&id=${id}`));
  if (!file) throw new Error("Google не отдал файл. Откройте доступ: «Настройки доступа» → «Все, у кого есть ссылка» → «Читатель», и проверьте ссылку.");
  const sheets = readXlsx(file.buf);
  const sheet = sheets.find((s) => (s.rows[0] ?? []).some((h) => h.trim().toLowerCase() === "original_keyword")) ?? sheets[0];
  if (!sheet || sheet.rows.length < 2) throw new Error("В файле нет листа с данными");
  const { clusters, problems } = parseEmdRows(sheet.rows);
  if (!clusters.length) throw new Error(problems[0] ?? "В таблице не нашлось ни одного кластера");
  return { fileName: file.name || sheet.name, clusters, problems, rows: sheet.rows.length - 1 };
}
