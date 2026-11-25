/**
 * «Проекты» → вкладка «Заливка» в Google-таблицах команд: все сайты команды × последние 7 дней — залито ли в Pinterest
 * в этот день (и сколько пинов), а если нет — почему: нет файла, Dolphin выключен, прокси не отвечает, нет входа, Pinterest
 * отклонил, профиль не найден, не запускалось. Источники: отметки заливки `PrjUpload` (руками и от агента), задания агента
 * `UplTask` (фаза upload: статус и вид сбоя), пины дня `PinRunItem` (есть ли вообще что заливать), аккаунты `UplAccount`.
 * Дни — по часовому поясу пинов (как `UplTask.day`). В конце строки — что сделать по последнему сбою.
 */
import { prisma } from "@/lib/db";
import { TZ, dayKey } from "@/lib/pins/runs/stats";
import { ERROR_LABELS, type ErrorKind } from "@/lib/uploader/types";
import type { Tab } from "./grid";

export const UPLOADS_TAB = "Заливка";
const DAYS = 7;
type Color = "g" | "r" | "y" | "x" | "b";
const dom = (s: string | null | undefined) => (s || "").toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "").trim();
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const dm = (s: string) => `${s.slice(8, 10)}.${s.slice(5, 7)}`;
const WD = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];
const wd = (s: string) => WD[new Date(Date.parse(`${s}T12:00:00Z`)).getUTCDay()];

/** Короткая причина в клетке дня. */
const SHORT: Record<ErrorKind, string> = {
  dolphin_offline: "Dolphin выключен", dolphin_auth: "токен Dolphin", profile_not_found: "профиль не найден", profile_busy: "профиль занят",
  proxy_failed: "прокси не работает", browser_missing: "нет ядра браузера", not_logged_in: "нет входа", pinterest_rejected: "Pinterest отклонил",
  rate_limited: "лимит Pinterest", upload_form_changed: "страница загрузки не найдена", no_file: "нет файла", network: "сбой сети", stopped: "остановлено", unknown: "ошибка",
};

type TaskRow = { pinSiteId: string; day: string; status: string; errorKind: string | null; error: string | null; rows: number | null; createdAt: Date; finishedAt: Date | null };

/** Вкладка «Заливка»: строки — сайты в порядке вкладок ниш (плюс сайты «Пинов», которых в сетке нет), столбцы — 7 дней до сегодня. */
export async function buildUploadsTab(teamSlug: string, sites: Array<{ domain: string; kind: string }>, today: string): Promise<Tab> {
  const days = Array.from({ length: DAYS }, (_, i) => addDays(today, i - DAYS + 1));
  const from = new Date(Date.parse(`${days[0]}T00:00:00Z`) - 2 * 86_400_000);
  const team = await prisma.team.findUnique({ where: { slug: teamSlug }, select: { id: true } });
  const teamId = team?.id ?? "";
  const [pinSites, access] = await Promise.all([
    prisma.pinSite.findMany({ where: { teamId }, select: { id: true, name: true, wpConnectionId: true, isActive: true } }),
    prisma.siteAccess.findMany({ where: { teamId }, select: { id: true, baseUrl: true, name: true } }),
  ]);
  const accDom = new Map(access.map((a) => [a.id, dom(a.baseUrl) || dom(a.name)]));
  const siteDom = new Map(pinSites.map((p) => [p.id, (p.wpConnectionId && accDom.get(p.wpConnectionId)) || dom(p.name)]));
  const ids = pinSites.map((p) => p.id);
  const [accounts, uploads, tasks, items] = await Promise.all([
    prisma.uplAccount.findMany({ where: { pinSiteId: { in: ids } }, select: { pinSiteId: true, profileId: true, status: true, lastError: true } }),
    prisma.prjUpload.findMany({ where: { pinSiteId: { in: ids }, day: { gte: days[0] } }, select: { pinSiteId: true, day: true, source: true, note: true } }),
    prisma.uplTask.findMany({ where: { pinSiteId: { in: ids }, phase: "upload", day: { gte: days[0] } }, select: { pinSiteId: true, day: true, status: true, errorKind: true, error: true, rows: true, createdAt: true, finishedAt: true } }),
    prisma.pinRunItem.findMany({ where: { siteId: { in: ids }, scheduledAt: { gte: from }, status: "READY", moderation: "APPROVED" }, select: { siteId: true, scheduledAt: true, uploadedAt: true } }),
  ]);
  // Сайт (домен) → его сайты «Пинов» (дубли бывают), аккаунт, отметки, задания и пины по дням.
  const byDom = new Map<string, string[]>();
  for (const p of pinSites) { const d = siteDom.get(p.id)!; (byDom.get(d) ?? byDom.set(d, []).get(d)!).push(p.id); }
  const accBy = new Map(accounts.map((a) => [a.pinSiteId, a]));
  const upBy = new Map<string, (typeof uploads)[number]>();
  for (const u of uploads) upBy.set(`${siteDom.get(u.pinSiteId)}|${u.day}`, u);
  const taskBy = new Map<string, TaskRow>();
  for (const t of tasks) {
    const k = `${siteDom.get(t.pinSiteId)}|${t.day}`; const cur = taskBy.get(k);
    // Последнее по времени задание дня; «готово» важнее любого сбоя.
    const at = (x: TaskRow) => (x.finishedAt ?? x.createdAt).getTime();
    if (!cur || t.status === "DONE" || (cur.status !== "DONE" && at(t) >= at(cur))) taskBy.set(k, t);
  }
  const pinsBy = new Map<string, { total: number; done: number }>();
  for (const it of items) {
    if (!it.siteId || !it.scheduledAt) continue;
    const k = `${siteDom.get(it.siteId)}|${dayKey(it.scheduledAt, TZ)}`;
    const c = pinsBy.get(k) ?? pinsBy.set(k, { total: 0, done: 0 }).get(k)!;
    c.total++; if (it.uploadedAt) c.done++;
  }

  const order = [...sites.map((s) => s.domain), ...[...byDom.keys()].filter((d) => !sites.some((s) => s.domain === d)).sort()];
  const kindOf = new Map(sites.map((s) => [s.domain, s.kind]));
  // Апостроф впереди — иначе Google Таблицы превращают «ср 19.11» в число-дату.
  const h1 = ["САЙТ", "НИША", ...days.map((d) => `'${wd(d)} ${dm(d)}`), "ЗАЛИТО ЗА 7 ДН", "ЧТО СДЕЛАТЬ"];
  const h2 = ["", "", ...days.map((d) => (d === today ? "сегодня" : d === addDays(today, -1) ? "вчера" : "")), "дней / пинов", ""];
  const values: (string | number)[][] = [h1, h2];
  const colors: [number, number, Color][] = [];
  const totals = days.map(() => ({ ok: 0, fail: 0, skip: 0 }));

  for (const domain of order) {
    const r = values.length; const row: (string | number)[] = [domain, kindOf.get(domain) ?? ""]; colors.push([r, 0, "x"]);
    const pids = byDom.get(domain) ?? [];
    const acc = pids.map((id) => accBy.get(id)).find((a) => a?.profileId) ?? pids.map((id) => accBy.get(id)).find(Boolean) ?? null;
    let okDays = 0, okPins = 0; let lastFail: { day: string; kind: ErrorKind | null; text: string } | null = null; let stale = 0;
    days.forEach((day, i) => {
      const c = row.length; const up = upBy.get(`${domain}|${day}`); const t = taskBy.get(`${domain}|${day}`); const pins = pinsBy.get(`${domain}|${day}`);
      let text: string, color: Color;
      if (up) {
        const n = t?.status === "DONE" && t.rows ? t.rows : pins?.done || null;
        text = `✓ ${n ? `${n} пин.` : "залито"}${up.source === "manual" ? " (руками)" : ""}`; color = "g"; okDays++; okPins += n ?? 0; totals[i].ok++;
      } else if (!pids.length) { text = "нет в «Пинах»"; color = "x"; }
      else if (t && (t.status === "QUEUED" || t.status === "LEASED")) { text = t.status === "LEASED" ? "заливается…" : "в очереди"; color = "y"; }
      else if (t && t.status === "FAILED") {
        const k = (t.errorKind ?? "unknown") as ErrorKind; text = `✗ ${SHORT[k] ?? SHORT.unknown}`; color = "r"; totals[i].fail++;
        if (!lastFail || day > lastFail.day) lastFail = { day, kind: k, text: t.error ?? "" };
      } else if (t && t.status === "SKIPPED") {
        const k = (t.errorKind ?? "") as ErrorKind | ""; const all = /все пины дня уже залиты/.test(t.error ?? "");
        text = k === "no_file" ? (all ? "все уже залиты" : "нет файла") : k === "profile_not_found" ? "профиль другой команды" : k === "not_logged_in" ? "✗ нет входа" : k === "rate_limited" ? "✗ аккаунт на паузе" : k === "stopped" ? "остановлено" : `пропущено: ${(t.error ?? "").slice(0, 40)}`;
        color = k === "no_file" ? (all ? "x" : "y") : k === "not_logged_in" || k === "rate_limited" ? "r" : "y";
        if (color !== "x") totals[i].skip++;
        if ((k === "not_logged_in" || k === "rate_limited" || k === "profile_not_found") && (!lastFail || day > lastFail.day)) lastFail = { day, kind: k, text: t.error ?? "" };
      } else if (!acc?.profileId) { text = pins?.total ? "нет профиля Dolphin" : "—"; color = pins?.total ? "y" : "x"; if (pins?.total) totals[i].skip++; }
      else if (pins?.total && pins.done >= pins.total) { text = "все уже залиты"; color = "x"; }
      else if (pins?.total) { text = day === today ? "ещё не запускалось" : "не запускалось"; color = day === today ? "y" : "r"; if (day !== today) { totals[i].fail++; stale++; } }
      else { text = "пинов нет"; color = "x"; }
      row.push(text); colors.push([r, c, color]);
    });
    const anyPins = days.some((d) => pinsBy.get(`${domain}|${d}`)?.total);
    row.push(`${okDays} / ${okPins}`); colors.push([r, row.length - 1, okDays >= 5 ? "g" : okDays >= 2 ? "y" : pids.length && anyPins ? "r" : "x"]);
    // Что сделать — по последнему сбою; если за 7 дней ни разу не залито, а пины были — отдельно.
    const todo: string[] = [];
    const lf = lastFail as { day: string; kind: ErrorKind | null; text: string } | null;
    if (lf) todo.push(`${dm(lf.day)}: ${lf.kind ? ERROR_LABELS[lf.kind] : lf.text}`);
    if (!pids.length) todo.push("сайта нет в «Пинах» — пины для него не делаются");
    else if (!acc?.profileId && days.some((d) => pinsBy.get(`${domain}|${d}`)?.total)) todo.push("сопоставить профиль Dolphin (Заливка в Pinterest → Сопоставление)");
    else if (acc?.status === "needs_login") todo.push("войти в Pinterest в профиле Dolphin");
    else if (stale >= 2 && !lf) todo.push(`${stale} дн. с пинами без запуска — проверить расписание агента и что ПК с Dolphin включён`);
    row.push(todo.join("; ") || "ок");
    colors.push([r, row.length - 1, todo.length ? (lf || stale >= 2 ? "r" : "y") : "g"]);
    values.push(row);
  }
  // Итог по дням.
  const tr = values.length; const tot: (string | number)[] = ["ИТОГО", ""];
  totals.forEach((t, i) => { tot.push(`✓ ${t.ok} · ✗ ${t.fail}${t.skip ? ` · ${t.skip} проп.` : ""}`); colors.push([tr, 2 + i, t.fail ? "y" : "g"]); });
  tot.push("", ""); values.push(tot);

  const widths: Record<number, number> = { 0: 190, 1: 80, [2 + DAYS]: 95, [3 + DAYS]: 420 };
  for (let i = 0; i < DAYS; i++) widths[2 + i] = 135;
  return { title: UPLOADS_TAB, values, colors, merges: [[0, 2, 0, 1], [0, 2, 1, 2], [0, 2, 3 + DAYS, 4 + DAYS]], widths, dates: [], groups: [2, 2 + DAYS], cols: h1.length, noteCol: -1, frozenCols: 2 };
}
