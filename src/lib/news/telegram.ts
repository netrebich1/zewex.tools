/** Алерты модуля в Telegram-бот проекта (sendMessage, HTML). */

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export async function sendTelegram(token: string, chatId: string, html: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: html, parse_mode: "HTML", disable_web_page_preview: false }),
      signal: AbortSignal.timeout(15_000),
    });
    const j = (await res.json().catch(() => ({}))) as { ok?: boolean; description?: string };
    return j.ok ? { ok: true } : { ok: false, error: j.description ?? `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export function alertText(c: { title: string; score: number; category: string | null; sourceCount: number; why: string[]; url: string; link: string }): string {
  return [
    `🔥 <b>${escapeHtml(c.title)}</b>`,
    `Балл ${c.score} · ${escapeHtml(c.category ?? "—")} · ${c.sourceCount} ист.`,
    ...c.why.slice(0, 3).map((w) => `• ${escapeHtml(w)}`),
    c.url ? `Источник: ${escapeHtml(c.url)}` : "",
    `Карточка: ${escapeHtml(c.link)}`,
  ].filter(Boolean).join("\n");
}
