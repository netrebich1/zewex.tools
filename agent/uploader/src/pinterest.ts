/** Действия на Pinterest: проверка входа и имени, массовая загрузка CSV, пины в расписании на вкладке Created. */
import type { Page, Request } from "playwright-core";
import { AgentError } from "./errors";
import { browseFeed, humanClick, pause, rand, sleep } from "./humanize";
import { log } from "./log";
import type { PinStatDay, PinStats, UplHumanize, VerifyResult } from "./protocol";
import { PINTEREST as S } from "./selectors";

export async function screenshot(page: Page): Promise<string | null> {
  try {
    const buf = await page.screenshot({ type: "jpeg", quality: 55 });
    return `data:image/jpeg;base64,${buf.toString("base64")}`;
  } catch {
    return null;
  }
}
export async function pageHtml(page: Page): Promise<string | null> {
  try { return (await page.content()).slice(0, 200_000); } catch { return null; }
}

async function firstVisible(page: Page, selectors: string[], timeoutMs: number): Promise<string | null> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    for (const s of selectors) {
      try { if (await page.locator(s).first().isVisible({ timeout: 200 })) return s; } catch { /* дальше */ }
    }
    await sleep(300);
  }
  return null;
}

/** Открыть главную, подождать, убедиться, что вошли. Лента — по настройке. */
export async function openPinterest(page: Page, h: UplHumanize): Promise<void> {
  await page.goto(S.home, { waitUntil: "domcontentloaded", timeout: 60000 });
  await pause(h.afterOpen);
  await assertLoggedIn(page);
  if (h.browseFeed) await browseFeed(page, h);
}

export async function assertLoggedIn(page: Page): Promise<void> {
  if (S.loginUrl.test(page.url())) throw new AgentError("not_logged_in", "Pinterest открыл страницу входа", await screenshot(page));
  const ok = await firstVisible(page, S.loggedIn, 8000);
  if (ok) return;
  const login = await firstVisible(page, S.loginButtons, 1500);
  if (login) throw new AgentError("not_logged_in", "на странице кнопка «Log in» — сессии нет", await screenshot(page));
  // Ни того ни другого: не блокируем, но запишем — дальше загрузка сама покажет.
  log.warn("не нашёл ни признаков входа, ни кнопки входа — продолжаю");
}

/** Имя пользователя из настроек (ещё один естественный переход). Пусто — если не прочиталось. */
export async function readUsername(page: Page): Promise<string | null> {
  try {
    await page.goto(S.settings, { waitUntil: "domcontentloaded", timeout: 60000 });
    await sleep(rand(1500, 3500));
    if (S.loginUrl.test(page.url())) throw new AgentError("not_logged_in", "Pinterest открыл страницу входа", await screenshot(page));
    const sel = await firstVisible(page, S.usernameInput, 10000);
    if (!sel) return null;
    const v = await page.locator(sel).first().inputValue();
    return v.trim().replace(/^@/, "").toLowerCase() || null;
  } catch (e) {
    if (e instanceof AgentError) throw e;
    return null;
  }
}

/** Перейти на страницу массовой загрузки: заданный адрес или кандидаты; при необходимости клик «Bulk create». Возвращает селектор поля файла. */
async function openBulkPage(page: Page, bulkUrl: string | null, h: UplHumanize): Promise<string> {
  const urls = bulkUrl ? [bulkUrl, ...S.bulkUrls] : S.bulkUrls;
  for (const url of urls) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    } catch (e) {
      log.warn(`не открылась ${url}`, e);
      continue;
    }
    await sleep(rand(2000, 4000));
    if (S.loginUrl.test(page.url())) throw new AgentError("not_logged_in", "Pinterest открыл страницу входа", await screenshot(page));
    // input[type=file] почти всегда скрыт — ищем в DOM по приоритету (csv → text → не картинка/видео)
    let input: string | null = null;
    for (const s of S.fileInput) { if ((await page.locator(s).count()) > 0) { input = s; break; } }
    if (input) return input;
    const entry = await firstVisible(page, S.bulkEntry, 4000);
    if (entry) {
      await humanClick(page, entry, h);
      await sleep(rand(2000, 4000));
      for (const s of S.fileInput) { if ((await page.locator(s).count()) > 0) return s; }
    }
  }
  throw new AgentError("upload_form_changed", "не нашёл страницу массовой загрузки и поле выбора файла", await screenshot(page), await pageHtml(page));
}

/** Загрузить CSV: поле файла → (кнопка отправки, если есть) → ждать подтверждения. */
export async function bulkUpload(page: Page, filePath: string, bulkUrl: string | null, h: UplHumanize, onStep: (s: string) => Promise<void>): Promise<{ rowsSeen: number | null; message: string | null }> {
  await onStep("открываю массовую загрузку");
  const input = await openBulkPage(page, bulkUrl, h);
  await pause(h.beforeUpload);
  const before = (await page.locator("body").innerText().catch(() => "")).slice(0, 20000);
  await onStep("выбираю файл");
  await page.locator(input).first().setInputFiles(filePath);
  await sleep(rand(1500, 3500));
  const submit = await firstVisible(page, S.submit, 5000);
  if (submit) {
    await onStep("отправляю");
    await humanClick(page, submit, h);
  }
  await onStep("жду подтверждения");
  const until = Date.now() + 90_000;
  let text = "";
  while (Date.now() < until) {
    await sleep(1500);
    text = (await page.locator("body").innerText().catch(() => "")).slice(0, 20000);
    const fresh = diff(before, text);
    if (S.failure.test(fresh) && !S.success.test(fresh)) {
      throw new AgentError("pinterest_rejected", `Pinterest: ${fresh.replace(/\s+/g, " ").slice(0, 200)}`, await screenshot(page), await pageHtml(page));
    }
    if (S.success.test(fresh)) {
      const m = /(\d+)\s*pins?/i.exec(fresh);
      await pause(h.afterUpload);
      return { rowsSeen: m ? Number(m[1]) : null, message: fresh.replace(/\s+/g, " ").slice(0, 250) || null };
    }
  }
  throw new AgentError("upload_form_changed", "после выбора файла Pinterest не показал ни подтверждения, ни ошибки за 90 с", await screenshot(page), await pageHtml(page));
}

/** Новые строки текста страницы (после загрузки) — чтобы не ловить старые надписи. */
function diff(before: string, after: string): string {
  const old = new Set(before.split("\n").map((l) => l.trim()).filter(Boolean));
  return after.split("\n").map((l) => l.trim()).filter((l) => l && !old.has(l)).join("\n");
}

/**
 * Проверка после заливки: профиль → вкладка Created → блок «Scheduled Pins» («N Pins · Only visible to you»).
 * Возвращает число пинов в расписании (0 — блока нет, null — страница профиля не открылась) и снимок с этим блоком.
 */
export async function readScheduled(page: Page, username: string | null, h: UplHumanize, onStep: (s: string) => Promise<void>): Promise<{ result: VerifyResult; shot: string | null }> {
  await onStep("открываю профиль → Created");
  let url = username ? S.createdUrl(username) : null;
  if (!url) {
    await page.goto(S.home, { waitUntil: "domcontentloaded", timeout: 60000 });
    await sleep(rand(2000, 4000));
    const link = await firstVisible(page, S.profileLink, 8000);
    const href = link ? await page.locator(link).first().getAttribute("href").catch(() => null) : null;
    const name = href?.split("/").filter(Boolean)[0] ?? null;
    if (name) url = S.createdUrl(name);
  }
  if (!url) return { result: { published: null, failed: null, processing: false, scheduled: null, text: "не нашёл адрес профиля" }, shot: await screenshot(page) };
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  await pause(h.afterOpen);
  if (S.loginUrl.test(page.url())) throw new AgentError("not_logged_in", "Pinterest открыл страницу входа", await screenshot(page));
  // Блок расписания подгружается не сразу — ждём заголовок до 15 с; нет — значит пинов в расписании нет.
  const title = page.getByText(S.scheduledTitle).first();
  let found = false;
  try { await title.waitFor({ state: "visible", timeout: 15000 }); found = true; } catch { /* блока нет */ }
  if (found) {
    await title.scrollIntoViewIfNeeded().catch(() => {});
    await page.mouse.wheel(0, -200).catch(() => {});
    await sleep(rand(1500, 3000));
  }
  const body = (await page.locator("body").innerText().catch(() => "")).slice(0, 20000);
  const m = S.scheduledCount.exec(body);
  const scheduled = m ? Number(m[1].replace(/[,\s.]/g, "")) : found ? null : 0;
  const shot = await screenshot(page);
  const at = body.search(S.scheduledTitle);
  const text = at >= 0 ? body.slice(at, at + 200).replace(/\s+/g, " ").trim() : "блока «Scheduled Pins» на вкладке Created нет";
  // 0 сразу после заливки — Pinterest ещё создаёт пины (до ~2 ч): портал зайдёт ещё раз.
  return { result: { published: null, failed: null, processing: scheduled === 0, scheduled, text: `${page.url()}\n${text}` }, shot };
}

/**
 * Аналитика аккаунта за 90 дней по дням: показы, вовлечения, клики по пину, клики на сайт, сохранения.
 * Открываем обзор аналитики, ловим запрос страницы за дневным рядом (хэш запроса у Pinterest меняется от выкладки к выкладке)
 * и повторяем его из страницы со всеми метриками. Не бизнес-аккаунт или страница не открылась — ok=false с пояснением, без сбоя задания.
 */
export async function readAnalytics(page: Page, h: UplHumanize, onStep: (s: string) => Promise<void>): Promise<PinStats> {
  await onStep("открываю аналитику");
  const cap: { body: string | null; headers: Record<string, string> } = { body: null, headers: {} };
  const onReq = (req: Request) => {
    try {
      if (req.method() !== "POST" || !req.url().includes("/_/graphql")) return;
      const body = req.postData();
      if (body && body.includes('"useDailyBuckets"') && body.includes('"metricTypes"')) { cap.body = body; cap.headers = req.headers(); }
    } catch { /* не тот запрос */ }
  };
  page.on("request", onReq);
  try {
    await page.goto(S.analytics, { waitUntil: "domcontentloaded", timeout: 60000 });
    await pause(h.afterOpen);
    if (S.loginUrl.test(page.url())) throw new AgentError("not_logged_in", "Pinterest открыл страницу входа", await screenshot(page));
    const until = Date.now() + 30_000;
    while (!cap.body && Date.now() < until) await sleep(500);
    if (!cap.body) {
      const text = (await page.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 160);
      const where = S.analyticsHost.test(page.url()) ? "страница аналитики не запросила данные" : "аналитика не открылась (не бизнес-аккаунт?)";
      return { ok: false, days: [], note: `${where}: ${text}`.slice(0, 250), url: page.url() };
    }
    await onStep("читаю статистику по дням");
    const q = JSON.parse(cap.body) as { queryHash?: string; variables?: Record<string, unknown> };
    const v: Record<string, unknown> = { ...(q.variables ?? {}) };
    // До какого дня страница аналитики сама просит данные — это «последний готовый день» по мнению Pinterest (0.1.12+, для диагностики задержек).
    const pageEnd = typeof v.endDate === "string" && /^d{4}-d{2}-d{2}$/.test(v.endDate) ? v.endDate : null;
    // Страница сама ставит endDate на последний «закрытый» день Pinterest (бывает и 5 дней назад); просим до сегодня —
    // Pinterest отдаст, что есть, а незакрытые дни придут с dataStatus ≠ READY и лягут как оценка.
    const end = new Date().toISOString().slice(0, 10);
    const startMs = Date.parse(`${end}T00:00:00Z`) - 89 * 86_400_000;
    Object.assign(v, { startDate: new Date(startMs).toISOString().slice(0, 10), endDate: end, startTimestamp: Math.round(startMs / 1000), metricTypes: S.analyticsMetrics, useDailyBuckets: true, useHourlyBuckets: false, splitField: "NO_SPLIT" });
    const headers: Record<string, string> = { "content-type": "application/json" };
    for (const [k, val] of Object.entries(cap.headers)) if (/^(x-|accept$)/i.test(k)) headers[k] = val;
    const res = await page.evaluate(async (a: { body: string; headers: Record<string, string> }) => {
      // Токен CSRF страница кладёт в заголовок сама; если в перехваченном запросе его не видно — берём из cookie этой же страницы.
      if (!Object.keys(a.headers).some((k) => k.toLowerCase() === "x-csrftoken")) {
        const m = /(?:^|;\s*)csrftoken=([^;]+)/.exec(document.cookie);
        if (m) a.headers["x-csrftoken"] = decodeURIComponent(m[1]);
      }
      const r = await fetch("/_/graphql/", { method: "POST", credentials: "include", headers: a.headers, body: a.body });
      return { status: r.status, text: await r.text() };
    }, { body: JSON.stringify({ ...q, variables: v }), headers });
    const days = parseAnalytics(res.text);
    // Сырые последние дни ответа (дата, статус, метрики) — чтобы на портале отличить «Pinterest ещё не посчитал» от смены формата.
    const tail = rawTail(res.text);
    // Немного «почитать» страницу, как человек.
    await page.mouse.wheel(0, rand(300, 700)).catch(() => {});
    await sleep(rand(2000, 5000));
    if (!days.length) return { ok: false, days: [], note: `ответ аналитики не разобран (HTTP ${res.status})`, url: page.url(), raw: res.text.slice(0, 20_000), pageEnd, tail };
    return { ok: true, days, note: null, url: page.url(), pageEnd, tail };
  } finally {
    page.off("request", onReq);
  }
}

/** Последние 10 дней ответа аналитики как есть (обрезано до 4000 символов); не разобрали — начало ответа. */
function rawTail(text: string): string {
  try {
    const j = JSON.parse(text) as { data?: Record<string, { data?: Array<{ key?: string; series?: { dailyMetrics?: unknown[] } }> } | null> };
    const node = Object.values(j.data ?? {}).find((x) => Array.isArray(x?.data));
    const list = node?.data ?? [];
    const series = list.find((x) => x.key === "all") ?? list[0];
    const dm = series?.series?.dailyMetrics ?? [];
    return JSON.stringify({ keys: list.map((x) => x.key ?? null), days: dm.slice(-10) }).slice(0, 4000);
  } catch {
    return text.slice(0, 2000);
  }
}

/** Дневной ряд из ответа v3AnalyticsMetricsGraphqlQuery: data[0].series.dailyMetrics[{date, dataStatus, metrics}]. */
function parseAnalytics(text: string): PinStatDay[] {
  try {
    type Series = { key?: string; series?: { dailyMetrics?: Array<{ date?: string; dataStatus?: string; metrics?: Record<string, number | null> }> } };
    const j = JSON.parse(text) as { data?: Record<string, { data?: Series[] } | null> };
    const node = Object.values(j.data ?? {}).find((x) => Array.isArray(x?.data));
    const list = node?.data ?? [];
    const series = list.find((x) => x.key === "all") ?? list[0];
    const n = (x: number | null | undefined) => (typeof x === "number" && Number.isFinite(x) ? Math.max(0, Math.round(x)) : 0);
    const out: PinStatDay[] = [];
    for (const d of series?.series?.dailyMetrics ?? []) {
      if (!d.date || !/^\d{4}-\d{2}-\d{2}$/.test(d.date)) continue;
      const m = d.metrics ?? {};
      out.push({ d: d.date, e: d.dataStatus !== "READY", im: n(m.impressionFloat), en: n(m.engagementFloat), pc: n(m.pinClickFloat), oc: n(m.outboundClickFloat), sv: n(m.saveFloat) });
    }
    return out;
  } catch {
    return [];
  }
}
