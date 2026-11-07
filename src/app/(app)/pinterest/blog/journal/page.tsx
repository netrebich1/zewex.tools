import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { Badge, Card, PageHeader, type SearchParams, sp } from "@/components/ui";
import { blogSiteWhere } from "@/lib/blog/access";
import { stageLabel } from "@/lib/blog/stages";
import { fmtDate, fmtMoney } from "@/lib/utils";

export const dynamic = "force-dynamic";

const PERIODS = [{ v: 1, label: "сутки" }, { v: 7, label: "7 дн." }, { v: 30, label: "30 дн." }, { v: 0, label: "всё время" }];

/** Журнал инфо-статей: ошибки конвейера по группам и расход по сайтам за период. */
export default async function BlogJournalPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const me = await requireUser();
  const q = await searchParams;
  const rawDays = sp(q, "days");
  const days = rawDays === "0" ? 0 : Math.min(365, Math.max(1, Number(rawDays) || 7));
  const since = days ? new Date(Date.now() - days * 86400_000) : undefined;
  const sites = await prisma.blogSite.findMany({ where: await blogSiteWhere(me), select: { id: true, name: true } });
  const siteIds = sites.map((s) => s.id);
  const siteName = new Map(sites.map((s) => [s.id, s.name]));
  const siteParam = sp(q, "site");
  const siteId = siteParam && siteIds.includes(siteParam) ? siteParam : undefined;
  const where = { siteId: siteId ? siteId : { in: siteIds }, ...(since ? { createdAt: { gte: since } } : {}) };
  const [errors, costRows] = await Promise.all([
    prisma.blogError.findMany({ where, orderBy: { createdAt: "desc" }, take: 500, include: { post: { select: { keyword: true } } } }),
    prisma.blogPost.groupBy({ by: ["siteId", "status"], where: { siteId: siteId ? siteId : { in: siteIds }, ...(since ? { updatedAt: { gte: since } } : {}) }, _sum: { costUsd: true }, _count: { _all: true } }),
  ]);
  const groups = new Map<string, { signature: string; stage: string; count: number; last: typeof errors[number]; posts: Set<string> }>();
  for (const e of errors) {
    const g = groups.get(e.signature) ?? { signature: e.signature, stage: e.stage, count: 0, last: e, posts: new Set<string>() };
    g.count++;
    if (e.postId) g.posts.add(e.postId);
    groups.set(e.signature, g);
  }
  const bySite = new Map<string, { total: number; published: number; cost: number; publishedCost: number }>();
  for (const r of costRows) {
    const s = bySite.get(r.siteId) ?? { total: 0, published: 0, cost: 0, publishedCost: 0 };
    s.total += r._count._all; s.cost += r._sum.costUsd ?? 0;
    if (r.status === "COMPLETED") { s.published += r._count._all; s.publishedCost += r._sum.costUsd ?? 0; }
    bySite.set(r.siteId, s);
  }
  const qs = (patch: Record<string, string | undefined>) => { const u = new URLSearchParams(); const all = { site: siteId, days: days === 7 ? undefined : String(days), ...patch }; for (const [k, v] of Object.entries(all)) if (v) u.set(k, v); const s = u.toString(); return `/pinterest/blog/journal${s ? `?${s}` : ""}`; };

  return (
    <>
      <PageHeader back={{ href: "/pinterest/blog", label: "Обзор" }} title="Журнал" subtitle="Ошибки конвейера по группам и расход по сайтам." />
      <Card className="mb-4"><div className="flex flex-wrap items-center gap-2">
        <span className="help">Период:</span>{PERIODS.map((p) => <Link key={p.v} href={qs({ days: p.v === 7 ? undefined : String(p.v) })} className={`btn-ghost btn-sm ${days === p.v ? "bg-ink/10" : ""}`}>{p.label}</Link>)}
        <span className="help ml-3">Сайт:</span><Link href={qs({ site: undefined })} className={`btn-ghost btn-sm ${!siteId ? "bg-ink/10" : ""}`}>все</Link>{sites.map((s) => <Link key={s.id} href={qs({ site: s.id })} className={`btn-ghost btn-sm ${siteId === s.id ? "bg-ink/10" : ""}`}>{s.name}</Link>)}
      </div></Card>
      <div className="space-y-4">
        <Card title="Расход по сайтам" description="Сумма по журналу портала (ИИ и поиск картинок) по статьям, менявшимся за период.">
          {bySite.size === 0 ? <p className="help">Расходов за период нет.</p> : (
            <div className="table-wrap"><table className="table"><thead><tr><th>Сайт</th><th className="text-right">Статей</th><th className="text-right">Опубликовано</th><th className="text-right">Расход</th><th className="text-right">На опубликованную</th></tr></thead>
              <tbody>{[...bySite.entries()].map(([sid, s]) => <tr key={sid}><td>{siteName.get(sid) ?? sid}</td><td className="text-right tabular-nums">{s.total}</td><td className="text-right tabular-nums">{s.published}</td><td className="text-right tabular-nums">{fmtMoney(s.cost)}</td><td className="text-right tabular-nums">{s.published ? fmtMoney(s.publishedCost / s.published) : "—"}</td></tr>)}</tbody></table></div>
          )}
        </Card>
        <Card title={`Ошибки · ${errors.length}`} description="Одинаковые ошибки собраны в группы; клик по ключу открывает статью.">
          {groups.size === 0 ? <p className="help">Ошибок за период нет.</p> : (
            <ul className="space-y-2">{[...groups.values()].sort((a, b) => b.count - a.count).map((g) => (
              <li key={g.signature} className="rounded-xl border border-line p-3 text-[13.5px]">
                <div className="flex flex-wrap items-center gap-2"><Badge>{stageLabel(g.stage)}</Badge><b>{g.count} раз · статей {g.posts.size}</b><span className="help">последняя {fmtDate(g.last.createdAt)}</span>{g.last.postId && <Link href={`/pinterest/blog/posts/${g.last.postId}`} className="underline">{g.last.post?.keyword ?? "статья"}</Link>}</div>
                <div className="mt-1 text-danger break-words">{g.last.message.slice(0, 600)}</div>
              </li>
            ))}</ul>
          )}
        </Card>
      </div>
    </>
  );
}
