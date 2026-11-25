import { prisma } from "@/lib/db";
import { addDays, fmtDay, todayYmd, ymdToDate } from "./consts";
import { createFromQuick, moveDay, planOn, setStatus } from "./ops";
import { dayView } from "./queries";
import { appUrl, esc, tgAnswerCallback, tgDownload, tgSend, type TgMessage, type TgUpdate } from "./telegram";
import { taskButtons, taskLine } from "./digest";
import { extractItems, transcribe } from "./voice";
import { TASKS } from "./access";

/**
 * Обработка входящих сообщений бота.
 *  /start <код>  — привязка чата к сотруднику (код выдаётся в настройках раздела).
 *  голосовое     — отчёт за день: расшифровка → пункты → TkReport; ответ с пунктами.
 *  текст         — у кого есть доступ к задачам: новая задача (быстрый ввод); у остальных — текстовый отчёт.
 *  /today /tomorrow — план дня; /help.
 *  кнопки        — done:<id>, tmrw:<id>, moveall:<ymd>.
 */

type Linked = { userId: string; name: string; hasTasks: boolean };

async function linkedUser(chatId: number): Promise<Linked | null> {
  const link = await prisma.tkTgLink.findUnique({ where: { chatId: String(chatId) } });
  if (!link) return null;
  const u = await prisma.user.findUnique({ where: { id: link.userId }, select: { id: true, name: true, email: true, isActive: true, toolAccess: { select: { slug: true } } } });
  if (!u || !u.isActive) return null;
  const owners = (process.env.ALLOWED_REGISTRATION_EMAILS ?? "").split(/[,\s]+/).map((e) => e.trim().toLowerCase()).filter(Boolean);
  const hasTasks = owners.includes(u.email.toLowerCase()) || u.toolAccess.some((a) => a.slug === TASKS);
  return { userId: u.id, name: u.name || u.email, hasTasks };
}

const HELP = [
  "<b>Что умеет бот</b>",
  "• 🎤 Голосовое — отчёт за день: расшифрую, выделю пункты «что сделано» и покажу руководителю в разделе «Отчёты».",
  "• ✍️ Текст — новая задача (у кого есть доступ к задачам). Понимаю: <code>!</code> важно, <code>!!</code> срочно, <code>@Имя</code>, <code>#Проект</code>, <code>+метка</code>, «завтра», «пн», «12.11», «до 15.11», «спросить у Димы …», «делегировать Саше …».",
  "• /today — план на сегодня, /tomorrow — на завтра, /report — текстовый отчёт за день (следующее сообщение).",
].join("\n");

export async function handleUpdate(token: string, u: TgUpdate): Promise<void> {
  if (u.callback_query) return handleCallback(token, u.callback_query);
  const m = u.message;
  if (!m || m.chat.type !== "private") return;
  const chatId = m.chat.id;
  const text = (m.text ?? "").trim();

  // Привязка
  if (/^\/start\b/.test(text)) {
    const code = text.split(/\s+/)[1]?.trim();
    if (!code) { await tgSend(token, chatId, "Привет! Чтобы привязать чат, откройте в портале «Задачи → Настройки → Telegram», нажмите «Получить код» и пришлите мне:\n<code>/start КОД</code>"); return; }
    const link = await prisma.tkTgLink.findUnique({ where: { code } });
    if (!link) { await tgSend(token, chatId, "Код не подошёл или уже использован. Возьмите новый в настройках раздела «Задачи»."); return; }
    const tgName = [m.from?.first_name, m.from?.last_name].filter(Boolean).join(" ") + (m.from?.username ? ` (@${m.from.username})` : "");
    // Один чат — один человек: старую привязку этого чата снимаем
    await prisma.tkTgLink.updateMany({ where: { chatId: String(chatId), NOT: { userId: link.userId } }, data: { chatId: null } });
    await prisma.tkTgLink.update({ where: { userId: link.userId }, data: { chatId: String(chatId), code: null, tgName: tgName.trim() || null, linkedAt: new Date() } });
    const who = await linkedUser(chatId);
    await tgSend(token, chatId, `Готово, ${esc(who?.name ?? "")}! Чат привязан.\n\n${HELP}`);
    return;
  }

  const who = await linkedUser(chatId);
  if (!who) { await tgSend(token, chatId, "Этот чат не привязан к сотруднику. Пришлите <code>/start КОД</code> — код выдаёт руководитель в разделе «Задачи → Настройки»."); return; }

  // Голосовое / аудио / кружок — отчёт
  const media = m.voice ?? m.audio ?? m.video_note;
  if (media) return handleVoice(token, m, who, media);

  if (/^\/help\b/.test(text)) { await tgSend(token, chatId, HELP); return; }
  if (/^\/(today|tomorrow)\b/.test(text)) {
    if (!who.hasTasks) { await tgSend(token, chatId, "У вас нет доступа к задачам, но голосовые отчёты я принимаю 🎤"); return; }
    const ymd = text.startsWith("/tomorrow") ? addDays(todayYmd(), 1) : todayYmd();
    await tgSend(token, chatId, await planText(who.userId, ymd));
    return;
  }
  if (/^\/report\b/.test(text)) {
    const body = text.replace(/^\/report\s*/, "");
    if (!body) { await tgSend(token, chatId, "Напишите отчёт одним сообщением после команды: <code>/report сделал то, то и то</code> — или просто пришлите голосовое."); return; }
    await saveReport(token, chatId, who, body, "text", null, null);
    return;
  }
  if (!text || text.startsWith("/")) { await tgSend(token, chatId, HELP); return; }

  // Текст: задача (если есть доступ) или отчёт
  if (!who.hasTasks) { await saveReport(token, chatId, who, text, "text", null, null); return; }
  try {
    const r = await createFromQuick(text, who.userId);
    const p = r.parsed;
    const bits = [p.mode !== "do" ? `${p.mode === "ask" ? "спросить" : "делегировать"}${p.counterpart ? ` · ${esc(p.counterpart)}` : ""}` : "", r.project ? `#${esc(r.project)}` : "", r.assignee ? `→ ${esc(r.assignee)}` : "", p.planDate ? `план: ${fmtDay(p.planDate)}` : "", p.dueAt ? `срок: ${fmtDay(p.dueAt)}` : "", p.priority === 1 ? "🔥 срочно" : p.priority === 2 ? "❗ важно" : p.priority === 4 ? "когда-нибудь" : ""].filter(Boolean);
    const warn = r.unknown.length ? `\n<i>Не нашёл: ${r.unknown.map(esc).join(", ")} — оставил в названии/по умолчанию.</i>` : "";
    await tgSend(token, chatId, `➕ <a href="${appUrl(`/tasks/t/${r.id}`)}">${esc(r.title)}</a>${bits.length ? `\n${bits.join(" · ")}` : ""}${warn}`, [[{ text: "На сегодня", callback_data: `today:${r.id}` }, { text: "→ Завтра", callback_data: `tmrw:${r.id}` }, { text: "Открыть", url: appUrl(`/tasks/t/${r.id}`) }]]);
  } catch (e) {
    await tgSend(token, chatId, `Не получилось создать задачу: ${esc(e instanceof Error ? e.message : String(e))}`);
  }
}

async function planText(userId: string, ymd: string): Promise<string> {
  const v = await dayView(ymd, userId);
  const lines = [`<b>План на ${fmtDay(ymd)}</b>`];
  if (!v.planned.length && !v.due.length && !v.overdue.length) lines.push("Пусто. Отдыхайте или напишите мне задачу текстом.");
  v.planned.forEach((t, i) => lines.push(`${i + 1}. ${taskLine(t, { due: true })}`));
  if (v.due.length) { lines.push("", "<b>Срок в этот день</b>"); v.due.forEach((t) => lines.push(`• ${taskLine(t)}`)); }
  if (v.overdue.length) { lines.push("", `<b>Просрочено (${v.overdue.length})</b>`); v.overdue.slice(0, 10).forEach((t) => lines.push(`• ${taskLine(t, { due: true })}`)); }
  if (v.waiting.length) { lines.push("", `<b>Пора пнуть (${v.waiting.length})</b>`); v.waiting.forEach((t) => lines.push(`• ${taskLine(t, { wait: true })}`)); }
  return lines.join("\n");
}

async function handleVoice(token: string, m: TgMessage, who: Linked, media: { file_id: string; duration: number; mime_type?: string; file_size?: number }) {
  const chatId = m.chat.id;
  if ((media.file_size ?? 0) > 19 * 1024 * 1024) { await tgSend(token, chatId, "Файл больше 20 МБ — Telegram не отдаёт такие ботам. Запишите покороче."); return; }
  if (media.duration > 15 * 60) { await tgSend(token, chatId, "Голосовое длиннее 15 минут — разбейте, пожалуйста, на части."); return; }
  const f = await tgDownload(token, media.file_id);
  if (!f.ok) { await tgSend(token, chatId, `Не смог скачать голосовое: ${esc(f.error)}`); return; }
  const ext = f.path.split(".").pop() || "ogg";
  const mime = media.mime_type || (ext === "mp4" ? "video/mp4" : "audio/ogg");
  const t = await transcribe(who.userId, f.buf, `voice.${ext}`, mime, media.duration);
  if (!t.ok) { await tgSend(token, chatId, `${esc(t.error)}\n\nРуководителю: проверьте правило ключа для слота «Расшифровка голосовых» проекта «Задачи».`); return; }
  if (!t.text) { await tgSend(token, chatId, "Расшифровка пустая — ничего не услышал. Попробуйте ещё раз."); return; }
  await saveReport(token, chatId, who, t.text, "voice", media.duration, t.costUsd);
}

async function saveReport(token: string, chatId: number, who: Linked, transcript: string, source: "voice" | "text", audioSec: number | null, cost: number | null) {
  const ex = await extractItems(who.userId, transcript);
  const date = ymdToDate(todayYmd());
  const r = await prisma.tkReport.create({ data: { userId: who.userId, date, source, transcript, items: ex.items, audioSec, costUsd: (cost ?? 0) + ex.costUsd || null } });
  const lines = [`📝 <b>Отчёт за ${fmtDay(todayYmd())} записан</b>`, "", ...ex.items.map((i) => `• ${esc(i)}`)];
  if (source === "voice") lines.push("", `<i>Расшифровка:</i> ${esc(transcript.length > 700 ? transcript.slice(0, 700) + "…" : transcript)}`);
  lines.push("", `<a href="${appUrl(`/tasks/reports?d=${todayYmd()}`)}">Открыть в разделе «Отчёты»</a>`);
  await tgSend(token, chatId, lines.join("\n"), [[{ text: "✕ Удалить этот отчёт", callback_data: `delrep:${r.id}` }]]);
}

async function handleCallback(token: string, q: NonNullable<TgUpdate["callback_query"]>) {
  const chatId = q.message?.chat.id;
  const [cmd, arg] = (q.data ?? "").split(":");
  if (!chatId) { await tgAnswerCallback(token, q.id); return; }
  const who = await linkedUser(chatId);
  if (!who) { await tgAnswerCallback(token, q.id, "Чат не привязан"); return; }
  try {
    if (cmd === "done" && arg) { await setStatus(arg, "done", who.userId); await tgAnswerCallback(token, q.id, "Готово ✓"); await tgSend(token, chatId, `✓ Закрыто: <a href="${appUrl(`/tasks/t/${arg}`)}">${esc((await prisma.tkTask.findUnique({ where: { id: arg }, select: { title: true } }))?.title ?? "")}</a>`); return; }
    if (cmd === "tmrw" && arg) { await planOn(arg, addDays(todayYmd(), 1), who.userId); await tgAnswerCallback(token, q.id, "Перенесено на завтра"); return; }
    if (cmd === "today" && arg) { await planOn(arg, todayYmd(), who.userId); await tgAnswerCallback(token, q.id, "В плане на сегодня"); return; }
    if (cmd === "moveall" && arg) { const n = await moveDay(arg, addDays(arg, 1), who.userId, who.userId); await tgAnswerCallback(token, q.id, n ? `Перенесено: ${n}` : "Нечего переносить"); if (n) await tgSend(token, chatId, `→ Перенесено на завтра: ${n}`); return; }
    if (cmd === "delrep" && arg) { await prisma.tkReport.deleteMany({ where: { id: arg, userId: who.userId } }); await tgAnswerCallback(token, q.id, "Отчёт удалён"); return; }
    await tgAnswerCallback(token, q.id);
  } catch (e) {
    await tgAnswerCallback(token, q.id, (e instanceof Error ? e.message : String(e)).slice(0, 180));
  }
}

export { taskButtons };
