/**
 * Классы сбоев статьи и политика повторов раннера (аудит устойчивости 2026-10-14: stability §1.4, §2.1, §2.2, §2.9).
 *
 *  - transient — 429 / 5xx / таймаут / сеть / короткий сбой базы: повтор с растущей паузой 30 с → 15 мин,
 *    8 повторов ≈ 1 час ожидания, затем FAILED;
 *  - malformed — модель ответила не в том формате, хотя этап уже переспросил её 2–3 раза с поправкой:
 *    отложенный повтор этапа (2 / 5 / 15 мин), после 3 таких повторов — FAILED;
 *  - key — нет средств на ключе, ключ отклонён или выключен, нет правила ключа: статья НЕ падает, а ждёт в очереди
 *    (PENDING, проверка через 10 → 15 → 30 мин) и продолжает сама, когда ключ снова работает; сдаёмся через 7 дней;
 *  - planned — этап сам попросил повтор (retryInMs без вида): потолок по этапу (поиск, медиатека WordPress…);
 *  - fatal — без человека дальше нельзя.
 *
 * Счётчики повторов не хранятся в отдельной колонке: раннер считает их по журналу этапов (ArtStageLog.details.retry)
 * с последней границы — успешный этап, окончательная ошибка или остановка (worker/articles/journal.ts retryStreak).
 */
import { AiError } from "@/lib/pins/ai/errors";

/** Ответ модели не той структуры (не JSON, нет нужного ключа, пустой список) после всех повторов внутри этапа. */
export class MalformedAiOutput extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MalformedAiOutput";
  }
}

export type RetryKind = "transient" | "malformed" | "key" | "planned";
export type FailureKind = RetryKind | "fatal";

export type Classified = {
  kind: FailureKind;
  /** Короткий код для сигнатуры: rate_limited, server_error, network, db, no_credits, auth, no_binding, malformed … */
  code: string;
  /** Короткая понятная причина по-русски (для заметки статьи и журнала ошибок) */
  human: string;
  /** Исходный текст ошибки (обрезанный) */
  detail: string;
};

/** Ошибки Prisma/MariaDB, которые проходят сами за секунды: база перезапускается, соединение оборвалось, блокировка. */
const DB_TRANSIENT_CODES = new Set(["P1001", "P1002", "P1008", "P1011", "P1017", "P2024", "P2028", "P2034"]);
const DB_TRANSIENT_RE =
  /can't reach database server|server has closed the connection|connection (?:lost|closed|reset|refused)|lock wait timeout|deadlock|too many connections|timed out fetching a new connection|transaction already closed|transaction api error|connection pool timeout|\bP10(?:01|02|08|11|17)\b|\bP20(?:24|28|34)\b/i;
const NET_TRANSIENT_RE = /timeout|timed out|fetch failed|econnreset|econnrefused|socket hang up|etimedout|eai_again|other side closed|und_err/i;

export function isDbTransient(err: unknown): boolean {
  const e = err as { code?: unknown; errorCode?: unknown; message?: unknown } | null;
  const code = String(e?.code ?? e?.errorCode ?? "");
  if (DB_TRANSIENT_CODES.has(code)) return true;
  return DB_TRANSIENT_RE.test(String(e?.message ?? err ?? ""));
}

/** Временная ли ошибка (для мест вне этапов: переходы раннера, запись в базу). */
export function isTransientError(err: unknown): boolean {
  if (err instanceof AiError) return err.cls.kind === "transient";
  if (isDbTransient(err)) return true;
  return NET_TRANSIENT_RE.test(err instanceof Error ? err.message : String(err));
}

const KEY_HUMAN: Record<string, string> = {
  no_credits: "Нет средств на ключе",
  month_limit: "Ключ исчерпал месячный лимит",
  auth: "Ключ отклонён провайдером",
  no_binding: "Не настроен ключ",
  resolve: "Не настроен ключ",
  config: "Правило ключа настроено не полностью",
};

/** Классификация исключения, брошенного этапом. Остановку и потерю аренды раннер обрабатывает раньше. */
export function classifyFailure(err: unknown): Classified {
  const msg = err instanceof Error ? err.message : String(err);
  const detail = msg.slice(0, 600);
  if (err instanceof MalformedAiOutput) return { kind: "malformed", code: "malformed", human: "Ответ модели не в том формате", detail };
  if (err instanceof AiError) {
    const where = providerOf(err);
    if (err.cls.kind === "fatal_run") {
      const label = keyLabelOf(err);
      const base = KEY_HUMAN[err.cls.code] ?? "Ключ недоступен";
      return { kind: "key", code: err.cls.code, human: `${base}${label ? ` «${label}»` : ""}${where ? ` (${where})` : ""}`, detail };
    }
    if (err.cls.kind === "transient") {
      const human =
        err.cls.code === "rate_limited" ? `${err.status === 429 ? "429" : "лимит запросов"}${where ? ` от ${where}` : ""}`
        : err.cls.code === "server_error" ? `сбой провайдера${where ? ` ${where}` : ""} (HTTP ${err.status})`
        : err.cls.code === "empty" ? `пустой ответ модели${where ? ` (${where})` : ""}`
        : err.cls.code === "network" ? `нет ответа${where ? ` от ${where}` : " от провайдера"} (сеть или таймаут)`
        : `временная ошибка провайдера${where ? ` ${where}` : ""}`;
      return { kind: "transient", code: err.cls.code, human, detail };
    }
    return { kind: "fatal", code: err.cls.code, human: `Провайдер${where ? ` ${where}` : ""} отклонил запрос`, detail };
  }
  if (isDbTransient(err)) return { kind: "transient", code: "db", human: "короткий сбой базы данных", detail };
  if (NET_TRANSIENT_RE.test(msg)) return { kind: "transient", code: "network", human: "нет ответа (сеть или таймаут)", detail };
  return { kind: "fatal", code: "error", human: msg.slice(0, 300), detail };
}

function providerOf(err: AiError): string {
  const p = (err as { provider?: unknown }).provider;
  return typeof p === "string" ? p : "";
}

function keyLabelOf(err: AiError): string {
  const k = (err as { keyLabel?: unknown }).keyLabel;
  return typeof k === "string" ? k : "";
}

/* ───────────────────────── Политика повторов ───────────────────────── */

const SEC = 1000;
const MIN = 60 * SEC;

/** Паузы временных ошибок: 30 с, 1, 2, 4, 8, 15, 15, 15 мин ≈ 1 час ожидания на 8 повторов. */
export const TRANSIENT_DELAYS_MS = [30 * SEC, 1 * MIN, 2 * MIN, 4 * MIN, 8 * MIN, 15 * MIN, 15 * MIN, 15 * MIN];
/** Отложенные повторы при неверном формате ответа модели (каждый — после 2–3 переспросов внутри этапа). */
export const MALFORMED_DELAYS_MS = [2 * MIN, 5 * MIN, 15 * MIN];
/** Ожидание рабочего ключа: 10, 15, затем каждые 30 мин. */
export const KEY_DELAYS_MS = [10 * MIN, 15 * MIN, 30 * MIN];
/** Сколько ждём рабочий ключ, прежде чем статья станет ошибкой. */
export const KEY_WAIT_WINDOW_MS = 7 * 24 * 60 * MIN;
/** Повторы, которые этап просит сам (retryInMs без вида): потолок по умолчанию и по этапам. */
export const PLANNED_MAX_DEFAULT = 30;
export const PLANNED_MAX_BY_STAGE: Record<string, number> = {
  /** медиатека WordPress сломана: проверка раз в 20 мин ≈ сутки */
  publish: 72,
};

export type RetryPlan = { retry: true; delayMs: number; n: number; max: number | null } | { retry: false; n: number; max: number | null };

/**
 * Решение по очередному сбою вида `kind`: n — номер этого повтора (1 = первый сбой подряд),
 * firstAt — когда случился первый сбой этого вида в текущей серии, stageDelay — пауза, которую попросил этап.
 */
export function retryPlan(kind: RetryKind, n: number, firstAt: Date | null, stage: string, stageDelayMs?: number): RetryPlan {
  const pick = (list: number[]) => list[Math.min(n - 1, list.length - 1)];
  switch (kind) {
    case "transient": {
      const max = TRANSIENT_DELAYS_MS.length;
      if (n > max) return { retry: false, n, max };
      return { retry: true, n, max, delayMs: Math.max(pick(TRANSIENT_DELAYS_MS), stageDelayMs ?? 0) };
    }
    case "malformed": {
      const max = MALFORMED_DELAYS_MS.length;
      if (n > max) return { retry: false, n, max };
      return { retry: true, n, max, delayMs: Math.max(pick(MALFORMED_DELAYS_MS), stageDelayMs ?? 0) };
    }
    case "key": {
      if (firstAt && Date.now() - firstAt.getTime() > KEY_WAIT_WINDOW_MS) return { retry: false, n, max: null };
      return { retry: true, n, max: null, delayMs: Math.max(pick(KEY_DELAYS_MS), stageDelayMs ?? 0) };
    }
    case "planned": {
      const max = PLANNED_MAX_BY_STAGE[stage] ?? PLANNED_MAX_DEFAULT;
      if (n > max) return { retry: false, n, max };
      return { retry: true, n, max, delayMs: Math.max(stageDelayMs ?? 0, 5 * SEC) };
    }
  }
}

/** «через 90 с» / «через 4 мин» / «через 1 ч 30 мин» */
export function inWords(ms: number): string {
  if (ms < 2 * MIN) return `${Math.max(1, Math.round(ms / SEC))} с`;
  const m = Math.round(ms / MIN);
  if (m < 60) return `${m} мин`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h} ч ${r} мин` : `${h} ч`;
}

/** Сигнатура для группировки в журнале ошибок: этап + вид + нормализованный текст (без чисел, адресов и id). */
export function failureSignature(stage: string, code: string, text: string): string {
  const norm = text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, "<url>")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<id>")
    .replace(/«[^»]{0,120}»/g, "«…»")
    .replace(/\d+/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 140);
  return `${stage}: ${code}: ${norm}`.slice(0, 190);
}
