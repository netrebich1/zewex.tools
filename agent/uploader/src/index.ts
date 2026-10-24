/**
 * Zewex Uploader — агент на ПК сотрудника. Цикл: hello → список профилей Dolphin (раз в час) → опрос заданий →
 * выполнение (до `parallel` одновременно, лимит задаёт портал) → отчёт. Dolphin закрыт — ждёт и пишет состояние.
 */
import { hostname, platform, release } from "node:os";
import { PortalClient } from "./api";
import { askConfig, loadConfig } from "./config";
import { Dolphin } from "./dolphin";
import { pause, sleep } from "./humanize";
import { log } from "./log";
import { AGENT_VERSION, DEFAULT_HUMANIZE, PROTOCOL, type AgentTask, type UplHumanize } from "./protocol";
import { runTask } from "./task";
import { startTray } from "./tray";

async function main() {
  let cfg = loadConfig() ?? (await askConfig());
  let api = new PortalClient(cfg.portal, cfg.token);
  const dolphin = new Dolphin(null);
  let humanize: UplHumanize = DEFAULT_HUMANIZE;
  let bulkUrl: string | null = null;
  let dolphinToken: string | null = null;
  let pollSec = 20;
  let lastProfilesAt = 0;
  let lastHelloAt = 0;
  const stopRuns = new Set<string>();
  const running = new Map<string, Promise<void>>();
  let shuttingDown = false;
  process.on("SIGINT", () => { shuttingDown = true; log.info("останавливаюсь…"); });
  process.on("SIGTERM", () => { shuttingDown = true; });

  const hostInfo = async () => ({ os: `${platform()} ${release()}`, host: hostname(), dolphin: await dolphin.version(), agent: AGENT_VERSION });

  const hello = async () => {
    const h = await api.hello(await hostInfo(), log.state());
    if (h.protocol > PROTOCOL) log.warn(`портал ждёт протокол ${h.protocol}, у агента ${PROTOCOL}: обновите агент`);
    if (h.latest && h.latest !== "0" && h.latest !== AGENT_VERSION) log.warn(`есть новая версия агента ${h.latest} (у вас ${AGENT_VERSION}) — скачайте на странице «Агенты»`);
    humanize = h.humanize ?? DEFAULT_HUMANIZE;
    bulkUrl = h.bulkUrl ?? null;
    pollSec = h.pollSec || 20;
    const hadToken = dolphinToken;
    dolphinToken = h.dolphinToken;
    dolphin.setToken(h.dolphinToken);
    if (!h.dolphinToken) log.warn("в настройках портала нет токена Dolphin API — профили открыть не получится. Админ: Заливка в Pinterest → Настройки");
    else if (!hadToken) { log.info("получил токен Dolphin API — обновляю список профилей"); lastProfilesAt = 0; }
    lastHelloAt = Date.now();
    log.info(`на связи как «${h.agent.name}», портал ${cfg.portal}`);
  };

  const syncProfiles = async () => {
    if (!(await dolphin.alive())) { log.setState("Dolphin Anty не запущен"); return; }
    const list = await dolphin.profiles();
    await api.profiles(list);
    lastProfilesAt = Date.now();
    log.info(`профилей Dolphin: ${list.length}`);
    log.setState("жду задания");
  };

  startTray({ portal: cfg.portal, version: AGENT_VERSION });
  log.info(`Zewex Uploader ${AGENT_VERSION} запускается…`);
  while (!shuttingDown) {
    try {
      if (Date.now() - lastHelloAt > (dolphinToken ? 10 : 2) * 60_000) await hello();
      if (Date.now() - lastProfilesAt > 60 * 60_000) await syncProfiles().catch((e) => log.warn("список профилей не отправлен", e));
      const r = await api.next(running.size, log.state());
      for (const id of r.stop) stopRuns.add(id);
      if (r.tasks.length) {
        if (!(await dolphin.alive())) {
          log.setState("Dolphin Anty не запущен — задания ждут");
          for (const t of r.tasks) await api.fail(t.id, "dolphin_offline", "Dolphin Anty не запущен на этом ПК").catch(() => {});
          await sleep(30_000);
          continue;
        }
        for (const t of r.tasks) {
          if (running.has(t.id)) continue;
          log.info(`задание: ${t.site.name} · ${t.phase} · ${t.day}`);
          const p = runTask(t as AgentTask, { api, dolphin, humanize, bulkUrl, stopped: () => shuttingDown || stopRuns.has(t.runId) })
            .catch((e) => log.error(`задание ${t.id} упало`, e))
            .finally(() => running.delete(t.id));
          running.set(t.id, p);
          // Между открытиями профилей — человеческая пауза (и когда их несколько параллельно).
          await pause(humanize.betweenSites);
        }
        continue;
      }
      if (running.size === 0) log.setState("жду задания");
      await sleep(Math.max(5, (r.wait ?? pollSec)) * 1000);
    } catch (e) {
      const err = e as Error & { code?: string; status?: number };
      if (err.status === 401 || err.status === 403) {
        log.error(`портал отказал: ${err.message}`);
        if (process.stdin.isTTY) {
          // Токен отозван или выдан новый: спрашиваем прямо здесь, перезапуск не нужен.
          console.log("Токен агента не принят. Выдайте новый на странице «Агенты» портала и вставьте его сюда.");
          cfg = await askConfig({ portal: cfg.portal });
          api = new PortalClient(cfg.portal, cfg.token);
          lastHelloAt = 0; lastProfilesAt = 0;
          continue;
        }
        await sleep(60_000); continue;
      }
      log.warn("сбой цикла", e);
      log.setState("нет связи с порталом");
      await sleep(30_000);
    }
  }
  await Promise.allSettled([...running.values()]);
  await api.state("выключен", false).catch(() => {});
  log.info("агент остановлен");
  process.exit(0);
}

main().catch((e) => { log.error("агент не запустился", e); process.exit(1); });
