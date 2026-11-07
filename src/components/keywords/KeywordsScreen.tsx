import Link from "next/link";
import { prisma } from "@/lib/db";
import type { CurrentUser } from "@/lib/auth";
import { buildChips } from "@/lib/keywords/chips";
import { DEFAULT_COLUMNS, FIELD } from "@/lib/keywords/fields";
import { keywordOrder, keywordSummary, keywordWhere, ROW_SELECT, toTableRow, type Params, type Tab } from "@/lib/keywords/query";
import type { ViewItem } from "@/actions/keywords";
import { Empty, PageHeader, type SearchParams } from "@/components/ui";
import { KeywordsNav } from "./KeywordsNav";
import { KeywordsSummary } from "./KeywordsSummary";
import { Workspace } from "./Workspace";
import { FilteredQueueButtons } from "./CollectControls";
import { ExportMenu } from "./ColumnsAndViews";

const flat = (sp: SearchParams): Params => Object.fromEntries(Object.entries(sp).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]));

/** Экран «Ключи» / «Новые»: сводка, фильтры «от–до» по любой метрике, свои колонки, сохранённые виды, карточка ключа. */
export async function KeywordsScreen({ tab, searchParams, me }: { tab: Tab; searchParams: SearchParams; me: CurrentUser }) {
  const p = flat(searchParams);
  const now = new Date();
  const anyKeywords = await prisma.kwKeyword.count();
  const title = tab === "main" ? "Ключи" : "Новые ключи";
  const subtitle = tab === "main"
    ? "Лист Evergreen и взятые в работу новые ключи. Клик по строке — карточка ключа с топ-10 и историей пересъёмов."
    : "Кандидаты не из таблицы: подсказки поиска Pinterest и генерация. «В работу» переносит ключ на вкладку «Ключи».";
  if (!anyKeywords) {
    return (
      <>
        <PageHeader title={title} subtitle={subtitle} />
        <KeywordsNav />
        <Empty title="Данных пока нет" hint="Загрузите стартовые данные ручного сбора на вкладке «Сбор»." action={<Link href="/pinterest/keywords/collect" className="btn-brand">Открыть «Сбор»</Link>} />
      </>
    );
  }
  const prefs = await prisma.kwPrefs.findUnique({ where: { userId: me.id } });
  const ppRaw = Number(p.pp);
  const perPage = [25, 50, 100, 200].includes(ppRaw) ? ppRaw : prefs?.perPage ?? 50;
  const columns = ((prefs?.columns as string[] | null) ?? DEFAULT_COLUMNS).filter((c) => FIELD.has(c));
  const where = keywordWhere(tab, p, now);
  const pg = Math.max(1, Number(p.pg) || 1);
  const [summary, rows, accounts, views] = await Promise.all([
    keywordSummary(where),
    prisma.kwKeyword.findMany({ where, orderBy: keywordOrder(p), select: ROW_SELECT, take: perPage, skip: (pg - 1) * perPage }),
    prisma.kwAccount.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.kwView.findMany({ where: { OR: [{ userId: me.id }, { shared: true }] }, orderBy: { updatedAt: "desc" }, take: 100 }),
  ]);
  const accName = new Map(accounts.map((a) => [a.id, a.name]));
  const data = rows.map((r) => toTableRow(r as unknown as Record<string, unknown>, accName, now));
  // Сколько ключей станет, если снять каждый фильтр по отдельности — видно, что сужает выборку до нуля.
  const chips = buildChips((k) => p[k], accName).slice(0, 20);
  const relaxCounts = await Promise.all(chips.map((c) => {
    const q: Params = { ...p };
    for (const [k, v] of Object.entries(c.patch)) { if (v == null) delete q[k]; else q[k] = v; }
    return prisma.kwKeyword.count({ where: keywordWhere(tab, q, now) });
  }));
  const relax = Object.fromEntries(chips.map((c, i) => [c.id, relaxCounts[i]]));
  const viewItems: ViewItem[] = views.map((v) => ({ id: v.id, name: v.name, query: v.query, columns: (v.columns as string[] | null) ?? null, shared: v.shared, mine: v.userId === me.id }));
  const qs = new URLSearchParams(Object.entries(p).filter(([k, v]) => v && k !== "pg" && k !== "pp") as Array<[string, string]>);
  qs.set("tab", tab);
  return (
    <>
      <PageHeader
        title={title}
        subtitle={subtitle}
        actions={
          <div className="flex flex-wrap gap-2">
            <FilteredQueueButtons tab={tab} params={p} total={summary.total} />
            <ExportMenu qs={qs.toString()} />
          </div>
        }
      />
      <KeywordsNav />
      <KeywordsSummary s={summary} />
      <div className="card p-4">
        <Workspace relax={relax} rows={data} total={summary.total} page={pg} perPage={perPage} columns={columns} views={viewItems} accounts={accounts.map((a) => ({ value: a.id, label: a.name }))} />
      </div>
    </>
  );
}
