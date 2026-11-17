/**
 * Классификация ошибок провайдеров ИИ.
 *  transient  — повторить позже (429, 5xx, таймаут, сеть)
 *  permanent  — этот элемент не получится (safety, 400); ждёт ручного «перегенерировать»
 *  fatal_run  — дальше нет смысла (нет кредитов, плохой ключ); прогон блокируется
 */
export type ErrKind = "transient" | "permanent" | "fatal_run";
export type ClassifiedError = { code: string; kind: ErrKind; message: string };

export function classifyAiError(status: number, message: string): ClassifiedError {
  const m = (message || "").toLowerCase();
  const msg = (message || `HTTP ${status}`).slice(0, 500);
  // Баланс раньше авторизации: laozhang отвечает на исчерпанную квоту 403 «配额不足».
  if (status === 402 || /insufficient_quota|insufficient credits|no credits|exceeded your current quota|billing hard limit|payment required|balance is insufficient|not enough balance|配额不足|余额不足/.test(m)) {
    return { code: "no_credits", kind: "fatal_run", message: msg };
  }
  if (status === 401 || status === 403 || /invalid api key|incorrect api key|unauthorized|authentication/.test(m)) {
    return { code: "auth", kind: "fatal_run", message: msg };
  }
  if (/safety|content_policy|content policy|moderation_blocked|flagged|rejected by the safety/.test(m)) {
    return { code: "safety", kind: "permanent", message: msg };
  }
  if (status === 429 || /rate limit|rate_limit|too many requests|overloaded|capacity/.test(m)) {
    return { code: "rate_limited", kind: "transient", message: msg };
  }
  if (status === 408 || status === 0 || status >= 500 || /timeout|timed out|fetch failed|econnreset|socket hang up|network|aborted/.test(m)) {
    return { code: status >= 500 ? "server_error" : "network", kind: "transient", message: msg };
  }
  if (status === 400 || status === 404 || status === 422) {
    return { code: "bad_request", kind: "permanent", message: msg };
  }
  return { code: "unknown", kind: "transient", message: msg };
}

export class AiError extends Error {
  constructor(public readonly cls: ClassifiedError, public readonly status: number) {
    super(cls.message);
    this.name = "AiError";
  }
}

/** Повторы пина при «rate limit»: до 10 попыток, пауза растёт линейно 1, 2, … 10 минут (с джиттером ±25 %). */
export const RATE_LIMIT_MAX_ATTEMPTS = 10;
export function rateLimitDelayMs(attempt: number): number {
  const minutes = Math.min(10, Math.max(1, attempt));
  return Math.round(minutes * 60_000 * (0.75 + Math.random() * 0.5));
}

/** Пауза перед повтором: 2с·2^n с джиттером, не больше 60 с. */
export function backoffMs(attempt: number): number {
  const base = Math.min(60_000, 2_000 * 2 ** Math.max(0, attempt));
  return Math.round(base * (0.75 + Math.random() * 0.5));
}
