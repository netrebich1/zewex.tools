/** Действия на Pinterest: проверка входа и имени, массовая загрузка CSV, чтение истории загрузок. */
import type { Page } from "playwright-core";
import { AgentError } from "./errors";
import { browseFeed, humanClick, pause, rand, sleep } from "./humanize";
import { log } from "./log";
import type { UplHumanize, VerifyResult } from "./protocol";
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
    let input = await firstVisible(page, S.fileInput, 4000);
    if (!input) {
      // input[type=file] часто скрыт — ищем в DOM без видимости
      for (const s of S.fileInput) { if ((await page.locator(s).count()) > 0) { input = s; break; } }
    }
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

/** История массовых загрузок: найти запись по имени файла (или самую свежую), прочитать статус. */
export async function readHistory(page: Page, expectFileName: string | null, bulkUrl: string | null, h: UplHumanize, onStep: (s: string) => Promise<void>): Promise<VerifyResult> {
  await onStep("открываю историю загрузок");
  await openBulkPage(page, bulkUrl, h).catch((e) => { if (!(e instanceof AgentError && e.kind === "upload_form_changed")) throw e; });
  const entry = await firstVisible(page, S.historyEntry, 8000);
  if (entry) { await humanClick(page, entry, h); await sleep(rand(2000, 4000)); }
  let rows: string[] = [];
  for (const s of S.historyRows) {
    const texts = await page.locator(s).allInnerTexts().catch(() => [] as string[]);
    if (texts.length > 1) { rows = texts.map((t) => t.replace(/\s+/g, " ").trim()).filter(Boolean); break; }
  }
  const body = (await page.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ");
  const base = expectFileName ? expectFileName.replace(/\.csv$/i, "") : null;
  const row = (base && rows.find((r) => r.includes(base))) ?? rows.find((r) => /\.csv/i.test(r)) ?? null;
  const text = row ?? body.slice(0, 2000);
  const pub = S.historyPublished.exec(text);
  const fail = S.historyFailed.exec(text);
  const processing = S.historyProcessing.test(text) && !pub;
  if (!row && !rows.length) log.warn("история загрузок: таблица не найдена, беру текст страницы");
  return { published: pub ? Number(pub[1]) : null, failed: fail ? Number(fail[1]) : null, processing, text: (row ? `${row}\n---\n` : "") + rows.slice(0, 15).join("\n") };
}
