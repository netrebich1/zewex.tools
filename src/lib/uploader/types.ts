/**
 * Pin Uploader — автозаливка CSV-выгрузок пинов в Pinterest через Dolphin Anty.
 * Общие константы и типы портала и агента (агент держит копию нужного в agent/uploader/src/protocol.ts).
 */

export const UPLOADER = "uploader";
/** Версия протокола агент ↔ портал: агент старше — просим обновить. */
export const PROTOCOL = 1;
/** Аренда задания агентом, секунды (продлевается шагом progress). */
export const LEASE_SEC = 600;
/** Агент считается офлайн, если молчит дольше, секунды. */
export const OFFLINE_SEC = 120;
/** Попыток задания для временных сбоев (Dolphin/сеть) до FAILED. */
export const MAX_ATTEMPTS = 3;
/** Паузы аккаунта после отказа Pinterest, часы (ступени blockStep). */
export const PAUSE_HOURS = [2, 6, 24];

export type RunStatus = "QUEUED" | "RUNNING" | "VERIFY_WAIT" | "VERIFYING" | "DONE" | "FAILED" | "STOPPED";
export const RUN_STATUS_LABELS: Record<RunStatus, string> = {
  QUEUED: "В очереди", RUNNING: "Заливка", VERIFY_WAIT: "Ждёт проверки", VERIFYING: "Проверка", DONE: "Готово", FAILED: "Ошибка", STOPPED: "Остановлен",
};
export const RUN_LIVE: ReadonlySet<string> = new Set(["QUEUED", "RUNNING", "VERIFY_WAIT", "VERIFYING"]);

export type TaskStatus = "QUEUED" | "LEASED" | "DONE" | "FAILED" | "SKIPPED";
export const TASK_STATUS_LABELS: Record<TaskStatus, string> = { QUEUED: "ждёт", LEASED: "в работе", DONE: "готово", FAILED: "ошибка", SKIPPED: "пропущено" };

export type StepKind = "upload_csv" | "check_history" | "analytics";
export type Step = { kind: StepKind };

export type ErrorKind = "dolphin_offline" | "dolphin_auth" | "profile_not_found" | "profile_busy" | "proxy_failed" | "browser_missing" | "not_logged_in" | "pinterest_rejected" | "rate_limited" | "upload_form_changed" | "no_file" | "network" | "stopped" | "unknown";
/** Временные сбои: задание возвращается в очередь, аккаунт не трогаем. */
export const TRANSIENT: ReadonlySet<string> = new Set<ErrorKind>(["dolphin_offline", "dolphin_auth", "profile_busy", "network", "stopped"]);

export const ERROR_LABELS: Record<ErrorKind, string> = {
  dolphin_offline: "Dolphin Anty не запущен на ПК агента",
  dolphin_auth: "Dolphin не принял токен API — проверьте токен в настройках",
  profile_not_found: "Профиль Dolphin не найден — проверьте сопоставление",
  profile_busy: "Профиль уже открыт в Dolphin — закройте его и повторите",
  proxy_failed: "Прокси профиля не отвечает — смените прокси в Dolphin или выберите другой профиль",
  browser_missing: "В Dolphin не скачано ядро браузера — откройте профиль вручную один раз",
  not_logged_in: "В профиле нет входа в Pinterest — войдите в аккаунт вручную",
  pinterest_rejected: "Pinterest отклонил файл",
  rate_limited: "Pinterest ограничил аккаунт",
  upload_form_changed: "Страница загрузки Pinterest изменилась — нужно обновить агент",
  no_file: "Файл на этот день пуст или не собрался",
  network: "Сбой сети",
  stopped: "Остановлено",
  unknown: "Неизвестная ошибка",
};

export type AccountStatus = "ok" | "needs_login" | "paused" | "limited" | "banned" | "off";
export const ACCOUNT_STATUS_LABELS: Record<AccountStatus, string> = {
  ok: "Работает", needs_login: "Нужен вход", paused: "Пауза", limited: "Ограничен", banned: "Заблокирован", off: "Выключен",
};

/** Диапазоны «человечности» агента, секунды [от, до]; редактируются в настройках, агент получает в hello. */
export type UplHumanize = {
  /** Пауза между сайтами */
  betweenSites: [number, number];
  /** Пауза после открытия профиля до перехода */
  afterOpen: [number, number];
  /** Сколько раз прокрутить ленту и пауза между прокрутками */
  feedScrolls: [number, number];
  scrollPause: [number, number];
  /** Пауза перед выбором файла и после загрузки */
  beforeUpload: [number, number];
  afterUpload: [number, number];
  /** Задержка между символами при печати, мс */
  typeMs: [number, number];
  /** Прокрутить ленту перед загрузкой */
  browseFeed: boolean;
};
export const DEFAULT_HUMANIZE: UplHumanize = {
  betweenSites: [60, 180], afterOpen: [3, 8], feedScrolls: [1, 3], scrollPause: [2, 5], beforeUpload: [2, 6], afterUpload: [5, 15], typeMs: [60, 180], browseFeed: true,
};
export const HUMANIZE_FIELDS: Array<{ key: keyof Omit<UplHumanize, "browseFeed">; label: string; unit: string }> = [
  { key: "betweenSites", label: "Пауза между сайтами", unit: "с" },
  { key: "afterOpen", label: "После открытия профиля", unit: "с" },
  { key: "feedScrolls", label: "Прокруток ленты", unit: "раз" },
  { key: "scrollPause", label: "Пауза между прокрутками", unit: "с" },
  { key: "beforeUpload", label: "Перед выбором файла", unit: "с" },
  { key: "afterUpload", label: "После загрузки", unit: "с" },
  { key: "typeMs", label: "Задержка между символами", unit: "мс" },
];

export type AgentSettings = { parallel: number };
export type AgentSchedule = { enabled: boolean; time: string; tz: string; /** Набор сайтов (UplSet); null — все сайты с профилем */ setId: string | null };
export const DEFAULT_SCHEDULE: AgentSchedule = { enabled: false, time: "09:30", tz: "Europe/Kyiv", setId: null };

export function parseAgentSettings(v: unknown): AgentSettings {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const p = Number(o.parallel);
  return { parallel: Number.isFinite(p) && p >= 1 ? Math.min(5, Math.round(p)) : 1 };
}
export function parseSchedule(v: unknown): AgentSchedule {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  return {
    enabled: o.enabled === true,
    time: typeof o.time === "string" && /^\d{2}:\d{2}$/.test(o.time) ? o.time : DEFAULT_SCHEDULE.time,
    tz: typeof o.tz === "string" && o.tz ? o.tz : DEFAULT_SCHEDULE.tz,
    setId: typeof o.setId === "string" && o.setId ? o.setId : null,
  };
}
const pair = (v: unknown, d: [number, number]): [number, number] => {
  if (!Array.isArray(v) || v.length !== 2) return d;
  const a = Number(v[0]), b = Number(v[1]);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a < 0 || b < a) return d;
  return [a, b];
};
export function parseHumanize(v: unknown): UplHumanize {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const d = DEFAULT_HUMANIZE;
  return {
    betweenSites: pair(o.betweenSites, d.betweenSites), afterOpen: pair(o.afterOpen, d.afterOpen), feedScrolls: pair(o.feedScrolls, d.feedScrolls),
    scrollPause: pair(o.scrollPause, d.scrollPause), beforeUpload: pair(o.beforeUpload, d.beforeUpload), afterUpload: pair(o.afterUpload, d.afterUpload),
    typeMs: pair(o.typeMs, d.typeMs), browseFeed: o.browseFeed !== false,
  };
}

/** Результат проверки истории загрузок Pinterest. */
export type VerifyResult = { published: number | null; failed: number | null; processing: boolean; text?: string | null; screenshot?: string | null; checkedAt?: string };

/** Результат задания от агента (UplTask.result). */
export type TaskResult = {
  accepted?: boolean;
  rowsSeen?: number | null;
  screenshot?: string | null;
  message?: string | null;
  verify?: VerifyResult;
  timings?: Record<string, number>;
  /** Профили Dolphin, которые уже не открылись для этого задания (портал пробует двойника — см. agent.ts fail) */
  triedProfiles?: string[];
  /** Снимок HTML страницы при неизвестной ошибке (для правки селекторов) */
  html?: string | null;
};

/** Что агент получает в next. */
export type AgentTask = {
  id: string;
  runId: string;
  phase: "upload" | "verify";
  steps: Step[];
  site: { id: string; name: string };
  profileId: string;
  profileName: string | null;
  day: string;
  fileName: string | null;
  rows: number | null;
  /** Адрес CSV (запрос с заголовком Authorization агента) */
  fileUrl: string | null;
  pinUsername: string | null;
  /** Имя файла, которое должно появиться в истории загрузок (фаза verify) */
  expectFileName: string | null;
};

export const isDay = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);
