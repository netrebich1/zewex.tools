import { prisma } from "@/lib/db";
import { decryptSecret } from "@/lib/crypto";
import { resolveSlot, runSlot } from "@/lib/run";
import { TASKS } from "./access";

/**
 * Голосовой отчёт: аудио → текст (слот `transcribe`, OpenAI audio/transcriptions) → пункты «что сделано» (слот `text`).
 * Расход пишется в UsageLog как у остальных инструментов. Ключи — правила проекта `tasks` на странице проекта.
 */

export type Transcribed = { ok: true; text: string; costUsd: number | null; model: string } | { ok: false; error: string };

function joinUrl(base: string, path: string) { return `${base.replace(/\/$/, "")}/${path.replace(/^\//, "")}`; }

export async function transcribe(userId: string, audio: Buffer, filename: string, mime: string, durationSec: number): Promise<Transcribed> {
  const r = await resolveSlot(userId, TASKS, "transcribe");
  if (!r.ok) return { ok: false, error: r.error };
  const b = r.value.binding;
  const modelId = b.model?.modelId || "gpt-4o-mini-transcribe";
  const keyRow = await prisma.apiKey.findUniqueOrThrow({ where: { id: b.apiKey.id }, select: { secretEnc: true } });
  const secret = decryptSecret(keyRow.secretEnc);
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(audio)], { type: mime }), filename);
  form.append("model", modelId);
  form.append("response_format", "json");
  form.append("language", "ru");
  form.append("prompt", "Отчёт сотрудника о сделанной работе. Pinterest, WordPress, статьи, пины, домены, ключи, сайты, Wexora, Zewex.");
  const started = Date.now();
  let ok = false, text = "", error: string | null = null, inputTokens = 0, outputTokens = 0, status = 0;
  try {
    const res = await fetch(joinUrl(b.provider.baseUrl, "audio/transcriptions"), { method: "POST", headers: { Authorization: `Bearer ${secret}` }, body: form, signal: AbortSignal.timeout(180_000) });
    status = res.status;
    const data = (await res.json().catch(() => ({}))) as { text?: string; usage?: { input_tokens?: number; output_tokens?: number; seconds?: number }; error?: { message?: string } };
    if (res.ok && typeof data.text === "string") {
      ok = true; text = data.text.trim();
      inputTokens = data.usage?.input_tokens ?? 0; outputTokens = data.usage?.output_tokens ?? 0;
    } else error = data.error?.message ?? `HTTP ${res.status}`;
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  // Цена: по токенам (gpt-4o-*-transcribe отдаёт usage), иначе по минутам ($0.006/мин — тариф whisper-1).
  let costUsd: number | null = null;
  if (ok) {
    if (inputTokens || outputTokens) costUsd = (inputTokens * (b.model?.inputPrice ?? 1.25) + outputTokens * (b.model?.outputPrice ?? 5)) / 1_000_000;
    else costUsd = Math.round((durationSec / 60) * 0.006 * 10000) / 10000;
  }
  await prisma.usageLog.create({
    data: {
      userId, projectId: r.value.project.id, slotId: r.value.slot.id, providerId: b.provider.id, modelId: b.model?.id || null, apiKeyId: b.apiKey.id, scope: b.scope,
      inputTokens, outputTokens, units: Math.max(1, Math.round(durationSec)), costUsd, durationMs: Date.now() - started, ok, error: error?.slice(0, 2000) ?? null, refId: "voice-report",
    },
  });
  if (!ok) return { ok: false, error: `Расшифровка не удалась (${status || "сеть"}): ${error}` };
  return { ok: true, text, costUsd, model: modelId };
}

/** Из расшифровки — короткие пункты «что сделано». Если слот `text` не настроен — режем текст по предложениям. */
export async function extractItems(userId: string, transcript: string): Promise<{ items: string[]; costUsd: number }> {
  const fallback = () => transcript.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter((s) => s.length > 3).slice(0, 20);
  const r = await resolveSlot(userId, TASKS, "text");
  if (!r.ok) return { items: fallback(), costUsd: 0 };
  const res = await runSlot({
    userId, projectSlug: TASKS, slotKey: "text", pre: r.value, timeoutMs: 60_000, meta: { refId: "voice-report" },
    payload: {
      messages: [
        { role: "system", content: "Ты помощник руководителя. Из устного отчёта сотрудника о работе за день выдели конкретные сделанные дела. Ответ — только JSON вида {\"items\":[\"...\"]}: каждый пункт — одно законченное дело, 3–12 слов, по-русски, без воды и повторов, глагол в прошедшем времени (\"Залил 40 пинов на сайт X\"). Планы и проблемы тоже включай отдельными пунктами с пометкой «План:» или «Проблема:». Не выдумывай ничего, чего нет в тексте." },
        { role: "user", content: transcript.slice(0, 12_000) },
      ],
      temperature: 0.2,
      response_format: { type: "json_object" },
    },
  });
  if (!res.ok) return { items: fallback(), costUsd: 0 };
  try {
    const content = (res.data as { choices?: { message?: { content?: string } }[] }).choices?.[0]?.message?.content ?? "";
    const j = JSON.parse(content.replace(/^```(?:json)?\s*|\s*```$/g, "")) as { items?: unknown };
    const items = Array.isArray(j.items) ? j.items.map((x) => String(x).trim()).filter(Boolean).slice(0, 30) : [];
    return { items: items.length ? items : fallback(), costUsd: res.meta?.costUsd ?? 0 };
  } catch {
    return { items: fallback(), costUsd: res.meta?.costUsd ?? 0 };
  }
}
