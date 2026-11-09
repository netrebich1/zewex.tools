import { prisma } from "@/lib/db";
import { addDays, fmtDay, modeLabel, todayYmd, ymdToDate } from "./consts";
import { dayView, type TaskRow } from "./queries";
import { appUrl, esc, tgSend, type InlineButton } from "./telegram";

/** Утренний и вечерний дайджесты в Telegram каждому привязанному человеку с доступом к задачам. */

const PRI = ["", "🔥 ", "❗ ", "", "〰 "];
export function taskLine(t: TaskRow, opts: { due?: boolean; wait?: boolean } = {}): string {
  const bits: string[] = [];
  if (t.mode !== "do") bits.push(`${modeLabel(t.mode)}${t.counterpart ? ` · ${esc(t.counterpart)}` : ""}`);
  if (t.project) bits.push(esc(t.project));
  if (opts.due && t.dueAt) bits.push(`срок ${fmtDay(t.dueAt)}`);
  if (opts.wait && t.waitUntil) bits.push(`ждём с ${fmtDay(t.waitUntil)}`);
  return `${PRI[t.priority] ?? ""}<a href="${appUrl(`/tasks/t/${t.id}`)}">${esc(t.title)}</a>${bits.length ? ` <i>— ${bits.join(" · ")}</i>` : ""}`;
}

export function taskButtons(t: TaskRow): InlineButton[] {
  return [{ text: "✓ Готово", callback_data: `done:${t.id}` }, { text: "→ Завтра", callback_data: `tmrw:${t.id}` }, { text: "Открыть", url: appUrl(`/tasks/t/${t.id}`) }];
}

export async function morningText(userId: string, name: string): Promise<string | null> {
  const today = todayYmd();
  const v = await dayView(today, userId);
  if (!v.planned.length && !v.overdue.length && !v.due.length && !v.waiting.length) return null;
  const lines = [`☀️ <b>Доброе утро, ${esc(name)}!</b> ${fmtDay(today)}, план на день:`];
  if (v.planned.length) { lines.push(""); lines.push(`<b>На сегодня (${v.planned.length})</b>`); v.planned.forEach((t, i) => lines.push(`${i + 1}. ${taskLine(t, { due: true })}`)); }
  if (v.due.length) { lines.push(""); lines.push(`<b>Срок сегодня, но не в плане (${v.due.length})</b>`); v.due.forEach((t) => lines.push(`• ${taskLine(t)}`)); }
  if (v.overdue.length) { lines.push(""); lines.push(`<b>Просрочено (${v.overdue.length})</b>`); v.overdue.slice(0, 10).forEach((t) => lines.push(`• ${taskLine(t, { due: true })}`)); if (v.overdue.length > 10) lines.push(`… и ещё ${v.overdue.length - 10}`); }
  if (v.waiting.length) { lines.push(""); lines.push(`<b>Пора пнуть (${v.waiting.length})</b>`); v.waiting.forEach((t) => lines.push(`• ${taskLine(t, { wait: true })}`)); }
  lines.push("", `<a href="${appUrl("/tasks/today")}">Открыть «Сегодня»</a>`);
  return lines.join("\n");
}

export async function eveningText(userId: string, name: string): Promise<string | null> {
  const today = todayYmd();
  const v = await dayView(today, userId);
  const left = [...v.planned, ...v.due].filter((t) => t.status !== "done");
  if (!v.doneToday.length && !left.length) return null;
  const lines = [`🌙 <b>${esc(name)}, итог дня</b> (${fmtDay(today)})`];
  if (v.doneToday.length) { lines.push("", `<b>Сделано (${v.doneToday.length})</b>`); v.doneToday.forEach((t) => lines.push(`✓ ${esc(t.title)}`)); }
  if (left.length) { lines.push("", `<b>Не закрыто (${left.length})</b>`); left.forEach((t) => lines.push(`• ${taskLine(t)}`)); }
  const tomorrow = await dayView(addDays(today, 1), userId);
  if (tomorrow.planned.length) { lines.push("", `<b>Уже в плане на завтра (${tomorrow.planned.length})</b>`); tomorrow.planned.slice(0, 8).forEach((t) => lines.push(`• ${esc(t.title)}`)); }
  return lines.join("\n");
}

/** Кому слать дайджесты: привязанные чаты людей с доступом к инструменту. */
async function recipients(kind: "morning" | "evening") {
  const links = await prisma.tkTgLink.findMany({ where: { chatId: { not: null }, ...(kind === "morning" ? { morning: true } : { evening: true }) } });
  if (!links.length) return [];
  const users = await prisma.user.findMany({ where: { id: { in: links.map((l) => l.userId) }, isActive: true }, select: { id: true, name: true, email: true } });
  return links.map((l) => ({ userId: l.userId, chatId: l.chatId!, name: users.find((u) => u.id === l.userId)?.name || users.find((u) => u.id === l.userId)?.email || "коллега" })).filter((r) => users.some((u) => u.id === r.userId));
}

export async function sendDigest(token: string, kind: "morning" | "evening"): Promise<{ sent: number; errors: string[] }> {
  const rs = await recipients(kind);
  let sent = 0; const errors: string[] = [];
  for (const r of rs) {
    const text = kind === "morning" ? await morningText(r.userId, r.name) : await eveningText(r.userId, r.name);
    if (!text) continue;
    const buttons: InlineButton[][] = kind === "evening" ? [[{ text: "Перенести незакрытое на завтра", callback_data: `moveall:${todayYmd()}` }, { text: "Открыть", url: appUrl("/tasks/today") }]] : [[{ text: "Открыть «Сегодня»", url: appUrl("/tasks/today") }]];
    const res = await tgSend(token, r.chatId, text, buttons);
    if (res.ok) sent++; else errors.push(`${r.name}: ${res.error}`);
  }
  return { sent, errors };
}

/** Мгновенное уведомление человеку (если привязан): назначили задачу, упомянули и т.п. */
export async function notifyUser(userId: string, html: string, buttons?: InlineButton[][]): Promise<void> {
  const [link, s] = await Promise.all([prisma.tkTgLink.findUnique({ where: { userId } }), prisma.tkSettings.findUnique({ where: { id: "main" } })]);
  if (!link?.chatId || !s?.botTokenEnc) return;
  const { decryptSecret } = await import("@/lib/crypto");
  let token: string;
  try { token = decryptSecret(s.botTokenEnc); } catch { return; }
  await tgSend(token, link.chatId, html, buttons);
}

export { ymdToDate };
