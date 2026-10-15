import { analyticsUser, visibleSites } from "@/lib/analytics/access";
import { pages, perSite, type PageSort } from "@/lib/analytics/query";
import { parseRange } from "@/lib/analytics/period";
import { DEFAULT_TZ } from "@/lib/analytics/types";

export const dynamic = "force-dynamic";

const cell = (v: unknown) => {
  const s = v == null ? "" : String(v);
  return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csv = (rows: unknown[][]) => "﻿" + rows.map((r) => r.map(cell).join(";")).join("\n");

/**
 * GET /api/analytics/export?kind=pages|sites&<период>&site=&group=&q=&sort= → CSV (разделитель «;», для Excel/Google Таблиц).
 */
export async function GET(req: Request) {
  const me = await analyticsUser();
  if (!me) return new Response("Нет доступа", { status: 401 });
  const params = Object.fromEntries(new URL(req.url).searchParams);
  const { sites } = await visibleSites(me);
  const r = parseRange(params, params.site ? (sites.find((s) => s.id === params.site)?.timezone ?? DEFAULT_TZ) : DEFAULT_TZ);
  let list = sites;
  if (params.group) list = list.filter((s) => s.groupIds.includes(params.group));
  if (params.site) list = list.filter((s) => s.id === params.site);
  const ids = list.map((s) => s.id);
  const name = new Map(list.map((s) => [s.id, s.host || s.name]));
  const stamp = `${r.from}_${r.to}`;
  if (params.kind === "sites") {
    const stats = await perSite(ids, r);
    const rows: unknown[][] = [["Сайт", "Визиты", "Визиты (прошлый период)", "Посетители", "Новые", "Просмотры", "Отказы %", "Время, с", "Конверсии"]];
    for (const s of list) {
      const st = stats.get(s.id)!;
      rows.push([s.host || s.name, st.cur.sessions, st.prev?.sessions ?? "", st.cur.users, st.cur.newUsers, st.cur.pageviews, st.cur.sessions ? Math.round((1 - st.cur.engaged / st.cur.sessions) * 1000) / 10 : "", st.cur.sessions ? Math.round(st.cur.engagementSec / st.cur.sessions) : "", st.cur.keyEvents]);
    }
    return new Response(csv(rows), { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="sites_${stamp}.csv"` } });
  }
  const { rows } = await pages(ids, r, { q: params.q, sort: (params.sort as PageSort) || "views", limit: 5000, offset: 0 });
  const out: unknown[][] = [["Сайт", "Адрес", "Заголовок", "Просмотры", "Просмотры (прошлый период)", "Посетители", "Визиты", "Время, с"]];
  const urls = new Map(list.map((s) => [s.id, s.url ?? ""]));
  for (const p of rows) out.push([name.get(p.propertyId) ?? "", `${urls.get(p.propertyId) ?? ""}${p.path}`, p.title, p.pageviews, p.prevViews ?? "", p.users, p.sessions, p.sessions ? Math.round(p.engagementSec / p.sessions) : ""]);
  return new Response(csv(out), { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="pages_${stamp}.csv"` } });
}
