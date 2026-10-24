/** Один визит в профиль: Dolphin → CDP → Pinterest → отчёт порталу. */
import { chromium, type Browser, type Page } from "playwright-core";
import type { PortalClient } from "./api";
import type { Dolphin } from "./dolphin";
import { AgentError, toAgentError } from "./errors";
import { pause, rand, sleep } from "./humanize";
import { log } from "./log";
import { assertLoggedIn, bulkUpload, openPinterest, pageHtml, readHistory, readUsername, screenshot } from "./pinterest";
import type { AgentTask, UplHumanize } from "./protocol";

export type TaskEnv = { api: PortalClient; dolphin: Dolphin; humanize: UplHumanize; bulkUrl: string | null; stopped: () => boolean };

export async function runTask(task: AgentTask, env: TaskEnv): Promise<void> {
  const { api, dolphin, humanize: h } = env;
  const t0 = Date.now();
  const timings: Record<string, number> = {};
  const label = `${task.site.name} (${task.profileName ?? task.profileId})`;
  const step = async (s: string, shot?: string | null) => {
    log.setState(`${task.site.name}: ${s}`);
    await api.progress(task.id, s, shot ? { screenshot: shot } : {}).catch((e) => log.warn("progress не ушёл", e));
  };
  let browser: Browser | null = null;
  let page: Page | null = null;
  let started = false;
  try {
    if (env.stopped()) throw new AgentError("stopped", "остановлено до начала");
    let file: { path: string; fileName: string; rows: number } | null = null;
    if (task.phase === "upload") {
      await step("скачиваю файл");
      file = await api.downloadFile(task);
      log.info(`${label}: файл ${file.fileName}, строк ${file.rows}`);
    }
    await step("открываю профиль Dolphin");
    const cdp = await dolphin.start(task.profileId);
    started = true;
    timings.dolphin = Date.now() - t0;
    browser = await chromium.connectOverCDP(cdp.ws, { timeout: 60000 });
    const ctx = browser.contexts()[0] ?? (await browser.newContext());
    page = await ctx.newPage();
    await page.setViewportSize({ width: 1280 + Math.round(rand(0, 160)), height: 760 + Math.round(rand(0, 160)) });
    page.setDefaultTimeout(30000);
    await step("открываю Pinterest");
    await openPinterest(page, h);
    if (env.stopped()) throw new AgentError("stopped", "остановлено");
    const username = await readUsername(page);
    if (username) {
      await api.progress(task.id, "сверил аккаунт", { username }).catch(() => {});
      if (task.pinUsername && task.pinUsername !== username) {
        throw new AgentError("profile_not_found", `в профиле открыт @${username}, а для сайта записан @${task.pinUsername} — проверьте сопоставление`, await screenshot(page));
      }
    }
    await assertLoggedIn(page);
    if (task.phase === "upload" && file) {
      const r = await bulkUpload(page, file.path, env.bulkUrl, h, step);
      timings.upload = Date.now() - t0 - timings.dolphin;
      const shot = await screenshot(page);
      await step("файл принят", null);
      await pause([2, 5]);
      timings.total = Date.now() - t0;
      await api.finishUpload(task.id, { rowsSeen: r.rowsSeen, message: r.message, screenshot: shot, timings });
      log.info(`${label}: загружено${r.rowsSeen != null ? `, строк ${r.rowsSeen}` : ""}`);
    } else {
      const v = await readHistory(page, task.expectFileName, env.bulkUrl, h, step);
      const shot = await screenshot(page);
      timings.total = Date.now() - t0;
      await api.finishVerify(task.id, v, shot);
      log.info(`${label}: история — ${v.processing ? "обрабатывается" : `опубликовано ${v.published ?? "?"}, ошибок ${v.failed ?? 0}`}`);
    }
  } catch (e) {
    const err = toAgentError(e);
    const shot = err.screenshot ?? (page ? await screenshot(page) : null);
    const html = err.html ?? (page && (err.kind === "unknown" || err.kind === "upload_form_changed") ? await pageHtml(page) : null);
    log.error(`${label}: ${err.kind} — ${err.message}`);
    await api.fail(task.id, err.kind, err.message, shot, html).catch((e2) => log.warn("fail не ушёл", e2));
  } finally {
    try { if (page) { await sleep(rand(1000, 2500)); await page.close().catch(() => {}); } } catch { /* тихо */ }
    try { if (browser) await browser.close().catch(() => {}); } catch { /* тихо */ }
    if (started) await dolphin.stop(task.profileId);
    log.setState("жду задания");
  }
}
