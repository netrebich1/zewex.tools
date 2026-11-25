import { prisma } from "@/lib/db";
import { decryptSecret } from "@/lib/crypto";

/** Telegram Bot API для раздела «Задачи»: один бот на портал, токен в TkSettings (зашифрован). */

export type TgUpdate = {
  update_id: number;
  message?: TgMessage;
  callback_query?: { id: string; from: { id: number; first_name?: string; username?: string }; message?: TgMessage; data?: string };
};
export type TgMessage = {
  message_id: number;
  chat: { id: number; type: string };
  from?: { id: number; first_name?: string; last_name?: string; username?: string };
  text?: string;
  caption?: string;
  voice?: { file_id: string; duration: number; mime_type?: string; file_size?: number };
  audio?: { file_id: string; duration: number; mime_type?: string; file_size?: number; file_name?: string };
  video_note?: { file_id: string; duration: number; file_size?: number };
};

export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export async function tgSettings() {
  return prisma.tkSettings.upsert({ where: { id: "main" }, update: {}, create: { id: "main" } });
}

/** Токен бота (расшифрованный) или null, если бот не настроен. */
export async function botToken(): Promise<string | null> {
  const s = await tgSettings();
  if (!s.botTokenEnc) return null;
  try { return decryptSecret(s.botTokenEnc); } catch { return null; }
}

async function call<T>(token: string, method: string, body: Record<string, unknown>, timeoutMs = 20_000): Promise<{ ok: true; result: T } | { ok: false; error: string }> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
    });
    const j = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: T; description?: string };
    return j.ok ? { ok: true, result: j.result as T } : { ok: false, error: j.description ?? `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export type InlineButton = { text: string; callback_data?: string; url?: string };

export async function tgSend(token: string, chatId: string | number, html: string, buttons?: InlineButton[][]): Promise<{ ok: boolean; error?: string }> {
  // Telegram не принимает сообщения длиннее 4096 символов — режем по строкам.
  const parts: string[] = [];
  let cur = "";
  for (const line of html.split("\n")) {
    if ((cur + "\n" + line).length > 3900) { parts.push(cur); cur = line; } else cur = cur ? `${cur}\n${line}` : line;
  }
  if (cur) parts.push(cur);
  let last: { ok: boolean; error?: string } = { ok: true };
  for (const [i, text] of parts.entries()) {
    const r = await call(token, "sendMessage", { chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true, ...(buttons && i === parts.length - 1 ? { reply_markup: { inline_keyboard: buttons } } : {}) });
    last = r.ok ? { ok: true } : { ok: false, error: r.error };
    if (!r.ok) break;
  }
  return last;
}

export async function tgAnswerCallback(token: string, id: string, text?: string) {
  await call(token, "answerCallbackQuery", { callback_query_id: id, ...(text ? { text } : {}) });
}
export async function tgEditText(token: string, chatId: string | number, messageId: number, html: string, buttons?: InlineButton[][]) {
  return call(token, "editMessageText", { chat_id: chatId, message_id: messageId, text: html, parse_mode: "HTML", disable_web_page_preview: true, reply_markup: { inline_keyboard: buttons ?? [] } });
}

export async function tgGetMe(token: string): Promise<{ ok: true; username: string } | { ok: false; error: string }> {
  const r = await call<{ username?: string }>(token, "getMe", {});
  return r.ok ? { ok: true, username: r.result.username ?? "" } : r;
}

export async function tgGetUpdates(token: string, offset: number, timeoutSec = 20): Promise<{ ok: true; updates: TgUpdate[] } | { ok: false; error: string }> {
  const r = await call<TgUpdate[]>(token, "getUpdates", { offset, timeout: timeoutSec, allowed_updates: ["message", "callback_query"] }, (timeoutSec + 10) * 1000);
  return r.ok ? { ok: true, updates: r.result } : r;
}

/** Скачать файл (голосовое): до 20 МБ по Bot API. */
export async function tgDownload(token: string, fileId: string): Promise<{ ok: true; buf: Buffer; path: string } | { ok: false; error: string }> {
  const f = await call<{ file_path?: string }>(token, "getFile", { file_id: fileId });
  if (!f.ok) return f;
  if (!f.result.file_path) return { ok: false, error: "Telegram не отдал путь к файлу" };
  try {
    const res = await fetch(`https://api.telegram.org/file/bot${token}/${f.result.file_path}`, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) return { ok: false, error: `Скачивание: HTTP ${res.status}` };
    return { ok: true, buf: Buffer.from(await res.arrayBuffer()), path: f.result.file_path };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export function appUrl(path: string): string {
  return `${(process.env.APP_URL || "https://zewex.tools").replace(/\/$/, "")}${path}`;
}
