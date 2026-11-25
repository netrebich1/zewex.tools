import Link from "next/link";
import { prisma } from "@/lib/db";
import { requireFinance } from "@/lib/finance/access";
import { financeContext } from "@/lib/finance/page";
import { asPeriod, dirFamily, PERIODS, periodRange, userNames } from "@/lib/finance/report";
import { fmtAmount } from "@/lib/finance/currency";
import { FinanceNav } from "@/components/finance/FinanceNav";
import { OpsList } from "@/components/finance/OpsList";
import { Card, sp, type SearchParams } from "@/components/ui";

export const dynamic = "force-dynamic";
const PAGE = 200;
const NONE = "none";
const BY = [
  { key: "cp", label: "Кому платили", empty: "Без контрагента" },
  { key: "cat", label: "Категории", empty: "Без категории" },
  { key: "who", label: "Кто платил", empty: "?" },
  { key: "dir", label: "Направления", empty: "Без направления" },
] as const;
type By = (typeof BY)[number]["key"];

/**
 * Расходы: на что уходят деньги. Группировка (`by`): кому платили / категории / кто платил / направления;
 * фильтры: период `p`, плательщик `who`, направление `d`. Нажатие на строку (`sel`) — график и операции только по ней.
 */
export default async function FinanceExpenses({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const me = await requireFinance();
  const params = await searchParams;
  const ctx = await financeContext(me);
  const { refs, cur } = ctx;
  const period = asPeriod(sp(params, "p"), "all");
  const by: By = BY.find((b) => b.key === sp(params, "by"))?.key ?? "cp";
  const who = refs.partners.find((p) => p.id === sp(params, "who"))?.id;
  const tops = refs.parents.filter((d) => !d.archived);
  const dir = tops.find((d) => d.id === sp(params, "d"))?.id;
  const sel = sp(params, "sel");

  const base = { deletedAt: null, type: "EXPENSE" as const, ...(who ? { partnerId: who } : {}), ...(dir ? { directionId: { in: dirFamily(refs.dirs, dir) } } : {}) };
  // Все расходы под фильтры без периода: из них и итоги периода, и график по месяцам. Объём небольшой — считаем в памяти.
  const all = await prisma.finOp.findMany({ where: base, include: { counterparty: { select: { name: true } } }, orderBy: [{ date: "desc" }, { createdAt: "desc" }] });
  const range = periodRange(period);
  const inPeriod = all.filter((o) => (!range.from || o.date >= range.from) && (!range.to || o.date < range.to));

  const topOf = new Map(refs.dirs.map((d) => [d.id, d.parentId ?? d.id]));
  const keyOf = (o: (typeof all)[number]): string => (by === "cp" ? o.counterpartyId : by === "cat" ? o.categoryId : by === "who" ? o.partnerId : o.directionId ? topOf.get(o.directionId) ?? null : null) ?? NONE;
  const nameOf = new Map<string, string>([
    ...(by === "cp" ? refs.counterparties.map((c) => [c.id, c.name] as const) : by === "cat" ? refs.cats.map((c) => [c.id, c.name] as const) : by === "who" ? refs.partners.map((p) => [p.id, p.name] as const) : refs.parents.map((d) => [d.id, d.name] as const)),
    [NONE, BY.find((b) => b.key === by)!.empty],
  ]);

  type Group = { id: string; name: string; total: number; count: number; per: Record<string, number>; last: Date };
  const groups = new Map<string, Group>();
  let total = 0;
  for (const o of inPeriod) {
    const v = Number(o.amountEur), k = keyOf(o);
    const g = groups.get(k) ?? { id: k, name: nameOf.get(k) ?? "?", total: 0, count: 0, per: {}, last: o.date };
    g.total += v; g.count++; g.per[o.partnerId] = (g.per[o.partnerId] ?? 0) + v;
    if (o.date > g.last) g.last = o.date;
    groups.set(k, g);
    total += v;
  }
  const rows = [...groups.values()].sort((a, b) => b.total - a.total);
  const max = Math.max(1, ...rows.map((r) => r.total));
  const picked = sel ? groups.get(sel) : undefined;

  // График: все месяцы от первого расхода до текущего (не больше 12), по выбранной строке или по всем.
  const forChart = all.filter((o) => !picked || keyOf(o) === picked.id);
  const now = new Date();
  const firstYm = all.length ? all[all.length - 1].date.toISOString().slice(0, 7) : now.toISOString().slice(0, 7);
  const months: { key: string; label: string; total: number; per: Record<string, number> }[] = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getFullYear(), now.getMonth() - i, 1));
    const key = d.toISOString().slice(0, 7);
    if (key >= firstYm) months.push({ key, label: d.toLocaleString("ru-RU", { month: "short", year: "2-digit", timeZone: "UTC" }).replace(".", "").replace(" г", ""), total: 0, per: {} });
  }
  for (const o of forChart) {
    const m = months.find((x) => x.key === o.date.toISOString().slice(0, 7));
    if (m) { const v = Number(o.amountEur); m.total += v; m.per[o.partnerId] = (m.per[o.partnerId] ?? 0) + v; }
  }
  const mMax = Math.max(1, ...months.map((m) => m.total));

  const ops = (picked ? inPeriod.filter((o) => keyOf(o) === picked.id) : inPeriod).slice(0, PAGE);
  const opsTotal = picked ? picked.count : inPeriod.length;
  const names = await userNames(ops.flatMap((o) => [o.createdById, o.updatedById]));
  const f = (eur: number) => fmtAmount(eur * ctx.factor, cur, { digits: 2 });
  const link = (q: Record<string, string | undefined>) => {
    const s = new URLSearchParams(Object.entries({ p: period === "all" ? undefined : period, by: by === "cp" ? undefined : by, who, d: dir, sel, ...q }).filter(([, v]) => v) as [string, string][]).toString();
    return s ? `/finance/expenses?${s}` : "/finance/expenses";
  };
  const chip = (on: boolean) => `tab ${on ? "active" : ""}`;
  const split = (per: Record<string, number>) => refs.partners.filter((p) => per[p.id]).map((p) => `${p.name} ${f(per[p.id])}`).join(" · ");
  // Цвета плательщиков в графике: первый партнёр темнее, второй светлее.
  const tone = ["bg-ink/75", "bg-ink/35", "bg-ink/20"];

  return (
    <>
      <FinanceNav cur={cur} />
      <div className="mb-4 space-y-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="help w-[92px]">Период</span>
          {PERIODS.map((p) => <Link key={p.key} href={link({ p: p.key === "all" ? undefined : p.key })} className={chip(p.key === period)}>{p.label}</Link>)}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="help w-[92px]">Показать по</span>
          {BY.map((b) => <Link key={b.key} href={link({ by: b.key === "cp" ? undefined : b.key, sel: undefined })} className={chip(b.key === by)}>{b.label}</Link>)}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="help w-[92px]">Кто платил</span>
          <Link href={link({ who: undefined, sel: by === "who" ? undefined : sel })} className={chip(!who)}>Все</Link>
          {refs.partners.map((p) => <Link key={p.id} href={link({ who: p.id, sel: by === "who" ? undefined : sel })} className={chip(who === p.id)}>{p.name}</Link>)}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="help w-[92px]">Направление</span>
          <Link href={link({ d: undefined, sel: by === "dir" ? undefined : sel })} className={chip(!dir)}>Все</Link>
          {tops.map((d) => <Link key={d.id} href={link({ d: d.id, sel: by === "dir" ? undefined : sel })} className={chip(dir === d.id)}>{d.name}</Link>)}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 mb-4">
        <div className="kpi min-w-0"><span className="help">Расходы за период</span><span className="kpi-value tabular-nums">{f(total)}</span><span className="help">операций: {inPeriod.length}</span></div>
        {refs.partners.map((p) => {
          const v = inPeriod.reduce((s, o) => s + (o.partnerId === p.id ? Number(o.amountEur) : 0), 0);
          return <div key={p.id} className="kpi min-w-0"><span className="help">Оплатил {p.name}</span><span className="kpi-value tabular-nums">{f(v)}</span><span className="help">{total ? Math.round((v / total) * 100) : 0}% расходов</span></div>;
        })}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title={`Расходы: ${BY.find((b) => b.key === by)!.label.toLowerCase()}`} description="Нажмите на строку — справа график и операции только по ней. Повторное нажатие снимает выбор.">
          {rows.length === 0 ? <p className="help">За этот период расходов нет.</p> : (
            <ul className="space-y-1">
              {rows.map((r) => {
                const on = picked?.id === r.id;
                return (
                  <li key={r.id}>
                    <Link href={link({ sel: on ? undefined : r.id })} className={`block rounded-xl border px-3 py-2 transition ${on ? "border-ink bg-ink/5" : "border-transparent hover:border-line hover:bg-ink/5"}`}>
                      <div className="flex items-baseline justify-between gap-3">
                        <span className="font-medium [overflow-wrap:anywhere]">{r.name}</span>
                        <span className="font-semibold tabular-nums whitespace-nowrap">{f(r.total)}</span>
                      </div>
                      <div className="mt-1 h-2 rounded-full bg-ink/10"><div className="h-2 rounded-full bg-ink/70" style={{ width: `${Math.max(1.5, (r.total / max) * 100)}%` }} /></div>
                      <div className="help mt-1 flex flex-wrap justify-between gap-x-3">
                        <span>{total ? Math.round((r.total / total) * 100) : 0}% · операций: {r.count} · последняя {r.last.toISOString().slice(0, 10).split("-").reverse().join(".")}</span>
                        {by !== "who" && <span>{split(r.per)}</span>}
                      </div>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        <div className="space-y-4 min-w-0">
          <Card title={picked ? `По месяцам · ${picked.name}` : "По месяцам · все расходы"} description={`Столбец — расходы за месяц${refs.partners.length ? `: ${refs.partners.map((p, i) => `${["тёмная", "светлая", "бледная"][i] ?? ""} часть — ${p.name}`).join(", ")}` : ""}. График не зависит от выбранного периода.`}>
            <div className="flex items-end gap-2 h-44">
              {months.map((m) => (
                <div key={m.key} className="flex-1 min-w-0 max-w-[72px] flex flex-col items-center gap-1" title={`${m.key}: ${f(m.total)}${split(m.per) ? ` (${split(m.per)})` : ""}`}>
                  <span className="text-[11px] tabular-nums text-ink-2 whitespace-nowrap">{m.total ? fmtAmount(m.total * ctx.factor, cur, { digits: 0 }) : ""}</span>
                  <div className="flex w-full flex-col-reverse justify-start h-32 overflow-hidden rounded-t">
                    {refs.partners.map((p, i) => m.per[p.id] ? <div key={p.id} className={tone[i] ?? tone[2]} style={{ height: `${(m.per[p.id] / mMax) * 100}%` }} /> : null)}
                  </div>
                  <span className="text-[11px] text-muted truncate">{m.label}</span>
                </div>
              ))}
            </div>
            <ul className="mt-3 space-y-1 text-[13.5px]">
              {months.filter((m) => m.total).reverse().map((m) => (
                <li key={m.key} className="flex items-baseline justify-between gap-3">
                  <span className="text-muted">{m.label}</span>
                  <span className="tabular-nums text-right"><b>{f(m.total)}</b>{split(m.per) ? <span className="help"> · {split(m.per)}</span> : null}</span>
                </li>
              ))}
            </ul>
          </Card>

          <Card title={`${picked ? `Операции · ${picked.name}` : "Операции"}: ${opsTotal}`} description={opsTotal > PAGE ? `Показаны последние ${PAGE}.` : undefined} actions={picked ? <Link href={link({ sel: undefined })} className="btn-ghost btn-sm">Показать все</Link> : undefined}>
            <OpsList ops={ops} refs={refs} cur={cur} factor={ctx.factor} names={names} compact back={link({})} />
          </Card>
        </div>
      </div>
    </>
  );
}
