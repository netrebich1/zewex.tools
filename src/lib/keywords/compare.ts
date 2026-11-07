/**
 * Сравнение выдачи двух аккаунтов Pinterest на одной выборке ключей.
 * Выдача персонализирована под аккаунт, а решение по ключу мы принимаем по снимку с одного аккаунта. Здесь меряем,
 * насколько два аккаунта видят одно и то же: совпадение пинов топ-10 и топ-3, сдвиг позиций, вердикт и оценка.
 */
import { prisma } from "@/lib/db";
import { enqueue } from "./collector";
import { positionSignals, score, verdict } from "./metrics";
import { MIN_VOLUME, NICHES, type SerpAgg, type TopTuple, type Verdict } from "./types";

export const COMPARE_DEFAULT = 25;

type SnapPin = { position: number; pinId: string | null; link: string | null; createdAt: Date | null; saves: number | null };
type Snap = { takenAt: Date; agg: SerpAgg; pins: SnapPin[] };

/** Ключ пина для сравнения: id пина, а у старых снимков без id — ссылка + дата пина. */
const pinKey = (p: SnapPin) => p.pinId ?? `${p.link ?? ""}|${p.createdAt?.toISOString().slice(0, 10) ?? ""}|${p.saves ?? ""}`;
const topOf = (s: Snap): TopTuple[] => s.pins.map((p) => [p.link ?? "", p.createdAt ? p.createdAt.toISOString().slice(0, 10) : "", p.saves ?? ""]);

/** Перемешивание (Фишер — Йейтс). */
function shuffle<T>(a: T[]): T[] {
  const r = [...a];
  for (let i = r.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [r[i], r[j]] = [r[j], r[i]];
  }
  return r;
}

/**
 * Новая выборка: ключи с частотностью от 3000 (лист Evergreen и взятые в работу, без сезонных), поровну по нишам,
 * случайно из 400 самых частотных. Каждый ключ ставится в очередь выдачи для обоих аккаунтов.
 */
export async function createCompare(accountAId: string, accountBId: string, count: number, by: string) {
  if (accountAId === accountBId) throw new Error("Выберите два разных аккаунта");
  const accs = await prisma.kwAccount.findMany({ where: { id: { in: [accountAId, accountBId] } }, select: { id: true } });
  if (accs.length !== 2) throw new Error("Аккаунт не найден");
  const n = Math.max(5, Math.min(60, Math.round(count) || COMPARE_DEFAULT));
  const pool = await prisma.kwKeyword.findMany({
    where: { volume: { gte: MIN_VOLUME }, season: { not: "hard" }, OR: [{ source: "sheet" }, { status: { in: ["picked", "sent"] } }] },
    orderBy: { volume: "desc" }, take: 400, select: { id: true, niche: true },
  });
  if (!pool.length) throw new Error("Нет ключей с частотностью от 3000 — сначала загрузите данные");
  const byNiche = NICHES.map((x) => shuffle(pool.filter((k) => k.niche === x.key)));
  const rest = shuffle(pool.filter((k) => !NICHES.some((x) => x.key === k.niche)));
  const ids: string[] = [];
  for (let i = 0; ids.length < n && i < 400; i++) for (const list of [...byNiche, rest]) if (list[i] && ids.length < n) ids.push(list[i].id);
  const cmp = await prisma.kwCompare.create({ data: { accountAId, accountBId, keywordIds: ids, createdBy: by.slice(0, 190) } });
  const qa = await enqueue("serp", ids, accountAId);
  const qb = await enqueue("serp", ids, accountBId);
  return { id: cmp.id, keywords: ids.length, queued: qa + qb };
}

export type PairRow = {
  id: string; phrase: string; niche: string; volume: number | null;
  state: "waiting" | "one" | "pair";
  /** Совпадение топ-10 и топ-3, % (общие пины / пинов в большем из двух топов) */
  overlap10: number | null; overlap3: number | null;
  /** Средний сдвиг позиции общих пинов */
  shift: number | null;
  a: Side | null; b: Side | null;
  hoursApart: number | null;
};
type Side = { takenAt: string; verdict: Verdict | null; score: number | null; ad: number; prod: number; fresh3: number; n: number; med: number | null };

const side = (s: Snap, vol: number | null): Side => ({
  takenAt: s.takenAt.toISOString(), verdict: verdict(vol, s.agg), score: score(vol, s.agg, { pos: positionSignals(topOf(s), s.takenAt) }),
  ad: s.agg.ad, prod: s.agg.prod, fresh3: s.agg.fresh3, n: s.agg.n, med: s.agg.med,
});

/** Сравнение по пинам двух снимков одного ключа. */
export function comparePins(a: SnapPin[], b: SnapPin[]) {
  const ka = a.slice(0, 10).map(pinKey), kb = b.slice(0, 10).map(pinKey);
  const setB = new Map(kb.map((k, i) => [k, i]));
  const shared = ka.map((k, i) => (setB.has(k) ? Math.abs(i - setB.get(k)!) : null)).filter((v): v is number => v != null);
  const base = Math.max(ka.length, kb.length);
  const top3b = new Set(kb.slice(0, 3));
  const base3 = Math.max(Math.min(3, ka.length), Math.min(3, kb.length));
  return {
    overlap10: base ? Math.round((100 * shared.length) / base) : null,
    overlap3: base3 ? Math.round((100 * ka.slice(0, 3).filter((k) => top3b.has(k)).length) / base3) : null,
    shift: shared.length ? Math.round((10 * shared.reduce((p, q) => p + q, 0)) / shared.length) / 10 : null,
  };
}

/** Результат выборки: только снимки, снятые после её создания (пары свежие и честные). */
export async function compareResult(id: string) {
  const cmp = await prisma.kwCompare.findUnique({ where: { id } });
  if (!cmp) return null;
  const ids = (cmp.keywordIds as string[]) ?? [];
  const [accounts, keywords, snaps, open] = await Promise.all([
    prisma.kwAccount.findMany({ where: { id: { in: [cmp.accountAId, cmp.accountBId] } }, select: { id: true, name: true } }),
    prisma.kwKeyword.findMany({ where: { id: { in: ids } }, select: { id: true, phrase: true, niche: true, volume: true, volNone: true } }),
    prisma.kwSerpSnapshot.findMany({
      where: { keywordId: { in: ids }, accountId: { in: [cmp.accountAId, cmp.accountBId] }, takenAt: { gte: cmp.createdAt } },
      orderBy: { takenAt: "desc" },
      select: { keywordId: true, accountId: true, takenAt: true, agg: true, pins: { orderBy: { position: "asc" }, select: { position: true, pinId: true, link: true, createdAt: true, saves: true } } },
    }),
    prisma.kwTask.groupBy({ by: ["accountId"], where: { kind: "serp", keywordId: { in: ids }, accountId: { in: [cmp.accountAId, cmp.accountBId] }, status: { in: ["QUEUED", "LEASED"] }, createdAt: { gte: cmp.createdAt } }, _count: { _all: true } }),
  ]);
  const name = new Map(accounts.map((a) => [a.id, a.name]));
  const latest = new Map<string, Snap>();
  for (const s of snaps) {
    const k = `${s.keywordId}|${s.accountId}`;
    if (!latest.has(k) && (s.agg as SerpAgg)?.n) latest.set(k, { takenAt: s.takenAt, agg: s.agg as SerpAgg, pins: s.pins });
  }
  const order = new Map(ids.map((x, i) => [x, i]));
  const rows: PairRow[] = keywords.sort((x, y) => order.get(x.id)! - order.get(y.id)!).map((k) => {
    const vol = k.volNone ? 0 : k.volume;
    const sa = latest.get(`${k.id}|${cmp.accountAId}`) ?? null;
    const sb = latest.get(`${k.id}|${cmp.accountBId}`) ?? null;
    const base = { id: k.id, phrase: k.phrase, niche: k.niche, volume: k.volume, a: sa ? side(sa, vol) : null, b: sb ? side(sb, vol) : null };
    if (!sa || !sb) return { ...base, state: sa || sb ? "one" : "waiting", overlap10: null, overlap3: null, shift: null, hoursApart: null };
    return { ...base, state: "pair", ...comparePins(sa.pins, sb.pins), hoursApart: Math.round(Math.abs(sa.takenAt.getTime() - sb.takenAt.getTime()) / 36e5) };
  });
  const pairs = rows.filter((r) => r.state === "pair");
  const avg = (a: number[]) => (a.length ? Math.round(a.reduce((p, q) => p + q, 0) / a.length) : null);
  const withVerdict = pairs.filter((r) => r.a!.verdict && r.b!.verdict);
  const scored = pairs.filter((r) => r.a!.score != null && r.b!.score != null);
  const summary = {
    total: rows.length, pairs: pairs.length,
    queued: Object.fromEntries(open.map((o) => [o.accountId ?? "", o._count._all])) as Record<string, number>,
    overlap10: avg(pairs.map((r) => r.overlap10!).filter((v) => v != null)),
    overlap3: avg(pairs.map((r) => r.overlap3!).filter((v) => v != null)),
    sameVerdict: withVerdict.length ? Math.round((100 * withVerdict.filter((r) => r.a!.verdict === r.b!.verdict).length) / withVerdict.length) : null,
    verdictPairs: withVerdict.length,
    scoreDiff: avg(scored.map((r) => Math.abs(r.a!.score! - r.b!.score!))),
    bigScoreDiff: scored.filter((r) => Math.abs(r.a!.score! - r.b!.score!) >= 15).length,
  };
  return { cmp, accountA: name.get(cmp.accountAId) ?? "—", accountB: name.get(cmp.accountBId) ?? "—", rows, summary };
}
export type CompareResult = NonNullable<Awaited<ReturnType<typeof compareResult>>>;

/**
 * Вывод для владельца по итогам выборки. Пороги — рабочие: совпадение топ-10 от 70% — выдача почти одна,
 * 40–70% — заметно отличается, ниже 40% — сильно персонализирована. Главное для решения — совпадение вердикта и оценки.
 */
export function conclusion(s: CompareResult["summary"]): { tone: "ok" | "warn" | "danger" | "neutral"; text: string } {
  if (s.pairs < 5) return { tone: "neutral", text: `Пока снято пар: ${s.pairs} из ${s.total}. Вывод появится от 5 пар; честнее — когда снимутся все.` };
  const o = s.overlap10 ?? 0;
  const sv = s.sameVerdict ?? 0;
  const sd = s.scoreDiff ?? 0;
  if (sv >= 85 && sd <= 8) return { tone: "ok", text: `Снимку с одного аккаунта можно доверять: топ-10 совпадает на ${o}%, вердикт один и тот же в ${sv}% ключей, оценка расходится в среднем на ${sd}.` };
  if (sv >= 65 && sd <= 15) return { tone: "warn", text: `Снимку с одного аккаунта можно доверять для отбора, но пограничные ключи (оценка 35–60) лучше снимать с двух: вердикт совпадает в ${sv}% ключей, топ-10 — на ${o}%, оценка расходится в среднем на ${sd}.` };
  return { tone: "danger", text: `Выдача сильно зависит от аккаунта: вердикт совпадает только в ${sv}% ключей, топ-10 — на ${o}%, оценка расходится в среднем на ${sd}. Перед решением снимайте ключ с двух аккаунтов.` };
}
