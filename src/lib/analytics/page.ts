import type { CurrentUser } from "@/lib/auth";
import { visibleSites, type GroupRef, type SiteRef } from "./access";
import { parseRange, rangeParams, todayIn, type Range } from "./period";
import { DEFAULT_TZ } from "./types";

/**
 * Общее для экранов кабинета: сайты и группы пользователя, разобранный период, выбранная группа,
 * сборка ссылок с сохранением периода.
 */
export type Params = Record<string, string | string[] | undefined>;
export const one = (params: Params, k: string) => (Array.isArray(params[k]) ? (params[k] as string[])[0] : (params[k] as string | undefined));

export type Ctx = {
  sites: SiteRef[];
  groups: GroupRef[];
  range: Range;
  group: GroupRef | undefined;
  /** Сайты после фильтра по группе */
  list: SiteRef[];
  ids: string[];
  /** Параметры периода для ссылок */
  qs: string;
  link: (path: string, extra?: Record<string, string | undefined>) => string;
};

export async function analyticsContext(me: CurrentUser, params: Params, tz = DEFAULT_TZ): Promise<Ctx> {
  const { sites, groups } = await visibleSites(me);
  const range = parseRange(params, todayFor(tz));
  const group = groups.find((g) => g.id === one(params, "group"));
  const list = group ? sites.filter((s) => s.groupIds.includes(group.id)) : sites;
  const base = { ...rangeParams(range), ...(group ? { group: group.id } : {}) };
  const qs = new URLSearchParams(base).toString();
  const link = (path: string, extra: Record<string, string | undefined> = {}) => {
    const q = new URLSearchParams(Object.entries({ ...base, ...extra }).filter(([, v]) => v) as [string, string][]).toString();
    return q ? `${path}?${q}` : path;
  };
  return { sites, groups, range, group, list, ids: list.map((s) => s.id), qs, link };
}

export const todayFor = (tz: string) => todayIn(tz);

export const prevLabel = (r: Range) => (r.compare === "year" ? "прошлый год" : "прошлый период");
