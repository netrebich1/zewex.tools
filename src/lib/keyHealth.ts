import { prisma } from "./db";
import { decryptSecret } from "./crypto";
import { checkKey, runProvider } from "./adapters";
import { classifyAiError } from "./pins/ai/errors";

/**
 * Автопроверка ключей (воркер, раз в 10 мин): ключ, который портал выключил сам (`disableKey`: нет баланса / отклонён),
 * снова включается, если провайдер опять принимает запросы. Выключенные вручную не трогаются.
 *
 * Для чатовых провайдеров список моделей (`checkKey`) отвечает и при нулевом балансе, поэтому проверка — настоящий
 * запрос на несколько токенов моделью провайдера по умолчанию (доли цента). DataForSEO/SerpApi отдают баланс в `checkKey`.
 */

export type Probe = { ok: boolean; note: string; /** false — ответ не говорит ни о ключе, ни о балансе (сеть, 5xx, 400 модели) */ conclusive: boolean };

const AUTO_DISABLED = /^Автоотключён/;

export async function probeKey(apiKeyId: string): Promise<Probe> {
  const key = await prisma.apiKey.findUnique({ where: { id: apiKeyId }, include: { provider: true } });
  if (!key) return { ok: false, note: "Ключ не найден", conclusive: true };
  const p = key.provider;
  const secret = decryptSecret(key.secretEnc);
  if (p.adapter !== "OPENAI_COMPAT") {
    const c = await checkKey(p, secret);
    return { ...c, conclusive: true };
  }
  const model = p.defaultChatModel
    ?? (await prisma.model.findFirst({ where: { providerId: p.id, isEnabled: true, capabilities: { contains: "CHAT" } }, orderBy: { createdAt: "asc" } }))?.modelId;
  if (!model) return { ok: false, note: "Нет модели для проверки", conclusive: false };
  const r = await runProvider(p, secret, { kind: "chat", model, body: { messages: [{ role: "user", content: "ping" }], max_tokens: 16 } }, { timeoutMs: 45_000 });
  if (r.ok) return { ok: true, note: `Ключ работает (проверочный запрос моделью ${model})`, conclusive: true };
  const cls = classifyAiError(r.status, r.error ?? "");
  return { ok: false, note: cls.message, conclusive: cls.kind === "fatal_run" };
}

/**
 * Подтверждение отказа перед выключением ключа (2026-10-24): провайдер ответил «нет денег» / «ключ отклонён» —
 * сначала проверочный запрос. Прошёл — это разовый сбой провайдера, ключ не выключаем. Один результат на ключ
 * держится 60 с, чтобы 15 параллельных картинок с одной ошибкой не сделали 15 проверок.
 */
const confirmCache = new Map<string, { at: number; p: Promise<Probe> }>();
export function confirmKeyFailure(apiKeyId: string): Promise<Probe> {
  const hit = confirmCache.get(apiKeyId);
  if (hit && Date.now() - hit.at < 60_000) return hit.p;
  const p = probeKey(apiKeyId).catch((e) => ({ ok: false, note: e instanceof Error ? e.message : String(e), conclusive: false }));
  confirmCache.set(apiKeyId, { at: Date.now(), p });
  return p;
}

/**
 * Провайдер подтвердил «нет денег»: ручной остаток ключа (вписанная сумма минус расход по журналу) ставится в $0,
 * иначе шапка и оценка прогона показывают деньги, которых нет (ключ alexandrzewex: портал считал $8.86, у OpenAI $0).
 */
export async function zeroManualBalance(apiKeyId: string): Promise<void> {
  await prisma.apiKey.updateMany({ where: { id: apiKeyId, balanceUsd: { not: null } }, data: { balanceUsd: 0, balanceAt: new Date() } });
}

/** Ключ снова работает после «нет денег»: его пополнили на неизвестную сумму — нулевой ручной остаток убираем, его нужно вписать заново. */
export async function clearZeroBalanceAfterHeal(apiKeyId: string): Promise<void> {
  await prisma.apiKey.updateMany({ where: { id: apiKeyId, balanceUsd: 0 }, data: { balanceUsd: null, balanceAt: null } });
}

/** Проверки одного прохода: один запрос на ключ, сколько бы прогонов на нём ни висело. */
export function probeCache(): (apiKeyId: string) => Promise<Probe> {
  const seen = new Map<string, Promise<Probe>>();
  return (id) => {
    let p = seen.get(id);
    if (!p) seen.set(id, (p = probeKey(id).catch((e) => ({ ok: false, note: e instanceof Error ? e.message : String(e), conclusive: false }))));
    return p;
  };
}

/** Включить обратно автоотключённые ключи, которые снова работают. */
export async function reenableHealedKeys(probe = probeCache()): Promise<{ checked: number; enabled: string[] }> {
  const keys = await prisma.apiKey.findMany({ where: { status: "DISABLED" }, select: { id: true, label: true, lastCheckNote: true } });
  const auto = keys.filter((k) => AUTO_DISABLED.test(k.lastCheckNote ?? ""));
  const enabled: string[] = [];
  for (const k of auto) {
    const r = await probe(k.id);
    if (r.ok) {
      // Только если ключ всё ещё автоотключён (его могли выключить вручную, пока шла проверка).
      const u = await prisma.apiKey.updateMany({
        where: { id: k.id, status: "DISABLED", lastCheckNote: { startsWith: "Автоотключён" } },
        data: { status: "ACTIVE", lastCheckedAt: new Date(), lastCheckOk: true, lastCheckNote: `Автовключён после проверки: ${r.note}`.slice(0, 500) },
      });
      if (u.count) {
        enabled.push(k.label);
        await clearZeroBalanceAfterHeal(k.id);
      }
    } else if (r.conclusive) {
      // Причину оставляем «Автоотключён: …», чтобы следующий проход проверил ключ снова; время — последней проверки.
      await prisma.apiKey.updateMany({ where: { id: k.id, status: "DISABLED" }, data: { lastCheckedAt: new Date() } });
    }
  }
  return { checked: auto.length, enabled };
}
