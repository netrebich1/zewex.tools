/**
 * Понятное объяснение проблем прогона: что случилось, критично ли и что делать.
 * Чистые функции без базы — используются и на сервере (status.ts), и в клиентских компонентах.
 *
 * critical — прогон стоит и сам не продолжится (нужно действие человека);
 * warning  — прогон идёт или завершён, часть пинов пропущена; работать можно.
 */
export type Severity = "critical" | "warning";
export type Health = "ok" | "warning" | "critical";

export type Problem = {
  severity: Severity;
  /** Короткий заголовок по-человечески. */
  title: string;
  /** Что это значит для прогона. */
  meaning: string;
  /** Что сделать. */
  action: string;
  count: number;
  stage: string;
  kind: string;
  /** Исходный текст ошибки провайдера (для администратора). */
  raw: string;
};

const SAFETY_RU: Record<string, string> = { sexual: "откровенное содержание", violence: "насилие", hate: "оскорбления", "self-harm": "самоповреждение", harassment: "оскорбления", minors: "несовершеннолетние" };

function safetyReason(raw: string): string {
  const m = raw.match(/safety_violations=\[([^\]]+)\]/i);
  if (!m) return "";
  const list = m[1].split(",").map((s) => SAFETY_RU[s.trim().toLowerCase()] ?? s.trim()).filter(Boolean);
  return list.length ? ` (причина: ${[...new Set(list)].join(", ")})` : "";
}

const pins = (n: number) => `${n} ${n % 10 === 1 && n % 100 !== 11 ? "пин" : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? "пина" : "пинов"}`;

/** Ошибка пинов одного вида (errorKind) на одном этапе. */
export function explainItemError(kind: string, stage: string, raw: string, count: number): Problem {
  const base = { count, stage, kind, raw };
  switch (kind) {
    case "safety":
      return { ...base, severity: "warning", title: `ИИ отказался рисовать ${pins(count)}`, meaning: `Фильтр безопасности провайдера отклонил картинку${safetyReason(raw)}. Остальные пины готовы.`, action: "Работать можно. Нажмите «Пропустить сбойные», чтобы убрать эти пины, или «Доделать недостающее», чтобы попробовать ещё раз." };
    case "bad_request":
      return { ...base, severity: "warning", title: `Провайдер не принял запрос: ${pins(count)}`, meaning: "Запрос для этих пинов отклонён как некорректный. Остальные пины готовы.", action: "Работать можно. «Доделать недостающее» повторит попытку; если не поможет, «Пропустить сбойные»." };
    case "permanent_after_retries":
      return { ...base, severity: "warning", title: `Не получилось после повторов: ${pins(count)}`, meaning: "Провайдер не ответил за несколько попыток (перегрузка или сеть). Остальные пины готовы.", action: "Работать можно. Нажмите «Доделать недостающее» чуть позже." };
    case "rate_limited":
    case "server_error":
    case "network":
    case "unknown":
      return { ...base, severity: "warning", title: `Временный сбой: ${pins(count)}`, meaning: "Провайдер перегружен или была ошибка сети.", action: "Работать можно. Нажмите «Доделать недостающее»." };
    case "auth":
      return { ...base, severity: "critical", title: "Ключ ИИ отклонён провайдером", meaning: "Ключ неверный или отключён. Пины этого вида не делаются.", action: "Сообщите администратору: нужно проверить ключ в разделе «Ключи ИИ». Затем «Продолжить»." };
    case "no_credits":
      return { ...base, severity: "critical", title: "На ключе ИИ закончились деньги", meaning: "Провайдер не выполняет запросы, пока баланс пустой.", action: "Сообщите администратору: нужно пополнить баланс. Затем «Продолжить»." };
    default:
      return { ...base, severity: "warning", title: `Ошибка: ${pins(count)}`, meaning: "Эти пины не готовы. Остальные в порядке.", action: "Работать можно. «Доделать недостающее» повторит попытку." };
  }
}

/** Причина остановки прогона (PinRun.blockedReason): всегда критично. */
export function explainBlocked(reason: string, stage: string): Problem {
  const r = reason.toLowerCase();
  const base = { severity: "critical" as const, count: 1, stage, kind: "blocked", raw: reason };
  if (/баланс|no credits|insufficient|quota|закончил/.test(r)) return { ...base, title: "Прогон остановлен: закончились деньги на ключе ИИ", meaning: "Без баланса провайдер не выполняет запросы.", action: "Попросите администратора пополнить баланс, затем нажмите «Продолжить»." };
  if (/ключ|api key|unauthorized|отклонён/.test(r)) return { ...base, title: "Прогон остановлен: ключ ИИ не работает", meaning: "Провайдер отклонил ключ.", action: "Попросите администратора проверить ключ в разделе «Ключи ИИ», затем «Продолжить»." };
  if (/набор|стил/.test(r)) return { ...base, title: "Прогон остановлен: не выбраны стили", meaning: reason, action: "Откройте вкладку «Настройки» прогона, отметьте наборы стилей, сохраните и нажмите «Продолжить»." };
  if (/wordpress|application password|доступ/.test(r)) return { ...base, title: "Прогон остановлен: нет доступа к WordPress", meaning: reason, action: "Попросите администратора проверить доступ сайта в разделе «Сайты», затем «Продолжить»." };
  if (/правил|слот|не выбрана модель/.test(r)) return { ...base, title: "Прогон остановлен: не назначен ключ ИИ", meaning: reason, action: "Попросите администратора назначить ключ инструменту Pinterest Pins, затем «Продолжить»." };
  return { ...base, title: "Прогон остановлен", meaning: reason, action: "Исправьте причину и нажмите «Продолжить» на странице прогона." };
}

/** Статьи, которые не удалось открыть: пинов для них нет, остальное в порядке. */
export function explainPageErrors(count: number): Problem {
  return { severity: "warning", count, stage: "meta", kind: "page", raw: "", title: `Не открылись статьи: ${count}`, meaning: "Страница не ответила или закрыта от роботов. Для этих статей пинов нет.", action: "Работать можно. Проверьте ссылки; при необходимости запустите их отдельным прогоном." };
}

export type ScheduleReport = { moved: number; days: string[]; limit: number; unscheduled: number; lastDay?: string };

const ru = (k: string) => k.split("-").reverse().join(".");

/** Расписание пришлось изменить из-за общего лимита пинов в день на сайт: не ошибка, но сотрудник должен это видеть. */
export function explainSchedule(r: ScheduleReport): Problem[] {
  const out: Problem[] = [];
  if (r.moved > 0) {
    const days = r.days.length <= 4 ? r.days.map(ru).join(", ") : `${ru(r.days[0])} — ${ru(r.days[r.days.length - 1])} (${r.days.length} дн.)`;
    out.push({ severity: "warning", count: r.moved, stage: "schedule", kind: "day_limit", raw: "",
      title: `Превышен общий лимит ${r.limit} пинов в день: ${pins(r.moved)} перенесено`,
      meaning: `На ${days} у сайта уже стояли пины других прогонов. Вместе с этим прогоном выходило больше ${r.limit} в день, поэтому лишние пины поставлены на ближайшие свободные дни${r.lastDay ? `, последний день прогона теперь ${ru(r.lastDay)}` : ""}.`,
      action: "Ничего делать не нужно. Если нужны другие даты, измените расписание во вкладке «Настройки» и нажмите «Продолжить»." });
  }
  if (r.unscheduled > 0) {
    out.push({ severity: "warning", count: r.unscheduled, stage: "schedule", kind: "no_date", raw: "",
      title: `Без даты осталось: ${pins(r.unscheduled)}`,
      meaning: `Все подходящие дни заняты до предела ${r.limit} пинов. Эти пины готовы, но в выгрузку пока не попадут.`,
      action: "Выберите в настройках прогона более позднюю дату начала или режим «Строго N пинов в день» и нажмите «Продолжить»." });
  }
  return out;
}

export function healthOf(problems: Problem[]): Health {
  if (problems.some((p) => p.severity === "critical")) return "critical";
  return problems.length ? "warning" : "ok";
}

/** Одна строка-вывод для сотрудника. */
export function verdict(health: Health, runStatus: string, problems: Problem[] = []): string {
  if (health === "critical") return "Критично: прогон стоит и сам не продолжится. Нужно действие.";
  if (health === "warning" && problems.length && problems.every((p) => p.kind === "day_limit")) return "Не критично: расписание скорректировано под лимит, все пины в выгрузке.";
  if (health === "warning") return runStatus === "DONE" ? "Не критично: прогон готов, проблемные пины в выгрузку не попадут." : "Не критично: прогон продолжается, проблемные пины будут пропущены.";
  return "Проблем нет.";
}
