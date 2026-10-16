import Link from "next/link";
import { prisma } from "@/lib/db";
import { requireFinance } from "@/lib/finance/access";
import { financeContext } from "@/lib/finance/page";
import { opsWhere, type OpsFilter } from "@/lib/finance/filters";
import { PERIODS, userNames } from "@/lib/finance/report";
import { fmtAmount } from "@/lib/finance/currency";
import { FinanceNav } from "@/components/finance/FinanceNav";
import { OpForm } from "@/components/finance/OpForm";
import { OpsList } from "@/components/finance/OpsList";
import { DirTabs } from "@/components/finance/DirTabs";
import { Card, sp, type SearchParams } from "@/components/ui";

export const dynamic = "force-dynamic";
const PAGE = 200;

/** Журнал операций: фильтры, итог по выборке, правка/повтор/удаление, CSV. */
export default async function FinanceOps({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const me = await requireFinance();
  const params = await searchParams;
  const ctx = await financeContext(me);
  const { refs, cur } = ctx;
  const filter: OpsFilter = { p: sp(params, "p") ?? "all", from: sp(params, "from"), to: sp(params, "to"), dir: sp(params, "dir"), who: sp(params, "who"), type: sp(params, "type"), cat: sp(params, "cat"), cp: sp(params, "cp"), q: sp(params, "q") };
  const where = opsWhere(filter);
  const [ops, total, sums] = await Promise.all([
    prisma.finOp.findMany({ where, include: { counterparty: { select: { name: true } } }, orderBy: [{ date: "desc" }, { createdAt: "desc" }], take: PAGE }),
    prisma.finOp.count({ where }),
    prisma.finOp.groupBy({ by: ["type"], where, _sum: { amountEur: true } }),
  ]);
  const names = await userNames(ops.flatMap((o) => [o.createdById, o.updatedById]));
  const s = (t: string) => Number(sums.find((x) => x.type === t)?._sum.amountEur ?? 0);
  const f = (eur: number) => fmtAmount(eur * ctx.factor, cur);
  const qs = new URLSearchParams(Object.entries(filter).filter(([, v]) => v) as [string, string][]).toString();
  const tops = refs.parents.filter((d) => !d.archived);
  // Вкладка — направление верхнего уровня; выбранный в фильтре подраздел подсвечивает своё направление.
  const picked = refs.dirOptions.find((d) => d.id === filter.dir);
  const tab = picked ? picked.parentId ?? picked.id : undefined;
  const tabHref = (id?: string) => `/finance/ops?${new URLSearchParams(Object.entries({ ...filter, dir: id }).filter(([, v]) => v) as [string, string][]).toString()}`;

  return (
    <>
      <FinanceNav cur={cur} />
      <DirTabs dirs={tops} active={tab} href={tabHref} />
      <Card className="mb-4">
        <form className="grid gap-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-[140px_1fr_130px_130px_1fr_1fr_1fr_auto] items-end">
          <label className="block"><span className="label">Период</span>
            <select name="p" className="input" defaultValue={filter.p}>{PERIODS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}</select>
          </label>
          <label className="block"><span className="label">Направление</span>
            <select name="dir" className="input" defaultValue={filter.dir ?? ""}>
              <option value="">Все</option>
              {refs.dirOptions.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
              <option value="none">Без направления</option>
            </select>
          </label>
          <label className="block"><span className="label">Кто</span>
            <select name="who" className="input" defaultValue={filter.who ?? ""}><option value="">Все</option>{refs.partners.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
          </label>
          <label className="block"><span className="label">Тип</span>
            <select name="type" className="input" defaultValue={filter.type ?? ""}><option value="">Все</option><option value="EXPENSE">Расходы</option><option value="INCOME">Доходы</option><option value="SETTLEMENT">Возвраты</option></select>
          </label>
          <label className="block"><span className="label">Категория</span>
            <select name="cat" className="input" defaultValue={filter.cat ?? ""}><option value="">Все</option>{refs.cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}<option value="none">Без категории</option></select>
          </label>
          <label className="block"><span className="label">Контрагент</span>
            <select name="cp" className="input" defaultValue={filter.cp ?? ""}><option value="">Все</option>{refs.counterparties.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
          </label>
          <label className="block"><span className="label">Поиск</span>
            <input name="q" className="input" placeholder="комментарий, кошелёк, контрагент" defaultValue={filter.q ?? ""} />
          </label>
          <div className="flex gap-2"><button className="btn-primary">Показать</button>{qs !== "p=all" && <Link href="/finance/ops" className="btn-ghost">Сброс</Link>}</div>
        </form>
      </Card>

      <div className="grid gap-4 lg:grid-cols-[1fr_380px]">
        <Card
          className="min-w-0"
          title={`Операции: ${total}`}
          description={`Доходы ${f(s("INCOME"))} · расходы ${f(s("EXPENSE"))} · итог ${f(s("INCOME") - s("EXPENSE"))}${s("SETTLEMENT") ? ` · возвраты ${f(s("SETTLEMENT"))}` : ""}${total > PAGE ? ` · показаны последние ${PAGE}` : ""}`}
          actions={<a href={`/api/finance/export?${qs}`} className="btn-ghost btn-sm">Скачать CSV</a>}
        >
          <OpsList ops={ops} refs={refs} cur={cur} factor={ctx.factor} names={names} />
        </Card>
        <div className="lg:sticky lg:top-20 self-start">
          <Card title={tab ? `Добавить в «${tops.find((t) => t.id === tab)?.name}»` : "Добавить операцию"}><OpForm key={tab ?? "all"} refs={ctx.form} myPartnerId={ctx.myPartnerId} lockDirection={tab} /></Card>
        </div>
      </div>
    </>
  );
}
