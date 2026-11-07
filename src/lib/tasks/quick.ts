import { addDays, isMode, todayYmd, type Mode } from "./consts";

/**
 * Быстрый ввод: одна строка → поля задачи. Понимает (в любом месте строки):
 *   `!` или `!!` — приоритет (важно / срочно), `~` — когда-нибудь;
 *   `@Имя` — исполнитель (по началу имени), `#Проект` — проект/направление (по началу имени), `+метка`;
 *   `сегодня`, `завтра`, `послезавтра`, `пн…вс`, `12.11`, `2026-11-12` — план на день;
 *   `до 12.11` / `дедлайн 12.11` — дедлайн;
 *   начало «спросить у Димы …» / «делегировать Саше …» / «поручить …» — способ и кому.
 * Остаток — название. Ничего не выбрасывается молча: нераспознанные слова остаются в названии.
 */
export type QuickParsed = {
  title: string;
  priority: number;
  mode: Mode;
  counterpart: string | null;
  assigneeName: string | null;
  projectName: string | null;
  labels: string[];
  planDate: string | null;
  dueAt: string | null;
};

const WD: Record<string, number> = { пн: 1, вт: 2, ср: 3, чт: 4, пт: 5, сб: 6, вс: 7, понедельник: 1, вторник: 2, среда: 3, четверг: 4, пятница: 5, суббота: 6, воскресенье: 7 };

function parseDay(word: string, today: string): string | null {
  const w = word.toLowerCase();
  if (w === "сегодня") return today;
  if (w === "завтра") return addDays(today, 1);
  if (w === "послезавтра") return addDays(today, 2);
  if (WD[w]) {
    const cur = new Date(`${today}T00:00:00Z`).getUTCDay() || 7;
    const diff = (WD[w] - cur + 7) % 7 || 7;
    return addDays(today, diff);
  }
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(w);
  if (m) return w;
  m = /^(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?$/.exec(w);
  if (m) {
    const y = m[3] ? (m[3].length === 2 ? `20${m[3]}` : m[3]) : today.slice(0, 4);
    const ymd = `${y}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
    // без года и уже прошло — значит, следующий год
    return !m[3] && ymd < today ? `${Number(y) + 1}${ymd.slice(4)}` : ymd;
  }
  return null;
}

export function parseQuick(raw: string, now = new Date()): QuickParsed {
  const today = todayYmd(now);
  const out: QuickParsed = { title: "", priority: 3, mode: "do", counterpart: null, assigneeName: null, projectName: null, labels: [], planDate: null, dueAt: null };
  let text = raw.replace(/\s+/g, " ").trim();

  // Способ: «спросить у X …», «уточнить у X …», «делегировать X …», «поручить X …»
  let m = /^(спросить|уточнить|узнать)\s+(?:у\s+)?([A-Za-zА-Яа-яЁёІіЇїЄє'-]+)\s*[:,—-]?\s*/i.exec(text);
  if (m) { out.mode = "ask"; out.counterpart = m[2]; text = `${m[1]}: ${text.slice(m[0].length)}`; }
  m = /^(делегировать|поручить|передать)\s+([A-Za-zА-Яа-яЁёІіЇїЄє'-]+)\s*[:,—-]?\s*/i.exec(text);
  if (m) { out.mode = "delegate"; out.counterpart = m[2]; text = text.slice(m[0].length); }

  const words = text.split(" ");
  const keep: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (!w) continue;
    if (w === "!!" || w === "!!!") { out.priority = 1; continue; }
    if (w === "!") { out.priority = 2; continue; }
    if (w === "~") { out.priority = 4; continue; }
    if (/^@\S+/.test(w)) { out.assigneeName = w.slice(1).replace(/[,.;:]+$/, ""); continue; }
    if (/^#\S+/.test(w)) { out.projectName = w.slice(1).replace(/[,.;:]+$/, "").replace(/_/g, " "); continue; }
    if (/^\+\S+/.test(w)) { out.labels.push(w.slice(1).replace(/[,.;:]+$/, "").replace(/_/g, " ")); continue; }
    if (/^(до|дедлайн|deadline)$/i.test(w) && words[i + 1]) {
      const d = parseDay(words[i + 1].replace(/[,.;:]+$/, ""), today);
      if (d) { out.dueAt = d; i++; continue; }
    }
    const d = parseDay(w.replace(/[,;:]+$/, ""), today);
    if (d && !/^\d{1,2}$/.test(w)) { out.planDate = d; continue; }
    const mode = w.toLowerCase().replace(/[,.;:]+$/, "");
    if (mode.startsWith("/") && isMode(mode.slice(1))) { out.mode = mode.slice(1) as Mode; continue; }
    keep.push(w);
  }
  out.title = keep.join(" ").trim().replace(/^[-—:]\s*/, "");
  if (!out.title) out.title = raw.trim().slice(0, 300);
  if (out.title.length > 300) out.title = out.title.slice(0, 300);
  return out;
}

/** Совпадение по началу имени без учёта регистра: «ник» → «Никита». */
export function matchByName<T extends { name: string }>(items: T[], q: string | null): T | null {
  if (!q) return null;
  const s = q.toLowerCase();
  return items.find((i) => i.name.toLowerCase() === s) ?? items.find((i) => i.name.toLowerCase().startsWith(s)) ?? items.find((i) => i.name.toLowerCase().includes(s)) ?? null;
}
