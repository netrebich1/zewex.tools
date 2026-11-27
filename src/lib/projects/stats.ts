/**
 * «Проекты» → вкладка «Трафик» в Google-таблицах команд: показы и клики из аналитики аккаунтов Pinterest и визиты из Яндекс Метрики.
 * Pinterest: агент заливки (agent/uploader ≥ 0.1.8) в визите в профиль читает аналитику аккаунта за 90 дней по дням и шлёт её
 *   порталу (`savePinStats`); визиты только за аналитикой для сайтов без заливки создаёт `statsRunsTick` (src/lib/uploader/stats.ts).
 * Метрика: токен OAuth команды (`PrjMetrikaToken`, вводится в «Заливка в Pinterest → Настройки»), ночью (после 03:00 по Киеву)
 *   `metrikaTick` находит счётчики сайтов команды по домену и забирает визиты по дням: люди (без роботов), из них с Pinterest, роботы.
 * Данные лежат в `PrjStatDay` (сайт = домен, как в сетке). Сравнения во вкладке: 30 дней к предыдущим 30, 7 дней к предыдущим 7,
 * последний полный день к тому же дню недели неделей раньше; рост зелёным, падение красным (порог 5%).
 */
import { prisma } from "@/lib/db";
import { decryptSecret } from "@/lib/crypto";
import type { Tab } from "./grid";

const TZ = process.env.SHEETS_TZ || "Europe/Kyiv";
export const TRAFFIC_TAB = "Трафик";
const dom = (s: string | null | undefined) => (s || "").toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "").trim();
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const kyiv = (now = new Date()) => now.toLocaleString("sv-SE", { timeZone: TZ });
const dm = (s: string) => `${s.slice(8, 10)}.${s.slice(5, 7)}`;

// ───────────────────────────── Pinterest: аналитика аккаунта от агента заливки ─────────────────────────────

/** Домен сайта пинов — так же, как в сетке: адрес подключённого сайта, иначе имя. */
export async function pinSiteDomain(pinSiteId: string): Promise<{ domain: string; teamId: string } | null> {
  const s = await prisma.pinSite.findUnique({ where: { id: pinSiteId }, select: { name: true, teamId: true, wpConnectionId: true } });
  if (!s) return null;
  const acc = s.wpConnectionId ? await prisma.siteAccess.findUnique({ where: { id: s.wpConnectionId }, select: { baseUrl: true, name: true } }) : null;
  const domain = (acc && (dom(acc.baseUrl) || dom(acc.name))) || dom(s.name);
  return domain ? { domain, teamId: s.teamId } : null;
}

/** Сколько последних дней подряд с нулями по всем метрикам считаем «Pinterest ещё не посчитал», а не настоящим нулём. */
const TAIL_ZERO_DAYS = 21;
export type PinStatsSaved ={ ok: boolean; saved: number; note: string | null };

/** Аналитика аккаунта от агента: {ok, days:[{d,e,im,en,pc,oc,sv}], note} → строки PrjStatDay и отметка на аккаунте. */
export async function savePinStats(pinSiteId: string, raw: unknown): Promise<PinStatsSaved> {
  const p = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const int = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.min(2_000_000_000, Math.round(v))) : 0);
  const days = (Array.isArray(p.days) ? p.days : []).slice(0, 120)
    .map((x) => (x && typeof x === "object" ? (x as Record<string, unknown>) : {}))
    .filter((x) => typeof x.d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(x.d as string))
    .map((x) => ({ day: x.d as string, estimate: x.e === true, impressions: int(x.im), engagements: int(x.en), pinClicks: int(x.pc), outboundClicks: int(x.oc), saves: int(x.sv) }));
  const note = typeof p.note === "string" ? p.note.slice(0, 250) : null;
  const site = await pinSiteDomain(pinSiteId);
  if (!site) return { ok: false, saved: 0, note: "сайт не найден" };
  if (p.ok !== true || !days.length) {
    const why = note ?? "аналитика не прочитана";
    if (typeof p.raw === "string") console.warn(`[stats] pinterest ${site.domain}: ${why}; ответ: ${p.raw.slice(0, 1500)}`);
    await prisma.uplAccount.updateMany({ where: { pinSiteId }, data: { statsNote: why } });
    return { ok: false, saved: 0, note: why };
  }
  const all = [...new Map(days.map((d) => [d.day, d])).values()].sort((a, b) => a.day.localeCompare(b.day));
  // Pinterest бывает отдаёт последние дни нулями с пометкой «готово» (27.11.2026: все аккаунты, нули с 21.11) — это ещё не посчитанные дни,
  // а не падение. Хвост из сплошных нулей (до TAIL_ZERO_DAYS) не пишем и стираем уже записанный; длиннее — аккаунт и правда без показов.
  const empty = (d: (typeof all)[number]) => !d.impressions && !d.engagements && !d.pinClicks && !d.outboundClicks && !d.saves;
  let cut = all.length;
  while (cut > 0 && empty(all[cut - 1])) cut--;
  const uniq = cut > 0 && all.length - cut <= TAIL_ZERO_DAYS ? all.slice(0, cut) : all;
  await prisma.$transaction([
    prisma.prjStatDay.deleteMany({ where: { source: "pinterest", site: site.domain, day: { in: all.map((d) => d.day) } } }),
    prisma.prjStatDay.createMany({ data: uniq.map((d) => ({ ...d, source: "pinterest", site: site.domain, teamId: site.teamId })) }),
  ]);
  await prisma.uplAccount.updateMany({ where: { pinSiteId }, data: { statsAt: new Date(), statsNote: null } });
  return { ok: true, saved: uniq.length, note: null };
}

// ───────────────────────────── Яндекс Метрика ─────────────────────────────

const METRIKA = "https://api-metrika.yandex.net";
const HUMAN = "ym:s:isRobot=='No'";
/** Визиты с Pinterest: Метрика делит их на «соцсети» и «поиск по меткам» (utm_source=Pinterest), поэтому условие общее. Метка у нас пишется с заглавной («Pinterest»), а сравнение по маске чувствительно к регистру — отсюда «*interest*». Варианты — на случай отказа API в имени поля. */
const PIN_FILTERS = [
  "(ym:s:lastSignSocialNetwork=='pinterest' OR ym:s:lastSignUTMSource=*'*interest*' OR ym:s:referer=*'*pinterest.*')",
  "(ym:s:UTMSource=*'*interest*' OR ym:s:referer=*'*pinterest.*')",
];

async function mGet<T>(token: string, path: string, params: Record<string, string>, attempt = 0): Promise<T> {
  // Временные отказы Метрики (429, 5xx) — до двух повторов с паузой.
  const res = await fetch(`${METRIKA}${path}?${new URLSearchParams(params)}`, { headers: { Authorization: `OAuth ${token}` }, signal: AbortSignal.timeout(60_000) });
  const j = (await res.json().catch(() => ({}))) as { message?: string; errors?: Array<{ message?: string }> };
  if ((res.status === 429 || res.status >= 500) && attempt < 2) { await new Promise((r) => setTimeout(r, 5000 * (attempt + 1))); return mGet<T>(token, path, params, attempt + 1); }
  if (!res.ok) { const e = new Error(`Метрика ${res.status}: ${j.message ?? j.errors?.[0]?.message ?? res.statusText}`) as Error & { status?: number }; e.status = res.status; throw e; }
  return j as T;
}

type Counter = { id: number; site?: string; site2?: { site?: string }; name?: string; status?: string };
export async function metrikaCounters(token: string): Promise<Array<{ id: number; domain: string; name: string }>> {
  const j = await mGet<{ counters?: Counter[] }>(token, "/management/v1/counters", { per_page: "1000" });
  return (j.counters ?? []).map((c) => ({ id: c.id, domain: dom(c.site2?.site ?? c.site), name: c.name ?? "" })).filter((c) => c.id && c.domain);
}

/**
 * Визиты по дням за период с фильтром. На больших счётчиках Метрика отвечает 400 «Query is too complicated» — тогда период
 * делится пополам (до недели), а если и неделя не проходит — точность снижается (выборка вместо полного подсчёта).
 */
async function byTime(token: string, id: number, date1: string, date2: string, filters: string, accuracy = "full"): Promise<Map<string, number>> {
  try { return await byTimeRaw(token, id, date1, date2, filters, accuracy); }
  catch (e) {
    const err = e as Error & { status?: number };
    if (err.status !== 400 || !/complicated|reduce the date/i.test(err.message)) throw e;
    const n = Math.round((Date.parse(date2) - Date.parse(date1)) / 86_400_000) + 1;
    if (n <= 7) { if (accuracy === "full") return byTime(token, id, date1, date2, filters, "medium"); if (accuracy === "medium") return byTime(token, id, date1, date2, filters, "low"); throw e; }
    const mid = addDays(date1, Math.floor(n / 2) - 1);
    const a = await byTime(token, id, date1, mid, filters, accuracy), b = await byTime(token, id, addDays(mid, 1), date2, filters, accuracy);
    return new Map([...a, ...b]);
  }
}
async function byTimeRaw(token: string, id: number, date1: string, date2: string, filters: string, accuracy: string): Promise<Map<string, number>> {
  const j = await mGet<{ data?: Array<{ metrics?: number[][] }>; totals?: number[][]; time_intervals?: string[][] }>(token, "/stat/v1/data/bytime", {
    ids: String(id), metrics: "ym:s:visits", date1, date2, group: "day", filters, accuracy,
  });
  const series = j.data?.[0]?.metrics?.[0] ?? (Array.isArray(j.totals?.[0]) ? j.totals![0] : []);
  const out = new Map<string, number>();
  (j.time_intervals ?? []).forEach((iv, i) => { const d = String(iv?.[0] ?? "").slice(0, 10); if (/^\d{4}-\d{2}-\d{2}$/.test(d)) out.set(d, Math.round(Number(series[i]) || 0)); });
  return out;
}

/** Путь страницы без домена, query и завершающего слеша — так же сравниваются адреса статей в сетке. */
export const urlPath = (u: string): string => {
  const s = (u || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/[?#].*$/, "");
  const i = s.indexOf("/");
  return (i < 0 ? "" : s.slice(i)).replace(/\/+$/, "") || "/";
};

/**
 * Визиты людей по страницам входа за период: /stat/v1/data с ym:s:startURL (до 10 000 строк, по убыванию визитов).
 * На больших счётчиках при 400 «Query is too complicated» точность снижается (выборка).
 */
async function byLanding(token: string, id: number, date1: string, date2: string, accuracy = "full", robots = false): Promise<Map<string, number>> {
  try {
    const j = await mGet<{ data?: Array<{ dimensions?: Array<{ name?: string }>; metrics?: number[] }> }>(token, "/stat/v1/data", {
      ids: String(id), metrics: "ym:s:visits", dimensions: "ym:s:startURL", date1, date2, ...(robots ? {} : { filters: HUMAN }), limit: "10000", sort: "-ym:s:visits", accuracy,
    });
    const out = new Map<string, number>();
    for (const r of j.data ?? []) {
      const p = urlPath(String(r.dimensions?.[0]?.name ?? "")); const v = Math.round(Number(r.metrics?.[0]) || 0);
      if (p && v) out.set(p, (out.get(p) ?? 0) + v);
    }
    // У части счётчиков фильтр «без роботов» вместе с разбивкой по страницам входа отдаёт пустой ответ (проверено 25.11.2026) — тогда берём все визиты.
    if (!out.size && !robots) return byLanding(token, id, date1, date2, accuracy, true);
    return out;
  } catch (e) {
    const err = e as Error & { status?: number };
    if (err.status === 400 && /complicated|reduce the date/i.test(err.message) && accuracy !== "low") return byLanding(token, id, date1, date2, accuracy === "full" ? "medium" : "low", robots);
    throw e;
  }
}

/**
 * То же, но с хвостом: с фильтром «без роботов» Метрика отдаёт только страницы с 10+ визитами за период (проверено 25.11.2026:
 * zentrosy.com — 185 страниц с фильтром против 2807 без). Страницы, которых нет в ответе с фильтром, берём из ответа без фильтра,
 * но не больше 9 визитов: у них заведомо меньше 10 визитов людей, остальное — роботы.
 */
async function byLandingFull(token: string, id: number, date1: string, date2: string): Promise<Map<string, number>> {
  const human = await byLanding(token, id, date1, date2);
  const all = await byLanding(token, id, date1, date2, "full", true).catch(() => new Map<string, number>());
  for (const [p, v] of all) if (!human.has(p)) human.set(p, Math.min(v, 9));
  return human;
}

export const HIST_WEEKS = 10;
/** Понедельник недели, в которую попадает день. */
export const weekOf = (d: string) => addDays(d, -((new Date(Date.parse(`${d}T00:00:00Z`)).getUTCDay() + 6) % 7));
/** Понедельники последних n полных недель (по возрастанию), считая, что данные есть до date2 включительно. */
export const fullWeeks = (date2: string, n = HIST_WEEKS) => { const last = weekOf(addDays(date2, -6)); return Array.from({ length: n }, (_, i) => addDays(last, (i - n + 1) * 7)); };

/** Недельная история страниц сайта → PrjUrlHist: досбор недель, которых ещё нет (до HIST_WEEKS полных недель назад). */
async function syncUrlHist(token: string, id: number, teamId: string, domain: string, date2: string): Promise<number> {
  const weeks = fullWeeks(date2);
  const have = new Set((await prisma.prjUrlHist.findMany({ where: { site: domain, path: "*", week: { in: weeks } }, select: { week: true } })).map((r) => r.week));
  let n = 0;
  for (const w of weeks) {
    if (have.has(w)) continue;
    const m = await byLanding(token, id, w, addDays(w, 6));
    const rows = [...m].map(([path, visits]) => ({ teamId, site: domain, path: path.slice(0, 700), week: w, visits }));
    rows.push({ teamId, site: domain, path: "*", week: w, visits: rows.reduce((s, r) => s + r.visits, 0) });
    await prisma.$transaction([prisma.prjUrlHist.deleteMany({ where: { site: domain, week: w } }), prisma.prjUrlHist.createMany({ data: rows })]);
    n += rows.length;
    await new Promise((r) => setTimeout(r, 200));
  }
  return n;
}

/** Трафик страниц сайта за 7 дней и предыдущие 7 → PrjUrlWeek (перезапись по сайту). */
async function syncUrlWeeks(token: string, id: number, teamId: string, domain: string, date2: string): Promise<number> {
  const cur = await byLandingFull(token, id, addDays(date2, -6), date2);
  const prev = await byLandingFull(token, id, addDays(date2, -13), addDays(date2, -7));
  const paths = new Set([...cur.keys(), ...prev.keys()]);
  const rows = [...paths].map((path) => ({ teamId, site: domain, path: path.slice(0, 700), visits7: cur.get(path) ?? 0, prev7: prev.get(path) ?? 0, asOf: date2 }));
  await prisma.$transaction([
    prisma.prjUrlWeek.deleteMany({ where: { site: domain } }),
    ...(rows.length ? [prisma.prjUrlWeek.createMany({ data: rows })] : []),
  ]);
  return rows.length;
}

export type UrlWeek = { visits7: number; prev7: number; asOf: string };
/** Трафик страниц сайтов команды: домен → путь → визиты за 7 дней и предыдущие 7. */
export async function urlWeeks(teamSlug: string): Promise<Map<string, Map<string, UrlWeek>>> {
  const out = new Map<string, Map<string, UrlWeek>>();
  const team = await prisma.team.findUnique({ where: { slug: teamSlug }, select: { id: true } });
  if (!team) return out;
  for (const r of await prisma.prjUrlWeek.findMany({ where: { teamId: team.id }, select: { site: true, path: true, visits7: true, prev7: true, asOf: true } })) {
    (out.get(r.site) ?? out.set(r.site, new Map()).get(r.site)!).set(r.path, { visits7: r.visits7, prev7: r.prev7, asOf: r.asOf });
  }
  return out;
}

/** Домены сайтов команды (как в сетке): доступы, сайты статей, блога и пинов. */
async function teamDomains(teamId: string): Promise<Set<string>> {
  const [access, art, blog, pin] = await Promise.all([
    prisma.siteAccess.findMany({ where: { teamId }, select: { baseUrl: true, name: true } }),
    prisma.artSite.findMany({ where: { teamId }, select: { name: true } }),
    prisma.blogSite.findMany({ where: { teamId }, select: { name: true } }),
    prisma.pinSite.findMany({ where: { teamId }, select: { name: true } }),
  ]);
  return new Set([...access.map((a) => dom(a.baseUrl) || dom(a.name)), ...[...art, ...blog, ...pin].map((s) => dom(s.name))].filter(Boolean));
}

export type MetrikaSync = { counters: number; matched: number; days: number; pinFilter: number };

/** Сбор Метрики команды: счётчики по доменам её сайтов → визиты за 90 дней по дням (люди, с Pinterest, роботы). only — досбор одного домена. */
export async function metrikaSync(teamId: string, only?: string): Promise<MetrikaSync> {
  const row = await prisma.prjMetrikaToken.findUnique({ where: { teamId } });
  if (!row) throw new Error("токен Метрики не задан");
  await prisma.prjMetrikaToken.update({ where: { teamId }, data: { lastTryAt: new Date() } });
  try {
    const token = decryptSecret(row.tokenEnc);
    const [counters, domains] = await Promise.all([metrikaCounters(token), teamDomains(teamId)]);
    const byDomain = new Map<string, number>();
    for (const c of counters) if (domains.has(c.domain) && !byDomain.has(c.domain)) byDomain.set(c.domain, c.id);
    const date2 = addDays(kyiv().slice(0, 10), -1), date1 = addDays(date2, -89);
    let total = 0, pinFilter = 0; const failed: string[] = [];
    for (const [domain, id] of byDomain) {
     if (only && domain !== only) continue;
     try {
      const human = await byTime(token, id, date1, date2, HUMAN);
      let pins: Map<string, number> | null = null;
      for (let i = pinFilter; i < PIN_FILTERS.length && !pins; i++) {
        try { pins = await byTime(token, id, date1, date2, `${HUMAN} AND ${PIN_FILTERS[i]}`); pinFilter = i; }
        catch (e) { if ((e as { status?: number }).status !== 400 || i === PIN_FILTERS.length - 1) throw e; }
      }
      const robots = await byTime(token, id, date1, date2, "ym:s:isRobot=='Yes'").catch(() => new Map<string, number>());
      // Трафик по страницам (кластеры статей в сетке): сбой здесь не отменяет дневной ряд сайта.
      await syncUrlWeeks(token, id, teamId, domain, date2).catch((e) => console.warn(`[metrika] ${domain}: страницы не собраны: ${e instanceof Error ? e.message.slice(0, 120) : String(e)}`));
      await syncUrlHist(token, id, teamId, domain, date2).catch((e) => console.warn(`[metrika] ${domain}: история страниц не собрана: ${e instanceof Error ? e.message.slice(0, 120) : String(e)}`));
      const rows = [...human.keys()].map((d) => ({ source: "metrika", site: domain, teamId, day: d, visits: human.get(d) ?? 0, pinVisits: pins?.get(d) ?? 0, robotVisits: robots.get(d) ?? 0 }));
      if (rows.length) {
        await prisma.$transaction([
          prisma.prjStatDay.deleteMany({ where: { source: "metrika", site: domain, day: { in: rows.map((r) => r.day) } } }),
          prisma.prjStatDay.createMany({ data: rows }),
        ]);
        total += rows.length;
      }
     } catch (e) {
      // Один счётчик не должен срывать сбор остальных; без доступа (401/403) — сразу наружу.
      const st = (e as { status?: number }).status; if (st === 401 || st === 403) throw e;
      failed.push(`${domain}: ${e instanceof Error ? e.message.slice(0, 80) : String(e)}`);
     }
      await new Promise((r) => setTimeout(r, 300));
    }
    if (failed.length && failed.length === (only ? 1 : byDomain.size)) throw new Error(failed[0]);
    const list = counters.map((c) => ({ id: c.id, site: c.domain, matched: byDomain.get(c.domain) === c.id })).slice(0, 500);
    await prisma.prjMetrikaToken.update({ where: { teamId }, data: { lastSyncAt: new Date(), lastError: failed.length ? `не собраны (${failed.length}): ${failed.join("; ")}`.slice(0, 250) : null, counters: list } });
    return { counters: counters.length, matched: byDomain.size, days: total, pinFilter };
  } catch (e) {
    await prisma.prjMetrikaToken.update({ where: { teamId }, data: { lastError: (e instanceof Error ? e.message : String(e)).slice(0, 250) } }).catch(() => null);
    throw e;
  }
}

let metrikaBusy = false;
/** Тик воркера (раз в 10 мин): новый токен — сразу; дальше раз в сутки после 03:00 по Киеву; после сбоя — повтор не чаще раза в час. */
export async function metrikaTick(now = new Date()): Promise<{ synced: string[]; errors: string[] }> {
  if (metrikaBusy) return { synced: [], errors: [] };
  metrikaBusy = true;
  const synced: string[] = [], errors: string[] = [];
  try {
    const k = kyiv(now), today = k.slice(0, 10), hour = Number(k.slice(11, 13));
    for (const t of await prisma.prjMetrikaToken.findMany({ select: { teamId: true, lastSyncAt: true, lastTryAt: true } })) {
      const due = !t.lastSyncAt || (hour >= 3 && kyiv(t.lastSyncAt).slice(0, 10) !== today);
      if (!due || (t.lastTryAt && now.getTime() - t.lastTryAt.getTime() < 60 * 60_000)) continue;
      try { const r = await metrikaSync(t.teamId); synced.push(`${t.teamId}: счётчиков ${r.matched}/${r.counters}, строк ${r.days}`); }
      catch (e) { errors.push(`${t.teamId}: ${e instanceof Error ? e.message : String(e)}`); }
    }
  } finally {
    metrikaBusy = false;
  }
  return { synced, errors };
}

// ───────────────────────────── Вкладка «Трафик» ─────────────────────────────

type Color = "g" | "r" | "y" | "x" | "b";
type Series = Map<string, number>;
const sum = (m: Series, end: string, n: number) => { let s = 0; for (let i = 0; i < n; i++) s += m.get(addDays(end, -i)) ?? 0; return s; };
const fmt = (n: number) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
const pct = (a: number, b: number) => (b > 0 ? `${((a / b) * 100).toFixed(a / b < 0.1 ? 1 : 0)}%` : "—");

/** Клетка «значение ▲/▼ процент» и её цвет: рост от 5% — зелёный, падение от 5% — красный. */
export function cmp(cur: number, prev: number): { text: string; color: Color | null } {
  if (cur === 0 && prev === 0) return { text: "0", color: "x" };
  if (prev === 0) return { text: `${fmt(cur)} ▲ с нуля`, color: "g" };
  const d = Math.round(((cur - prev) / prev) * 100);
  if (d >= 5) return { text: `${fmt(cur)} ▲${d}%`, color: "g" };
  if (d <= -5) return { text: `${fmt(cur)} ▼${-d}%`, color: "r" };
  return { text: `${fmt(cur)} ≈`, color: null };
}

export type WeekCell = { text: string; color: Color | null };
/** До какого закрытого дня Pinterest отдал аналитику хотя бы по одному сайту команды (сам Pinterest задерживает данные на несколько дней). */
export async function pinReadyDay(teamSlug: string): Promise<string | null> {
  const team = await prisma.team.findUnique({ where: { slug: teamSlug }, select: { id: true } });
  if (!team) return null;
  const r = await prisma.prjStatDay.aggregate({ where: { teamId: team.id, source: "pinterest", estimate: false }, _max: { day: true } });
  return r._max.day ?? null;
}
/**
 * Клики на сайт из Pinterest за 7 дней и их изменение к предыдущим 7 — короткая клетка слева от сайта на вкладках ниш.
 * Считается до последнего закрытого дня аккаунта; резкий рост (как на «Трафике»: от +30% и не меньше 20 кликов) — ярко-зелёным.
 */
export async function weekClicks(teamSlug: string, today: string): Promise<Map<string, WeekCell>> {
  const out = new Map<string, WeekCell>();
  const team = await prisma.team.findUnique({ where: { slug: teamSlug }, select: { id: true } });
  if (!team) return out;
  const rows = await prisma.prjStatDay.findMany({ where: { teamId: team.id, source: "pinterest", day: { gte: addDays(today, -30) } }, select: { site: true, day: true, estimate: true, outboundClicks: true } });
  const by = new Map<string, { oc: Series; ready: string | null }>();
  for (const r of rows) {
    const s = by.get(r.site) ?? by.set(r.site, { oc: new Map(), ready: null }).get(r.site)!;
    s.oc.set(r.day, r.outboundClicks ?? 0);
    if (!r.estimate && (!s.ready || r.day > s.ready)) s.ready = r.day;
  }
  for (const [d, s] of by) {
    if (!s.ready) continue;
    const c7 = sum(s.oc, s.ready, 7), p7 = sum(s.oc, addDays(s.ready, -7), 7);
    const c = cmp(c7, p7);
    out.set(d, c7 >= 20 && c7 >= p7 * 1.3 ? { text: c.text, color: "b" } : c);
  }
  return out;
}

/**
 * Вкладка «Трафик»: одна строка = один сайт команды, по убыванию кликов на сайт за 30 дней; слева место и его сдвиг за неделю,
 * резко растущие сайты выделены ярко, в конце — «что сделать» (pinsLeft — на сколько дней расписаны пины, из сетки).
 * Pinterest считается до последнего закрытого дня аккаунта (сегодня и вчера у Pinterest — оценка), Метрика — до вчера.
 */
export async function buildTrafficTab(teamSlug: string, sites: Array<{ domain: string; kind: string; pinsLeft: number | null }>, today: string): Promise<Tab | null> {
  const team = await prisma.team.findUnique({ where: { slug: teamSlug }, select: { id: true } });
  if (!team) return null;
  const teamId = team.id;
  const [rows, pinSites, token] = await Promise.all([
    prisma.prjStatDay.findMany({ where: { teamId, day: { gte: addDays(today, -75) } } }),
    prisma.pinSite.findMany({ where: { teamId }, select: { id: true, name: true, wpConnectionId: true } }),
    prisma.prjMetrikaToken.findUnique({ where: { teamId }, select: { lastSyncAt: true, lastError: true, counters: true } }),
  ]);
  const [access, accounts] = await Promise.all([
    prisma.siteAccess.findMany({ where: { teamId }, select: { id: true, baseUrl: true, name: true } }),
    prisma.uplAccount.findMany({ where: { pinSiteId: { in: pinSites.map((p) => p.id) } }, select: { pinSiteId: true, profileId: true, status: true, statsAt: true, statsNote: true } }),
  ]);
  const accDom = new Map(access.map((a) => [a.id, dom(a.baseUrl) || dom(a.name)]));
  const accBy = new Map(accounts.map((a) => [a.pinSiteId, a]));
  const accOf = new Map<string, (typeof accounts)[number] | null>();
  for (const p of pinSites) { const d = (p.wpConnectionId && accDom.get(p.wpConnectionId)) || dom(p.name); if (d && !accOf.get(d)) accOf.set(d, accBy.get(p.id) ?? null); }

  type S = { im: Series; oc: Series; en: Series; sv: Series; pc: Series; ready: string | null; v: Series; pv: Series; rv: Series; mLast: string | null };
  const data = new Map<string, S>();
  const get = (d: string) => data.get(d) ?? data.set(d, { im: new Map(), oc: new Map(), en: new Map(), sv: new Map(), pc: new Map(), ready: null, v: new Map(), pv: new Map(), rv: new Map(), mLast: null }).get(d)!;
  for (const r of rows) {
    const s = get(r.site);
    if (r.source === "pinterest") {
      s.im.set(r.day, r.impressions ?? 0); s.oc.set(r.day, r.outboundClicks ?? 0); s.en.set(r.day, r.engagements ?? 0); s.sv.set(r.day, r.saves ?? 0); s.pc.set(r.day, r.pinClicks ?? 0);
      if (!r.estimate && (!s.ready || r.day > s.ready)) s.ready = r.day;
    } else {
      s.v.set(r.day, r.visits ?? 0); s.pv.set(r.day, r.pinVisits ?? 0); s.rv.set(r.day, r.robotVisits ?? 0);
      if (!s.mLast || r.day > s.mLast) s.mLast = r.day;
    }
  }
  const matched = new Set(((token?.counters as Array<{ site?: string; matched?: boolean }> | null) ?? []).filter((c) => c.matched).map((c) => c.site));
  const mState = !token ? " (не подключена)" : token.lastError && !token.lastSyncAt ? " (ошибка токена)" : "";

  // Рейтинг: по кликам на сайт за 30 дней (при равенстве — по показам); место неделю назад — те же 30 дней, но окно сдвинуто на 7 дней.
  type Row = { domain: string; kind: string; pinsLeft: number | null; s: S | undefined; oc30: number; im30: number; prev30: number };
  const list: Row[] = sites.map((x) => {
    const s = data.get(x.domain); const e = s?.ready ?? null;
    return { ...x, s, oc30: e ? sum(s!.oc, e, 30) : -1, im30: e ? sum(s!.im, e, 30) : -1, prev30: e ? sum(s!.oc, addDays(e, -7), 30) : -1 };
  });
  const ranked = list.filter((x) => x.oc30 >= 0);
  ranked.sort((a, b) => b.oc30 - a.oc30 || b.im30 - a.im30 || a.domain.localeCompare(b.domain));
  const prevRank = new Map([...ranked].sort((a, b) => b.prev30 - a.prev30 || a.domain.localeCompare(b.domain)).map((x, i) => [x.domain, i + 1]));
  const ordered = [...ranked, ...list.filter((x) => x.oc30 < 0)];

  const h1 = ["№", "САЙТ", "НИША", "PINTEREST · КЛИКИ НА САЙТ", "", "", "PINTEREST · ПОКАЗЫ", "", "", "PINTEREST · ЗА 30 ДНЕЙ", "", "", "", "", "", `МЕТРИКА · ВИЗИТЫ ЛЮДЕЙ${mState}`, "", "", `МЕТРИКА · С PINTEREST${mState}`, "", "", "", "ИТОГ", "", ""];
  const h2 = ["место · за неделю", "", "", "30 дней", "7 дней", "день", "30 дней", "7 дней", "день", "вовлечения", "вовлечённость", "сохранения", "save rate", "клики по пину", "CTR на сайт", "30 дней", "7 дней", "день", "30 дней", "7 дней", "день", "роботы, 30 дн", "данные на", "что сделать", "примечание"];
  const values: (string | number)[][] = [h1, h2];
  const colors: [number, number, Color][] = [];
  ordered.forEach((site, idx) => {
    const r = values.length; const row: (string | number)[] = []; const notes: string[] = []; const fresh: string[] = []; const todo: string[] = [];
    const s = site.s;
    const put = (c: { text: string; color: Color | null }) => { if (c.color) colors.push([r, row.length, c.color]); row.push(c.text); };
    const none = (n: number) => { for (let i = 0; i < n; i++) { colors.push([r, row.length, "x"]); row.push("—"); } };
    const trio = (m: Series, e: string) => { put(cmp(sum(m, e, 30), sum(m, addDays(e, -30), 30))); put(cmp(sum(m, e, 7), sum(m, addDays(e, -7), 7))); put(cmp(m.get(e) ?? 0, m.get(addDays(e, -7)) ?? 0)); };
    if (s?.ready) {
      const rank = idx + 1, was = prevRank.get(site.domain) ?? rank, move = was - rank;
      if (move > 0) colors.push([r, 0, "g"]); else if (move < 0) colors.push([r, 0, "r"]);
      row.push(move > 0 ? `${rank} ▲${move}` : move < 0 ? `${rank} ▼${-move}` : `${rank} =`);
    } else { colors.push([r, 0, "x"]); row.push("—"); }
    row.push(site.domain, site.kind);
    if (s?.ready) {
      const e = s.ready; const im30 = sum(s.im, e, 30);
      trio(s.oc, e); trio(s.im, e);
      put(cmp(sum(s.en, e, 30), sum(s.en, addDays(e, -30), 30))); row.push(pct(sum(s.en, e, 30), im30));
      put(cmp(sum(s.sv, e, 30), sum(s.sv, addDays(e, -30), 30))); row.push(pct(sum(s.sv, e, 30), im30));
      row.push(fmt(sum(s.pc, e, 30))); row.push(pct(sum(s.oc, e, 30), im30));
      fresh.push(`Pinterest ${dm(e)}`);
      if (Date.parse(today) - Date.parse(e) > 4 * 86_400_000) notes.push(`Pinterest не отдал данные после ${dm(e)}`);
      // Резкий рост кликов на сайт: за 7 дней от +30% (и не меньше 20 кликов) или за день вдвое к тому же дню недели (не меньше 10 и без падения за неделю).
      const c7 = sum(s.oc, e, 7), p7 = sum(s.oc, addDays(e, -7), 7), c1 = s.oc.get(e) ?? 0, p1 = s.oc.get(addDays(e, -7)) ?? 0;
      const up7 = c7 >= 20 && c7 >= p7 * 1.3, up1 = c1 >= 10 && c1 >= p1 * 2 && c7 >= p7 * 0.9;
      const grow = (c: number, p: number) => (p > 0 ? `+${Math.round(((c - p) / p) * 100)}%` : "с нуля");
      if (up7 || up1) {
        colors.push([r, 1, "b"]);
        const why = [up7 ? `за 7 дней ${grow(c7, p7)}` : "", up1 ? `за день ${grow(c1, p1)}` : ""].filter(Boolean).join(", ");
        const stock = site.pinsLeft == null ? "пинов в расписании нет — срочно сделать и залить" : site.pinsLeft < 0 ? "пины закончились — срочно сделать и залить" : site.pinsLeft <= 14 ? `пинов осталось на ${site.pinsLeft} дн. — сделать ещё` : "добавить пинов на статьи, которые дают клики";
        todo.push(`РАСТЁТ (клики ${why}): ${stock}`);
      } else if (p7 >= 20 && c7 <= p7 * 0.7) {
        todo.push(`падает: клики за 7 дней ${Math.round(((c7 - p7) / p7) * 100)}% — проверить заливку и аккаунт`);
        colors.push([r, 23, "r"]);
      }
    } else {
      none(12);
      const a = accOf.get(site.domain);
      notes.push(a === undefined ? "Pinterest: сайта нет в «Пинах»" : !a?.profileId ? "Pinterest: профиль Dolphin не сопоставлен" : a.status === "needs_login" ? "Pinterest: в профиле нет входа" : a.statsNote ? `Pinterest: ${a.statsNote}` : "Pinterest: аналитика ещё не собрана");
    }
    if (s?.mLast) {
      const e = s.mLast;
      trio(s.v, e); trio(s.pv, e);
      const hv = sum(s.v, e, 30), rb = sum(s.rv, e, 30);
      const share = hv + rb > 0 ? rb / (hv + rb) : 0;
      if (share >= 0.3) colors.push([r, row.length, "y"]);
      row.push(hv + rb > 0 ? `${Math.round(share * 100)}%` : "—");
      fresh.push(`Метрика ${dm(e)}`);
    } else {
      none(7);
      if (token) notes.push(matched.has(site.domain) ? "Метрика: визитов нет" : token.lastSyncAt ? "Метрика: нет счётчика для сайта" : token.lastError ? `Метрика: ${token.lastError}` : "Метрика: первый сбор ещё идёт");
    }
    const a = accOf.get(site.domain);
    if (s?.ready && a?.statsAt && Date.now() - a.statsAt.getTime() > 3 * 86_400_000) notes.push(`Pinterest: не обновлялось с ${dm(kyiv(a.statsAt).slice(0, 10))}`);
    row.push(fresh.join(" · ") || "—", todo.join("; "), notes.join("; "));
    values.push(row);
  });
  const widths: Record<number, number> = { 0: 75, 1: 200, 2: 85, 22: 150, 23: 360, 24: 300 };
  for (let c = 3; c <= 21; c++) widths[c] = c === 5 || c === 8 || c === 17 || c === 20 ? 105 : 115;
  return {
    title: TRAFFIC_TAB, values, colors,
    merges: [[0, 1, 1, 2], [0, 1, 2, 3], [0, 1, 3, 6], [0, 1, 6, 9], [0, 1, 9, 15], [0, 1, 15, 18], [0, 1, 18, 22], [0, 1, 22, 25]],
    widths, dates: [], groups: [3, 6, 9, 15, 18, 22], cols: h1.length, noteCol: -1, frozenCols: 2,
  };
}
