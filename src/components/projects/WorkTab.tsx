import Link from "next/link";
import { prisma } from "@/lib/db";
import { Badge, Card } from "@/components/ui";
import { RUN_STATUS_LABELS, runStatusTone } from "@/components/pins/labels";
import { STATUS_LABELS as ART_LABELS } from "@/lib/articles/labels";
import { STATUS_LABELS as BLOG_LABELS } from "@/lib/blog/labels";
import { normUrl } from "@/lib/projects/summary";
import { fmtMoney } from "@/lib/utils";

const toneMap: Record<string, "neutral" | "ok" | "warn" | "danger" | "brand"> = { muted: "neutral", info: "brand", ok: "ok", warn: "warn", danger: "danger" };
const dt = (d: Date | null) => (d ? d.toLocaleDateString("ru-RU") : "—");

/** Вкладка «Работа»: прогоны пинов, статьи-подборки и блоговые статьи сайта; у статьи — есть ли на неё пины. */
export async function WorkTab({ accessId, finance }: { accessId: string; finance: boolean }) {
  const [pinSites, artSites, blogSites] = await Promise.all([
    prisma.pinSite.findMany({ where: { wpConnectionId: accessId }, select: { id: true, name: true } }),
    prisma.artSite.findMany({ where: { accessId }, select: { id: true } }),
    prisma.blogSite.findMany({ where: { accessId }, select: { id: true } }),
  ]);
  const P = pinSites.map((s) => s.id), A = artSites.map((s) => s.id), B = blogSites.map((s) => s.id);
  const [runs, hist, articles, posts] = await Promise.all([
    P.length ? prisma.pinRun.findMany({ where: { siteId: { in: P }, NOT: { name: "__system__" } }, orderBy: { createdAt: "desc" }, take: 60, select: { id: true, name: true, status: true, createdAt: true, costUsd: true, siteId: true, _count: { select: { pages: true, items: { where: { status: { notIn: ["POOL", "REMOVED"] }, moderation: { not: "REJECTED" } } } } } } }) : [],
    P.length ? prisma.pinUrlHistory.findMany({ where: { siteId: { in: P } }, select: { url: true } }) : [],
    A.length ? prisma.article.findMany({ where: { siteId: { in: A } }, orderBy: [{ publishedAt: "desc" }, { createdAt: "desc" }], take: 300, select: { id: true, keyword: true, h1: true, status: true, publishedAt: true, createdAt: true, wpUrl: true, costUsd: true } }) : [],
    B.length ? prisma.blogPost.findMany({ where: { siteId: { in: B } }, orderBy: [{ publishedAt: "desc" }, { createdAt: "desc" }], take: 300, select: { id: true, keyword: true, h1: true, status: true, publishedAt: true, createdAt: true, wpUrl: true, costUsd: true } }) : [],
  ]);
  const pinned = new Set(hist.map((h) => normUrl(h.url)));
  const hasPins = (url: string | null) => (url ? pinned.has(normUrl(url)) : false);

  const contentTable = (rows: typeof articles, labels: Record<string, { label: string; tone: string }>, kind: "articles" | "blog") => (
    <div className="table-wrap">
      <table className="table">
        <thead><tr><th>Ключ / заголовок</th><th>Статус</th><th>Опубликована</th><th>Пины</th>{finance && <th>ИИ</th>}<th></th></tr></thead>
        <tbody>
          {rows.map((a) => {
            const l = labels[a.status] ?? { label: a.status, tone: "muted" };
            const pub = a.status === "COMPLETED";
            return (
              <tr key={a.id}>
                <td><Link href={`/pinterest/${kind}/${kind === "articles" ? "articles" : "posts"}/${a.id}`} className="font-medium hover:underline">{a.keyword}</Link>{a.h1 && a.h1 !== a.keyword && <div className="help line-clamp-1">{a.h1}</div>}</td>
                <td><Badge tone={toneMap[l.tone] ?? "neutral"}>{l.label}</Badge></td>
                <td className="text-muted whitespace-nowrap">{pub ? dt(a.publishedAt ?? a.createdAt) : "—"}</td>
                <td>{pub ? (hasPins(a.wpUrl) ? <Badge tone="ok">есть</Badge> : <Badge tone="warn">нет</Badge>) : <span className="text-muted">—</span>}</td>
                {finance && <td className="tabular-nums text-muted">{fmtMoney(a.costUsd)}</td>}
                <td className="text-right">{a.wpUrl && <a href={a.wpUrl} target="_blank" rel="noreferrer" className="text-[13px] text-muted hover:underline">открыть ↗</a>}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );

  return (
    <div className="space-y-4">
      <Card title="Прогоны пинов" description={P.length ? `Последние ${runs.length} прогонов. Клик — карточка прогона.` : "Pinterest Pins для этого сайта не подключён."} actions={P.length ? <Link href={`/pinterest/pins/runs/new?site=${P[0]}`} className="btn-brand btn-sm">Новый прогон</Link> : undefined}>
        {runs.length === 0 ? <p className="help">Прогонов ещё не было.</p> : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Прогон</th><th>Статус</th><th>Статей</th><th>Пинов</th>{finance && <th>ИИ</th>}<th>Создан</th></tr></thead>
              <tbody>{runs.map((r) => (
                <tr key={r.id}>
                  <td><Link href={`/pinterest/pins/runs/${r.id}`} className="font-medium hover:underline">{r.name || r.id.slice(0, 8)}</Link>{pinSites.length > 1 && <div className="help">{pinSites.find((s) => s.id === r.siteId)?.name}</div>}</td>
                  <td><Badge tone={runStatusTone(r.status)}>{RUN_STATUS_LABELS[r.status]}</Badge></td>
                  <td className="tabular-nums">{r._count.pages}</td>
                  <td className="tabular-nums">{r._count.items}</td>
                  {finance && <td className="tabular-nums text-muted">{fmtMoney(r.costUsd)}</td>}
                  <td className="text-muted whitespace-nowrap">{dt(r.createdAt)}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </Card>
      <Card title="Статьи-подборки" description={A.length ? "«Пины: нет» — статья опубликована, но ни в один прогон пинов не попадала." : "Pinterest Articles для этого сайта не подключён."}>
        {articles.length === 0 ? <p className="help">Статей нет.</p> : contentTable(articles, ART_LABELS, "articles")}
      </Card>
      <Card title="Блоговые статьи" description={B.length ? "Pin Blog Article." : "Pin Blog Article для этого сайта не подключён."}>
        {posts.length === 0 ? <p className="help">Статей нет.</p> : contentTable(posts, BLOG_LABELS, "blog")}
      </Card>
    </div>
  );
}
