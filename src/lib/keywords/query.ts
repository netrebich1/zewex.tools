import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { FIELD, FIELDS, filterSpec, type FilterUnit } from "./fields";
import { MIN_VOLUME, type KwMetrics } from "./types";

export type Tab = "main" | "new";
export type Params = Record<string, string | undefined>;

const num = (v: string | undefined) => (v != null && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
const list = (v: string | undefined) => (v ? v.split(",").map((x) => x.trim()).filter(Boolean) : []);

/**
 * Фильтры из адреса:
 *  • числа из реестра fields.ts — `<ключ>_min` и `<ключ>_max` (от и до, включительно; для дат — давность в днях);
 *    `fu=cnt` — значения в штуках, иначе в процентах (см. filterSpec);
 *  • частотность по умолчанию от 3000 (`volume_min=0` — без порога);
 *  • списки (несколько значений через запятую): verdict, niche, season (по умолчанию без сезонных), status, source, acc, prev (прошлый вердикт);
 *  • флаги: `flag` — все перечисленные есть, `noflag` — ни одного из перечисленных;
 *  • `q` — ключ содержит, `qx` — ключ не содержит ни одного из слов (через запятую); `changed=1` — вердикт сменился с прошлого снимка;
 *  • `data`: serp | noserp | novol.
 */
export function keywordWhere(tab: Tab, p: Params, now = new Date()): Prisma.KwKeywordWhereInput {
  const and: Prisma.KwKeywordWhereInput[] = [];
  // «Ключи» — лист Evergreen и взятые в работу новые; «Новые» — остальные кандидаты.
  and.push(tab === "main" ? { OR: [{ source: "sheet" }, { status: { in: ["picked", "sent"] } }] } : { source: { not: "sheet" }, status: { in: ["new", "rejected"] } });
  if (p.q?.trim()) and.push({ phrase: { contains: p.q.trim() } });
  for (const w of list(p.qx)) and.push({ NOT: { phrase: { contains: w } } });
  const inList = (field: keyof Prisma.KwKeywordWhereInput, v: string | undefined) => {
    const vals = list(v);
    if (vals.length) and.push({ [field]: { in: vals } });
  };
  inList("verdict", p.verdict);
  inList("niche", p.niche);
  inList("status", p.status);
  inList("source", p.source);
  inList("serpAccountId", p.acc);
  inList("prevVerdict", p.prev);
  // Сезонные (hard) по умолчанию скрыты, как в листе Evergreen.
  if (p.season) inList("season", p.season);
  else and.push({ season: { not: "hard" } });
  for (const f of list(p.flag)) and.push({ flags: { contains: f } });
  for (const f of list(p.noflag)) and.push({ NOT: { flags: { contains: f } } });
  if (p.changed === "1") and.push({ verdictChanged: true });
  if (p.data === "serp") and.push({ serpAt: { not: null } });
  if (p.data === "noserp") and.push({ serpAt: null });
  if (p.data === "novol") and.push({ volAt: null });

  const mode: FilterUnit = p.fu === "cnt" ? "cnt" : "pct";
  for (const f of FIELDS) {
    const spec = filterSpec(f, mode);
    let lo = num(p[`${f.key}_min`]);
    let hi = num(p[`${f.key}_max`]);
    if (spec.factor !== 1) { lo = lo == null ? null : lo * spec.factor; hi = hi == null ? null : hi * spec.factor; }
    if (f.key === "volume") lo = lo == null ? MIN_VOLUME : lo > 0 ? lo : null;
    if (lo == null && hi == null) continue;
    if (f.kind === "days") {
      // Давность в днях: «от N» = дата не позже now − N дней, «до N» = не раньше now − N.
      const day = 864e5;
      and.push({ [f.col]: { ...(lo != null ? { lte: new Date(now.getTime() - lo * day) } : {}), ...(hi != null ? { gte: new Date(now.getTime() - hi * day) } : {}) } });
    } else {
      and.push({ [spec.col]: { ...(lo != null ? { gte: lo } : {}), ...(hi != null ? { lte: hi } : {}) } });
    }
  }
  return { AND: and };
}

export function keywordOrder(p: Params): Prisma.KwKeywordOrderByWithRelationInput[] {
  const key = p.sort || "score";
  const desc = (p.dir ?? (key === "phrase" ? "asc" : "desc")) === "desc";
  const dir = desc ? "desc" : "asc";
  if (key === "phrase") return [{ phrase: dir }];
  const f = FIELD.get(key);
  const col = f?.col ?? "score";
  // Для дат «по убыванию давности» = сначала старые, т. е. дата по возрастанию.
  const d = f?.kind === "days" ? (desc ? "asc" : "desc") : dir;
  return [{ [col]: { sort: d, nulls: "last" } }, { volume: { sort: "desc", nulls: "last" } }, { phrase: "asc" }];
}

const BUCKETS = [
  { label: "< 3 тыс", min: 0, max: 3000 },
  { label: "3–10 тыс", min: 3000, max: 10_000 },
  { label: "10–50 тыс", min: 10_000, max: 50_000 },
  { label: "50–300 тыс", min: 50_000, max: 300_000 },
  { label: "300 тыс – 1 млн", min: 300_000, max: 1_000_000 },
  { label: "> 1 млн", min: 1_000_000, max: null },
] as const;

/** Сводка по выборке: вердикты и корзины частотности (для карточек и графиков). */
export async function keywordSummary(where: Prisma.KwKeywordWhereInput) {
  const [total, withSerp, byVerdict, avg, buckets, changed] = await Promise.all([
    prisma.kwKeyword.count({ where }),
    prisma.kwKeyword.count({ where: { AND: [where, { serpAt: { not: null } }] } }),
    prisma.kwKeyword.groupBy({ by: ["verdict"], where, _count: { _all: true } }),
    prisma.kwKeyword.aggregate({ where, _avg: { score: true, entryNew: true, entryOld: true } }),
    Promise.all(BUCKETS.map((b) => prisma.kwKeyword.count({ where: { AND: [where, { volume: { gte: b.min, ...(b.max != null ? { lt: b.max } : {}) } }] } }))),
    prisma.kwKeyword.count({ where: { AND: [where, { verdictChanged: true }] } }),
  ]);
  const verdicts: Record<string, number> = {};
  for (const g of byVerdict) verdicts[g.verdict ?? ""] = g._count._all;
  const r = (v: number | null) => (v != null ? Math.round(v) : null);
  return {
    total, withSerp, verdicts, changed,
    avgScore: r(avg._avg.score), avgNew: r(avg._avg.entryNew), avgOld: r(avg._avg.entryOld),
    buckets: BUCKETS.map((b, i) => ({ label: b.label, count: buckets[i] })),
  };
}
export type KeywordSummary = Awaited<ReturnType<typeof keywordSummary>>;

/** Все колонки строки таблицы: служебные + каждое поле реестра + metrics (из него берутся количества). */
export const ROW_SELECT = {
  id: true, phrase: true, niche: true, source: true, season: true, status: true,
  volume: true, volNone: true, verdict: true, prevVerdict: true, verdictChanged: true, flags: true, withYear: true, serpAccountId: true, metrics: true,
  ...Object.fromEntries(FIELDS.map((f) => [f.col, true])),
} as Prisma.KwKeywordSelect;

/** Строка таблицы для клиента: значения полей по ключам реестра и количества для «n · %» (без тяжёлого metrics). */
export type TableRow = {
  id: string; phrase: string; niche: string; source: string; season: string; status: string;
  verdict: string | null; prevVerdict: string | null; verdictChanged: boolean; flags: string; withYear: boolean; volNone: boolean; account: string | null;
  v: Record<string, number | null>;
  counts: Record<string, number | null>;
};

export function toTableRow(r: Record<string, unknown>, accName: Map<string, string>, now = new Date()): TableRow {
  const m = (r.metrics as KwMetrics | null) ?? null;
  const a = m?.agg;
  const v: Record<string, number | null> = {};
  for (const f of FIELDS) {
    const x = r[f.col];
    if (f.kind === "days") v[f.key] = x instanceof Date ? Math.max(0, Math.floor((now.getTime() - x.getTime()) / 864e5)) : null;
    else v[f.key] = typeof x === "number" ? x : null;
  }
  const counts: Record<string, number | null> = {
    com: a ? a.ad + a.prod : null, ad: a?.ad ?? null, prod: a?.prod ?? null, info: a?.info ?? null, nolink: a?.nolink ?? null, video: a?.video ?? null,
    tmatch: a?.tmatch ?? null, own: a?.own ?? null, resaved: a?.resaved ?? null, fresh3: a?.fresh3 ?? null, fresh: a?.fresh ?? null,
    biz: m?.prof?.biz ?? null, dv: m?.prof?.dv ?? null, mer: m?.prof?.mer ?? null, blogs: m?.blogs?.blogs ?? null, ty: a?.ty ?? null,
  };
  return {
    id: r.id as string, phrase: r.phrase as string, niche: r.niche as string, source: r.source as string, season: r.season as string, status: r.status as string,
    verdict: (r.verdict as string | null) ?? null, prevVerdict: (r.prevVerdict as string | null) ?? null, verdictChanged: !!r.verdictChanged,
    flags: (r.flags as string) ?? "", withYear: !!r.withYear, volNone: !!r.volNone,
    account: r.serpAccountId ? accName.get(r.serpAccountId as string) ?? null : null, v, counts,
  };
}
