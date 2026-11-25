import Link from "next/link";
import { prisma } from "@/lib/db";
import { requireKeywords } from "@/lib/keywords/access";
import { compareAccountsAction } from "@/actions/keywords";
import { COMPARE_DEFAULT, compareResult, conclusion, type PairRow } from "@/lib/keywords/compare";
import { nicheLabel, verdictLabel } from "@/lib/keywords/types";
import { ActionForm } from "@/components/ActionForm";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { Alert, Card, PageHeader, sp, type SearchParams } from "@/components/ui";
import { KeywordsNav } from "@/components/keywords/KeywordsNav";

export const dynamic = "force-dynamic";

const dt = (d: Date | string) => new Date(d).toLocaleString("ru-RU", { timeZone: "Europe/Kyiv", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
const fmt = (n: number | null | undefined) => (n == null ? "—" : n.toLocaleString("ru-RU"));
const toneCls = (v: number | null, good: number, mid: number) => (v == null ? "text-muted" : v >= good ? "text-ok" : v >= mid ? "text-warn" : "text-danger");

function Tile({ label, value, hint, cls = "" }: { label: string; value: string; hint?: string; cls?: string }) {
  return (
    <div className="kpi">
      <span className="text-[12.5px] font-semibold uppercase tracking-wider text-muted">{label}</span>
      <span className={`kpi-value tabular-nums ${cls}`}>{value}</span>
      <span className="help min-h-[18px]">{hint}</span>
    </div>
  );
}

function Pair({ r, a, b }: { r: PairRow; a: string; b: string }) {
  const same = r.a?.verdict && r.b?.verdict && r.a.verdict === r.b.verdict;
  const diff = r.a?.score != null && r.b?.score != null ? Math.abs(r.a.score - r.b.score) : null;
  return (
    <tr>
      <td className="max-w-[260px]"><div className="font-semibold truncate" title={r.phrase}>{r.phrase}</div><div className="help">{nicheLabel(r.niche)} · {fmt(r.volume)}</div></td>
      {r.state !== "pair" ? (
        <td colSpan={6} className="help">{r.state === "one" ? `снят только с ${r.a ? a : b}, ждём второй аккаунт` : "ждём оба аккаунта"}</td>
      ) : (
        <>
          <td className={`text-right tabular-nums font-semibold ${toneCls(r.overlap10, 70, 40)}`}>{r.overlap10}%</td>
          <td className={`text-right tabular-nums ${toneCls(r.overlap3, 67, 34)}`}>{r.overlap3}%</td>
          <td className="text-right tabular-nums">{r.shift ?? "—"}</td>
          <td className="whitespace-nowrap"><span className={same ? "" : "font-semibold text-danger"}>{verdictLabel(r.a!.verdict) || "—"}</span><span className="text-muted"> / </span><span className={same ? "" : "font-semibold text-danger"}>{verdictLabel(r.b!.verdict) || "—"}</span></td>
          <td className={`text-right tabular-nums whitespace-nowrap ${diff != null && diff >= 15 ? "font-semibold text-danger" : ""}`}>{r.a!.score ?? "—"} / {r.b!.score ?? "—"}</td>
          <td className="text-right tabular-nums whitespace-nowrap text-[13px] text-ink-2" title={`Реклама ${r.a!.ad} / ${r.b!.ad}, товары ${r.a!.prod} / ${r.b!.prod}, свежих ${r.a!.fresh3} / ${r.b!.fresh3}`}>{r.a!.ad + r.a!.prod} / {r.b!.ad + r.b!.prod}<span className="help block">разница {r.hoursApart} ч</span></td>
        </>
      )}
    </tr>
  );
}

/** Сравнение аккаунтов: насколько выдача персонализирована и можно ли доверять снимку с одного аккаунта. */
export default async function ComparePage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  await requireKeywords();
  const q = await searchParams;
  const [accounts, list] = await Promise.all([
    prisma.kwAccount.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }),
    prisma.kwCompare.findMany({ orderBy: { createdAt: "desc" }, take: 10 }),
  ]);
  const name = new Map(accounts.map((a) => [a.id, a.name]));
  const id = sp(q, "id") || list[0]?.id;
  const res = id ? await compareResult(id) : null;
  const c = res ? conclusion(res.summary) : null;
  const s = res?.summary;
  return (
    <>
      <PageHeader title="Сравнение аккаунтов" subtitle="Выдача Pinterest подстраивается под аккаунт. Снимаем одни и те же ключи с двух аккаунтов и смотрим, совпадают ли топ, вердикт и оценка." />
      <KeywordsNav />
      <div className="grid gap-4 lg:grid-cols-3 mb-4">
        <Card title="Новая выборка" description="Ключи с частотностью от 3000, поровну по нишам, случайно. Каждый ключ встанет в очередь выдачи для обоих аккаунтов — снимут расширения этих аккаунтов.">
          {accounts.length < 2 ? <p className="help">Нужно минимум два аккаунта — добавьте их на вкладке «Сбор».</p> : (
            <ActionForm action={compareAccountsAction} className="space-y-3">
              <div className="grid grid-cols-2 gap-2">
                <label className="block"><span className="label">Аккаунт 1</span><select name="accountA" className="input" defaultValue={accounts[0].id}>{accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
                <label className="block"><span className="label">Аккаунт 2</span><select name="accountB" className="input" defaultValue={accounts[1].id}>{accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
              </div>
              <label className="block"><span className="label">Ключей в выборке</span><input name="count" type="number" min={5} max={60} defaultValue={COMPARE_DEFAULT} className="input" /></label>
              <SubmitButton className="btn-brand w-full" pendingText="Ставлю в очередь…">Сравнить</SubmitButton>
            </ActionForm>
          )}
        </Card>
        <Card title="Выборки" className="lg:col-span-2">
          {list.length ? (
            <div className="flex flex-wrap gap-1.5">
              {list.map((x) => (
                <Link key={x.id} href={`/pinterest/keywords/compare?id=${x.id}`} className={`rounded-full border px-3 py-1 text-[12.5px] font-semibold ${x.id === id ? "border-ink bg-ink text-bg" : "border-line text-ink-2 hover:text-ink"}`}>
                  {dt(x.createdAt)} · {name.get(x.accountAId) ?? "—"} ↔ {name.get(x.accountBId) ?? "—"} · {(x.keywordIds as string[]).length}
                </Link>
              ))}
            </div>
          ) : <p className="help">Выборок пока нет.</p>}
          <p className="help mt-3">В сравнение идут только снимки, снятые после создания выборки: старые снимки из ручного сбора сняты в разное время и без id пинов.</p>
        </Card>
      </div>
      {res && s && c && (
        <>
          <div className="mb-4"><Alert tone={c.tone}>{c.text}</Alert></div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5 mb-4">
            <Tile label="Пар снято" value={`${s.pairs} / ${s.total}`} hint={`в очереди: ${res.accountA} ${s.queued[res.cmp.accountAId] ?? 0}, ${res.accountB} ${s.queued[res.cmp.accountBId] ?? 0}`} />
            <Tile label="Совпадение топ-10" value={s.overlap10 != null ? `${s.overlap10}%` : "—"} hint="общие пины в среднем" cls={toneCls(s.overlap10, 70, 40)} />
            <Tile label="Совпадение топ-3" value={s.overlap3 != null ? `${s.overlap3}%` : "—"} hint="верхние места" cls={toneCls(s.overlap3, 67, 34)} />
            <Tile label="Тот же вердикт" value={s.sameVerdict != null ? `${s.sameVerdict}%` : "—"} hint={`из ${s.verdictPairs} пар`} cls={toneCls(s.sameVerdict, 85, 65)} />
            <Tile label="Разница оценки" value={s.scoreDiff != null ? String(s.scoreDiff) : "—"} hint={`в среднем; ≥ 15 баллов — у ${s.bigScoreDiff}`} />
          </div>
          <Card title={`${res.accountA} ↔ ${res.accountB}`} description={`Выборка от ${dt(res.cmp.createdAt)}${res.cmp.createdBy ? `, создал ${res.cmp.createdBy}` : ""}. Слева значение первого аккаунта, справа второго.`}>
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Ключ</th><th className="text-right">Топ-10</th><th className="text-right">Топ-3</th><th className="text-right">Сдвиг позиций</th><th>Вердикт</th><th className="text-right">Оценка</th><th className="text-right">Реклама + товары</th></tr></thead>
                <tbody>{res.rows.map((r) => <Pair key={r.id} r={r} a={res.accountA} b={res.accountB} />)}</tbody>
              </table>
            </div>
          </Card>
        </>
      )}
    </>
  );
}
