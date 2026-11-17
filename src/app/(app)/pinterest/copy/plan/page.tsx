import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { Alert, Card, Empty, PageHeader } from "@/components/ui";
import { ActionForm } from "@/components/ActionForm";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { createTopUpBatch } from "@/actions/copyBatch";
import { copySettings } from "@/lib/copy/build";
import { nicheCapacity, planNewSites, siteCapacities, usableCores } from "@/lib/copy/plan";
import { GROUP_LABEL, nicheLabel } from "@/lib/copy/keys";
import { fmtDate } from "@/lib/utils";

export const dynamic = "force-dynamic";
const n = (v: number) => v.toLocaleString("ru-RU");
const num = (v: string | undefined, d: number) => { const x = Math.floor(Number(v ?? "")); return Number.isFinite(x) && x >= 0 ? x : d; };

/** Планировщик Article Copy: вся картина для решений — ёмкость банка, что можно дописать на каждый сайт, калькулятор новых сайтов. */
export default async function CopyPlanPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const me = await requireUser();
  const sp = await searchParams;
  const admin = me.role === "ADMIN";
  const st = await copySettings();
  if (!st.builtAt) return <Empty title="Запас ещё не посчитан" hint="Подождите 4–5 минут и обновите страницу." />;
  const cores = await usableCores();
  const caps = await nicheCapacity(cores);
  const sites = await siteCapacities(cores, caps);
  const grp = sp.grp === "interior" ? "interior" : "women";
  const groups = [
    { sites: num(sp.s1, 5), articles: num(sp.a1, 500) },
    { sites: num(sp.s2, 0), articles: num(sp.a2, 1000) },
    { sites: num(sp.s3, 0), articles: num(sp.a3, 300) },
  ].filter((g) => g.sites > 0 && g.articles > 0);
  const plan = planNewSites(caps, grp, groups.length ? groups : [{ sites: 5, articles: 500 }]);
  const totals = caps.reduce((a, c) => ({ articles: a.articles + c.articles, hi: a.hi + c.byClass.hi.articles, mid: a.mid + c.byClass.mid.articles, low: a.low + c.byClass.low.articles, other: a.other + c.byClass.other.articles }), { articles: 0, hi: 0, mid: 0, low: 0, other: 0 });
  const womenCap = caps.filter((c) => c.grp === "women").reduce((s, c) => s + c.articles, 0);
  const interiorCap = caps.filter((c) => c.grp === "interior").reduce((s, c) => s + c.articles, 0);
  const costPer = 0.04;

  return (
    <>
      <PageHeader title="Планировщик" subtitle={`Что можно собрать из банка прямо сейчас, куда дописать и хватит ли на новые сайты. Оценка сверху по карте от ${fmtDate(st.builtAt)}; точная проверка — при сборке партии. Лимиты кадра: ${st.maxUsesPerCore} раза на тему, ${st.maxUsesTotal} всего, ${st.maxPerSite} на сайт.`} back={{ href: "/pinterest/copy", label: "Запас" }} actions={<Link href="/pinterest/copy/batches/new" className="btn-brand">Новая партия</Link>} />
      <div className="space-y-5">
        <Card title="Сколько статей можно собрать" description="По нишам и частотности. «Темы» — сколько разных тем доступно (на один сайт тема идёт один раз). «Статей» — сколько статей выходит из кадров этих тем с учётом бюджета кадров ниши: это предел на все сайты вместе.">
          <div className="mb-3 flex flex-wrap gap-2 text-[13px]">
            <span className="rounded-full bg-ok-soft px-3 py-1.5 text-ok">Всего ≈ <b className="tabular-nums">{n(totals.articles)}</b> статей</span>
            <span className="rounded-full bg-ink/5 px-3 py-1.5">Женские ≈ <b className="tabular-nums">{n(womenCap)}</b></span>
            <span className="rounded-full bg-ink/5 px-3 py-1.5">Интерьер ≈ <b className="tabular-nums">{n(interiorCap)}</b></span>
            <span className="rounded-full bg-ink/5 px-3 py-1.5">ВЧ <b className="tabular-nums">{n(totals.hi)}</b> · СЧ <b className="tabular-nums">{n(totals.mid)}</b> · НЧ <b className="tabular-nums">{n(totals.low)}</b> · без данных <b className="tabular-nums">{n(totals.other)}</b></span>
            <span className="rounded-full bg-ink/5 px-3 py-1.5">Текст ≈ <b className="tabular-nums">${(totals.articles * costPer).toFixed(0)}</b> за всё</span>
          </div>
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Ниша</th><th className="text-right">ВЧ темы / статей</th><th className="text-right">СЧ</th><th className="text-right">НЧ</th><th className="text-right">Без данных</th><th className="text-right">По темам</th><th className="text-right">Бюджет кадров</th><th className="text-right">Итого статей</th></tr></thead>
              <tbody>
                {caps.map((c) => (
                  <tr key={c.niche}>
                    <td className="font-medium">{nicheLabel(c.niche)} <span className="help">{GROUP_LABEL[c.grp]}</span></td>
                    {(["hi", "mid", "low", "other"] as const).map((k) => <td key={k} className="text-right tabular-nums">{n(c.byClass[k].cores)} / <b>{n(c.byClass[k].articles)}</b></td>)}
                    <td className="text-right tabular-nums text-muted">{n(c.byPhotos)}</td>
                    <td className="text-right tabular-nums text-muted">{n(c.photoBudget)}</td>
                    <td className="text-right tabular-nums font-semibold">{n(c.articles)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="help mt-2">Сезонные темы и ядра из одного слова не считаются. Бюджет кадров = оставшиеся использования фото ниши ÷ фото в статье ({st.photosPerArticle}); когда он меньше суммы по темам, классы ужаты пропорционально.</p>
        </Card>

        <Card title="Сайты: сколько можно дописать" description="Свободные темы — те, которых на сайте ещё нет в любой формулировке (с учётом уже собранных мешапов). «Можно дописать» — свободные темы, ужатые бюджетом кадров ниш сайта. Кнопка создаёт партию: 30 % ВЧ, остальное пополам СЧ и НЧ, ниши в пропорции сайта, темы — самые частотные, 20–30 фото, год следующий, без сезонных, публикация сразу.">
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Сайт</th><th className="hidden md:table-cell">Пишет о</th><th className="text-right">Статей сейчас</th><th className="text-right">Свободно тем ВЧ / СЧ / НЧ</th><th className="text-right">Можно дописать</th><th>Статус</th>{admin && <th>Дописать</th>}</tr></thead>
              <tbody>
                {sites.map((s) => (
                  <tr key={s.id}>
                    <td className="font-medium whitespace-nowrap">{s.name}<div className="help">{s.team} · {GROUP_LABEL[s.grp]}</div></td>
                    <td className="hidden md:table-cell text-muted">{s.niches.map(nicheLabel).join(", ") || "—"}</td>
                    <td className="text-right tabular-nums">{n(s.articles)}</td>
                    <td className="text-right tabular-nums">{n(s.topics.hi)} / {n(s.topics.mid)} / {n(s.topics.low)}{s.topics.other ? <span className="help"> (+{n(s.topics.other)} б/д)</span> : null}</td>
                    <td className="text-right tabular-nums font-semibold">{n(s.addable)}</td>
                    <td className="text-[12.5px] whitespace-nowrap">
                      {s.recipient ? <span className="text-ok">получатель</span> : <span className="text-muted">не привязан</span>}
                      {!s.writingOn && <div className="text-warn">написание выключено</div>}
                      {!s.donor && <div className="text-muted">не донор</div>}
                    </td>
                    {admin && (
                      <td>
                        <ActionForm action={createTopUpBatch} className="flex items-center gap-1.5" hidden={{ siteId: s.id }}>
                          <input name="count" type="number" min={1} max={2000} placeholder="50" className="input py-1 w-20" />
                          <input name="hiPct" type="number" min={0} max={100} defaultValue={30} title="% ВЧ" className="input py-1 w-16" />
                          <SubmitButton className="btn-ghost btn-sm" pendingText="…">Партия</SubmitButton>
                        </ActionForm>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="help mt-2">Второе поле — доля ВЧ в процентах. Сайт, который не привязан получателем, партия всё равно примет: привязка нужна только суточной автосборке. У сайтов с выключенным «Написанием» статьи будут ждать включения.</p>
        </Card>

        <Card title="Калькулятор новых сайтов" description="Сколько новых сайтов вытянет банк и какую раскладку дать каждому. Правило: 30 % ВЧ, 35 % СЧ, 35 % НЧ, ниши пропорционально ёмкости.">
          <form method="get" action="/pinterest/copy/plan" className="mb-3 flex flex-wrap items-end gap-3">
            <label className="block"><span className="label">Группа</span><select name="grp" defaultValue={grp} className="input py-1.5"><option value="women">Женские</option><option value="interior">Интерьер</option></select></label>
            {[1, 2, 3].map((i) => (
              <div key={i} className="flex items-end gap-1.5">
                <label className="block"><span className="label">Сайтов</span><input name={`s${i}`} type="number" min={0} defaultValue={sp[`s${i}`] ?? (i === 1 ? 5 : 0)} className="input py-1.5 w-20" /></label>
                <span className="pb-2 text-muted">×</span>
                <label className="block"><span className="label">статей</span><input name={`a${i}`} type="number" min={0} defaultValue={sp[`a${i}`] ?? (i === 1 ? 500 : i === 2 ? 1000 : 300)} className="input py-1.5 w-24" /></label>
              </div>
            ))}
            <button className="btn-ghost">Посчитать</button>
          </form>
          <Alert tone={plan.feasible ? "ok" : "warn"}>
            Нужно {n(plan.requested)} статей, банк группы даёт ≈ {n(plan.capacity)}: {plan.feasible ? "хватает" : "не хватает"}.
            {plan.feasible ? ` После запуска останется ≈ ${n(plan.leftover.reduce((s, l) => s + l.articles, 0))} статей.` : " Уменьшите число сайтов или статей, либо подождите пополнения банка."}
          </Alert>
          {plan.perSite.length > 0 && (
            <div className="table-wrap mt-3">
              <table className="table">
                <thead><tr><th>Ниша</th><th className="text-right">На один сайт (макс. из групп)</th><th className="text-right">ВЧ</th><th className="text-right">СЧ</th><th className="text-right">НЧ</th><th className="text-right">Останется в нише</th></tr></thead>
                <tbody>
                  {plan.perSite.map((p) => (
                    <tr key={p.niche}>
                      <td>{nicheLabel(p.niche)}</td>
                      <td className="text-right tabular-nums font-semibold">{n(p.total)}</td>
                      <td className="text-right tabular-nums">{n(p.hi)}</td>
                      <td className="text-right tabular-nums">{n(p.mid)}</td>
                      <td className="text-right tabular-nums">{n(p.low)}</td>
                      <td className="text-right tabular-nums text-muted">{n(plan.leftover.find((l) => l.niche === p.niche)?.articles ?? 0)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="help mt-2">Новый сайт добавляется в «Статьях» (или командой add-site), затем партия на него — через «Новая партия» с этой раскладкой. Банк пополняется, когда на сайтах-донорах выходят новые обычные статьи.</p>
        </Card>
      </div>
    </>
  );
}
