/** «Стилист»: доступ, фильтр каталога и выборки для страниц. */
import { cookies } from "next/headers";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import type { CurrentUser } from "@/lib/auth";
import { CATEGORIES, COLORS, GEOS, SEGMENTS, TAGS } from "./consts";
import { BRAND_NAMES } from "./dna";
import { teamId } from "./team";

export { teamId };

export const LOOK_COOKIE = "zx_st_look";
export const PAGE_SIZE = 60;

/* ---------- Доступ: администраторы и команда Zewex ---------- */

export async function canSee(me: CurrentUser): Promise<boolean> {
  if (me.role === "ADMIN") return true;
  const id = await teamId();
  return !!id && me.teamIds.includes(id);
}

export async function assertSee(me: CurrentUser): Promise<void> {
  if (!(await canSee(me))) throw new Error("«Стилист» открыт команде Zewex");
}

/* ---------- Фильтр каталога ---------- */

export type Filter = {
  geo: string; gender: string; cat: string; store: string; seg: string; color: string; size: string; tags: string[];
  spirit: string; q: string; pmin: number | null; pmax: number | null; sort: string; all: boolean; sale: boolean; page: number;
};

const oneOf = (v: string | undefined, list: readonly string[], def: string) => (v && list.includes(v) ? v : def);
const numOr = (v: string | undefined) => {
  const n = Number((v ?? "").replace(",", "."));
  return v && Number.isFinite(n) && n >= 0 ? n : null;
};

export function parseFilter(get: (k: string) => string | undefined, getAll: (k: string) => string[]): Filter {
  const tagIds = TAGS.map((t) => t.id as string);
  return {
    geo: oneOf(get("geo"), GEOS.map((g) => g.id), "MT"),
    gender: oneOf(get("gender"), ["woman", "man", "kids", "any"], "woman"),
    cat: oneOf(get("cat"), CATEGORIES.map((c) => c.id), ""),
    store: (get("store") ?? "").slice(0, 60),
    seg: oneOf(get("seg"), SEGMENTS.map((s) => s.id), ""),
    color: oneOf(get("color"), COLORS.map((c) => c.id), ""),
    size: (get("size") ?? "").trim().toUpperCase().slice(0, 12).replace(/\|/g, ""),
    tags: [...new Set(getAll("tag").filter((t) => tagIds.includes(t)))].slice(0, 6),
    spirit: BRAND_NAMES[get("spirit") ?? ""] || get("spirit") === "any" ? (get("spirit") as string) : "",
    q: (get("q") ?? "").trim().slice(0, 80),
    pmin: numOr(get("pmin")),
    pmax: numOr(get("pmax")),
    sort: oneOf(get("sort"), ["new", "price_asc", "price_desc"], "new"),
    all: get("all") === "1",
    sale: get("sale") === "1",
    page: Math.max(1, Math.min(500, Math.floor(Number(get("page")) || 1))),
  };
}

/** Параметры адреса для текущего фильтра с заменой части полей (значения по умолчанию в адрес не пишутся). */
export function filterQuery(f: Filter, patch: Partial<Filter> & { analog?: string } = {}, analog = ""): string {
  const v = { ...f, ...patch };
  const q = new URLSearchParams();
  if (v.geo !== "MT") q.set("geo", v.geo);
  if (v.gender !== "woman") q.set("gender", v.gender);
  for (const k of ["cat", "store", "seg", "color", "size", "spirit", "q"] as const) if (v[k]) q.set(k, v[k]);
  for (const t of v.tags) q.append("tag", t);
  if (v.pmin != null) q.set("pmin", String(v.pmin));
  if (v.pmax != null) q.set("pmax", String(v.pmax));
  if (v.sort !== "new") q.set("sort", v.sort);
  if (v.all) q.set("all", "1");
  if (v.sale) q.set("sale", "1");
  if (v.page > 1) q.set("page", String(v.page));
  const a = patch.analog ?? analog;
  if (a) q.set("analog", a);
  const s = q.toString();
  return s ? `?${s}` : "";
}

/** Условие выборки. `skip` — поле, которое не учитывать (для счётчиков на вкладках магазинов и типов). */
export function filterWhere(f: Filter, skip: "store" | "cat" | "" = ""): Prisma.StItemWhereInput {
  const and: Prisma.StItemWhereInput[] = [{ store: { geo: f.geo, ...(f.seg ? { segment: f.seg } : {}) } }];
  if (f.gender !== "any") and.push({ gender: { in: [f.gender, "unisex"] } });
  if (f.cat && skip !== "cat") and.push({ category: f.cat });
  if (f.store && skip !== "store") and.push({ store: { brand: f.store } });
  if (f.color) and.push({ color: f.color });
  if (f.size) and.push({ sizes: { contains: `|${f.size}|` } });
  if (f.spirit) and.push(f.spirit === "any" ? { spirit: { not: "" } } : { spirit: { contains: `|${f.spirit}|` } });
  for (const t of f.tags) and.push({ tags: { contains: `|${t}|` } });
  if (f.q) and.push({ OR: [{ name: { contains: f.q } }, { colorName: { contains: f.q } }, { rawCategory: { contains: f.q } }] });
  if (f.pmin != null) and.push({ priceEur: { gte: f.pmin } });
  if (f.pmax != null) and.push({ priceEur: { lte: f.pmax } });
  if (!f.all) and.push({ inStock: true });
  if (f.sale) and.push({ oldPrice: { not: null } });
  return { AND: and };
}

const ITEM_INCLUDE = { store: { select: { id: true, name: true, brand: true, segment: true, geo: true, adapter: true } } } satisfies Prisma.StItemInclude;
export type CatalogItem = Prisma.StItemGetPayload<{ include: typeof ITEM_INCLUDE }>;

export async function listItems(f: Filter): Promise<{ rows: CatalogItem[]; total: number; byBrand: Array<{ brand: string; count: number }>; byCat: Record<string, number> }> {
  const where = filterWhere(f);
  const orderBy: Prisma.StItemOrderByWithRelationInput[] = f.sort === "price_asc" ? [{ priceEur: "asc" }, { id: "asc" }] : f.sort === "price_desc" ? [{ priceEur: "desc" }, { id: "asc" }] : [{ firstSeenAt: "desc" }, { id: "asc" }];
  const [rows, total, stores, cats] = await Promise.all([
    prisma.stItem.findMany({ where, orderBy, skip: (f.page - 1) * PAGE_SIZE, take: PAGE_SIZE, include: ITEM_INCLUDE }),
    prisma.stItem.count({ where }),
    prisma.stItem.groupBy({ by: ["storeId"], where: filterWhere(f, "store"), _count: { _all: true } }),
    prisma.stItem.groupBy({ by: ["category"], where: filterWhere(f, "cat"), _count: { _all: true } }),
  ]);
  const names = new Map((await prisma.stStore.findMany({ where: { id: { in: stores.map((s) => s.storeId) } }, select: { id: true, brand: true } })).map((s) => [s.id, s.brand]));
  const brands = new Map<string, number>();
  for (const s of stores) {
    const b = names.get(s.storeId) ?? "?";
    brands.set(b, (brands.get(b) ?? 0) + s._count._all);
  }
  return {
    rows,
    total,
    byBrand: [...brands.entries()].map(([brand, count]) => ({ brand, count })).sort((a, b) => b.count - a.count),
    byCat: Object.fromEntries(cats.map((c) => [c.category, c._count._all])),
  };
}

/* ---------- Образы ---------- */

const LOOK_INCLUDE = {
  items: { orderBy: [{ order: "asc" }, { createdAt: "asc" }], include: { item: { include: ITEM_INCLUDE } } },
} satisfies Prisma.StLookInclude;
export type LookFull = Prisma.StLookGetPayload<{ include: typeof LOOK_INCLUDE }>;
export type LookPiece = LookFull["items"][number];

/** Образы видит команда Zewex и администраторы; чужой команды — нет. */
export async function lookWhere(me: CurrentUser): Promise<Prisma.StLookWhereInput> {
  if (me.role === "ADMIN") return {};
  return { teamId: (await teamId()) ?? "-" };
}

export async function getLook(me: CurrentUser, id: string): Promise<LookFull | null> {
  return prisma.stLook.findFirst({ where: { AND: [{ id }, await lookWhere(me)] }, include: LOOK_INCLUDE });
}

export async function listLooks(me: CurrentUser): Promise<LookFull[]> {
  return prisma.stLook.findMany({ where: await lookWhere(me), orderBy: { updatedAt: "desc" }, take: 200, include: LOOK_INCLUDE });
}

/** Образ, в который сейчас складываются вещи из каталога (cookie); null — не выбран или удалён. */
export async function activeLook(me: CurrentUser): Promise<LookFull | null> {
  const id = (await cookies()).get(LOOK_COOKIE)?.value;
  return id ? getLook(me, id) : null;
}

export type LookTotals = {
  /** Основные вещи без аналогов. */
  pieces: number;
  eur: number;
  /** Сумма в валюте магазинов, если она у всех вещей одна и не евро. */
  native: { currency: string; sum: number } | null;
  /** Если в каждой позиции взять самый дешёвый вариант (основная вещь или аналог). */
  minEur: number;
  outOfStock: number;
};

export function lookTotals(look: LookFull): LookTotals {
  const main = look.items.filter((p) => !p.parentId);
  const eur = main.reduce((s, p) => s + p.item.priceEur, 0);
  const curs = new Set(main.map((p) => p.item.currency));
  const one = curs.size === 1 ? [...curs][0] : "";
  const minEur = main.reduce((s, p) => s + Math.min(p.item.priceEur, ...look.items.filter((a) => a.parentId === p.id).map((a) => a.item.priceEur)), 0);
  return {
    pieces: main.length,
    eur: Math.round(eur * 100) / 100,
    native: one && one !== "EUR" ? { currency: one, sum: Math.round(main.reduce((s, p) => s + p.item.price, 0) * 100) / 100 } : null,
    minEur: Math.round(minEur * 100) / 100,
    outOfStock: main.filter((p) => !p.item.inStock).length,
  };
}
