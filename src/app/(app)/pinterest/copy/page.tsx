import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { Card, Empty, PageHeader } from "@/components/ui";
import { ActionForm } from "@/components/ActionForm";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { requestCopyRebuild } from "@/actions/copy";
import { dashboardData } from "@/lib/copy/queries";
import { FORMULATIONS, VOL_LABEL, fmtVolume, modifierLabel, nicheLabel } from "@/lib/copy/keys";
import { fmtDate } from "@/lib/utils";

type NicheStat = { published: number; reserve: number; uses1: number; uses2: number; uses3: number; usesLeft: number };

export const dynamic = "force-dynamic";

const n = (v: number) => v.toLocaleString("ru-RU");

/** Запас Article Copy: сколько ядер, формулировок и кадров накоплено и сколько новых статей из них выходит по правилам. */
export default async function CopyHome({ searchParams }: { searchParams: Promise<{ team?: string; niche?: string; q?: string; only?: string; cls?: string }> }) {
  const me = await requireUser();
  const f = await searchParams;
  const d = await dashboardData(me, f);
  const st = d.settings;
  const stats = ((st.stats as { niches?: Record<string, NicheStat> } | null)?.niches) ?? {};
  const statRows = Object.entries(stats).sort((a, b) => b[1].usesLeft - a[1].usesLeft);
  const statTotal = statRows.reduce((a, [, s]) => ({ published: a.published + s.published, reserve: a.reserve + s.reserve, uses1: a.uses1 + s.uses1, uses2: a.uses2 + s.uses2, uses3: a.uses3 + s.uses3, usesLeft: a.usesLeft + s.usesLeft }), { published: 0, reserve: 0, uses1: 0, uses2: 0, uses3: 0, usesLeft: 0 });
  const totals = d.summary.reduce((a, s) => ({ cores: a.cores + s.cores, byPhotos: a.byPhotos + s.byPhotos, capacity: a.capacity + s.capacity }), { cores: 0, byPhotos: 0, capacity: 0 });
  const qs = (patch: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...f, ...patch })) if (v) p.set(k, v);
    const s = p.toString();
    return s ? `/pinterest/copy?${s}` : "/pinterest/copy";
  };

  return (
    <>
      <PageHeader
        title="Article Copy — запас"
        subtitle={`Новые статьи из уже одобренных фото: тратимся только на текст. Правила: ${st.photosPerArticle} фото в статье, не больше ${st.maxOverlapPct}% общих кадров с любой существующей статьёй, тема на сайте один раз, банк ${st.sharedBank ? "общий" : "у каждой команды свой"}.`}
        actions={<div className="flex gap-2"><Link href="/pinterest/copy/batches/new" className="btn-brand">Новая партия</Link><Link href="/pinterest/copy/settings" className="btn-ghost">Сайты и правила</Link></div>}
      />
      <div className="space-y-5">
        <Card title="Сколько можно собрать" description="«По кадрам» — сколько статей выходит из накопленных фото. «На сайты» — сколько из них есть куда поставить: привязанные сайты, где этой темы ещё нет.">
          {!st.builtAt ? (
            <Empty title="Запас ещё не посчитан" hint="Расчёт занимает 4–5 минут. Обновите страницу чуть позже." />
          ) : (
            <>
              <div className="mb-3 flex flex-wrap items-center gap-2 text-[13px]">
                <span className="inline-flex items-center gap-2 rounded-full bg-ink/5 px-3 py-1.5">Ядер: <b className="tabular-nums">{n(totals.cores)}</b></span>
                <span className="inline-flex items-center gap-2 rounded-full bg-ink/5 px-3 py-1.5">Статей по кадрам: <b className="tabular-nums">{n(totals.byPhotos)}</b></span>
                <span className={`inline-flex items-center gap-2 rounded-full px-3 py-1.5 ${totals.capacity ? "bg-ok-soft text-ok" : "bg-brand-soft text-warn"}`}>Можно поставить на сайты: <b className="tabular-nums">{n(totals.capacity)}</b></span>
                <span className="help">Посчитано {fmtDate(st.builtAt)} за {Math.round(st.buildMs / 1000)} с</span>
              </div>
              {d.boundSites === 0 && <p className="mb-3 rounded-lg bg-brand-soft px-3 py-2 text-[13px] text-warn">Ни один сайт не привязан, поэтому «на сайты» везде 0. Отметьте сайты на вкладке <Link href="/pinterest/copy/settings" className="underline">«Сайты и правила»</Link>.</p>}
              {st.buildError && <p className="mb-3 rounded-lg bg-danger-soft px-3 py-2 text-[13px] text-danger">Последний расчёт упал: {st.buildError}</p>}
              <div className="table-wrap">
                <table className="table">
                  <thead><tr><th>Команда</th><th>Ниша</th><th className="text-right">Ядер</th><th className="text-right">Статей уже есть</th><th className="text-right">Фото в статьях</th><th className="text-right">Резерв</th><th className="text-right">Сайтов привязано</th><th className="text-right">Статей по кадрам</th><th className="text-right">На сайты</th></tr></thead>
                  <tbody>
                    {d.summary.map((s) => (
                      <tr key={`${s.teamId}|${s.niche}`}>
                        <td>{s.team}</td>
                        <td><Link href={qs({ team: s.teamId, niche: s.niche })} className="hover:underline">{nicheLabel(s.niche)}</Link></td>
                        <td className="text-right tabular-nums">{n(s.cores)}</td>
                        <td className="text-right tabular-nums text-muted">{n(s.articles)}</td>
                        <td className="text-right tabular-nums text-muted">{n(s.photosPublished)}</td>
                        <td className="text-right tabular-nums text-muted">{n(s.photosReserve)}</td>
                        <td className="text-right tabular-nums">{s.sites}</td>
                        <td className="text-right tabular-nums">{n(s.byPhotos)}</td>
                        <td className="text-right tabular-nums font-semibold">{n(s.capacity)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="help mt-2">Фото и резерв считаются внутри ядра: один кадр, подходящий двум ядрам, учтён в обоих. Оценка сверху — лимит «{st.maxPerSite} раза на сайт» и нерабочие ссылки резерва проверяются при сборке статьи.</p>
            </>
          )}
        </Card>

        {statRows.length > 0 && (
          <Card title="Кадры: сколько использовано и сколько ещё можно" description={`Один кадр может стоять не больше ${st.maxUsesTotal} раз во всех статьях (исходная считается). «Осталось использований» — сколько раз кадры ниши ещё можно поставить; делённое на фото в статье — примерно сколько статей из этого выходит без учёта тем.`}>
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Ниша</th><th className="text-right">Фото в статьях</th><th className="text-right">Резерв (не публиковался)</th><th className="text-right">Стоит 1 раз</th><th className="text-right">2 раза</th><th className="text-right">{st.maxUsesTotal}+ раз (исчерпан)</th><th className="text-right">Осталось использований</th><th className="text-right">≈ статей по {st.photosPerArticle} фото</th></tr></thead>
                <tbody>
                  {statRows.map(([niche, s]) => (
                    <tr key={niche}>
                      <td>{nicheLabel(niche)}</td>
                      <td className="text-right tabular-nums">{n(s.published)}</td>
                      <td className="text-right tabular-nums">{n(s.reserve)}</td>
                      <td className="text-right tabular-nums text-muted">{n(s.uses1)}</td>
                      <td className="text-right tabular-nums text-muted">{n(s.uses2)}</td>
                      <td className="text-right tabular-nums text-muted">{n(s.uses3)}</td>
                      <td className="text-right tabular-nums font-semibold">{n(s.usesLeft)}</td>
                      <td className="text-right tabular-nums">{n(Math.floor(s.usesLeft / Math.max(1, st.photosPerArticle)))}</td>
                    </tr>
                  ))}
                  <tr className="font-semibold"><td>Всего</td><td className="text-right tabular-nums">{n(statTotal.published)}</td><td className="text-right tabular-nums">{n(statTotal.reserve)}</td><td className="text-right tabular-nums">{n(statTotal.uses1)}</td><td className="text-right tabular-nums">{n(statTotal.uses2)}</td><td className="text-right tabular-nums">{n(statTotal.uses3)}</td><td className="text-right tabular-nums">{n(statTotal.usesLeft)}</td><td className="text-right tabular-nums">{n(Math.floor(statTotal.usesLeft / Math.max(1, st.photosPerArticle)))}</td></tr>
                </tbody>
              </table>
            </div>
          </Card>
        )}

        <Card title="Ядра и формулировки" description="Ядро — ключ без приставки и года. Формулировки одного ядра считаются одной темой. Частотность — Ads Manager (США) из «Подбора ключей»: ВЧ от 30 000, СЧ 10–30 000, НЧ 3 000–10 000. Показаны первые 300, сверху — где можно собрать больше всего."
          actions={<ActionForm action={requestCopyRebuild} className="flex items-center gap-2"><SubmitButton className="btn-ghost btn-sm" pendingText="…">Пересчитать</SubmitButton></ActionForm>}>
          <form method="get" action="/pinterest/copy" className="mb-3 flex flex-wrap items-end gap-2">
            {d.teams.length > 1 && (
              <label className="block"><span className="label">Команда</span>
                <select name="team" defaultValue={f.team ?? ""} className="input py-1.5"><option value="">все</option>{d.teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
              </label>
            )}
            <label className="block"><span className="label">Ниша</span>
              <select name="niche" defaultValue={f.niche ?? ""} className="input py-1.5"><option value="">все</option>{d.niches.map((x) => <option key={x} value={x}>{nicheLabel(x)}</option>)}</select>
            </label>
            <label className="block"><span className="label">Частотность</span>
              <select name="cls" defaultValue={f.cls ?? ""} className="input py-1.5"><option value="">любая</option><option value="hi">ВЧ (от 30k)</option><option value="mid">СЧ (10–30k)</option><option value="low">НЧ (3–10k)</option><option value="small">мелкие (до 3k)</option><option value="none">нет данных</option></select>
            </label>
            <label className="block"><span className="label">Показать</span>
              <select name="only" defaultValue={f.only ?? ""} className="input py-1.5"><option value="">все ядра</option><option value="ready">можно собрать сейчас</option><option value="nosites">кадры есть, сайтов нет</option></select>
            </label>
            <label className="block"><span className="label">Поиск по ядру</span><input name="q" defaultValue={f.q ?? ""} placeholder="almond nails" className="input py-1.5 w-56" /></label>
            <button className="btn-ghost">Показать</button>
            <span className="help">Найдено: {n(d.total)}</span>
          </form>
          {d.cores.length === 0 ? (
            <Empty title="Ядер нет" hint="Измените фильтр или дождитесь расчёта." />
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Ядро</th><th className="hidden md:table-cell">Ниша</th><th className="text-right">Частотность</th><th className="text-right">Статей</th><th>Формулировки</th><th className="text-right">Фото</th><th className="text-right">Резерв</th><th className="text-right">По кадрам</th><th className="text-right">Свободных сайтов</th><th className="text-right">Можно собрать</th></tr></thead>
                <tbody>
                  {d.cores.map((c) => (
                    <tr key={c.id}>
                      <td className="min-w-[180px]"><Link href={`/pinterest/copy/cores/${c.id}`} className="font-medium hover:underline">{c.core}</Link>{d.teams.length > 1 && <div className="help">{c.team}</div>}</td>
                      <td className="hidden md:table-cell text-muted">{nicheLabel(c.niche)}</td>
                      <td className="text-right tabular-nums whitespace-nowrap" title={c.volume == null ? "ключа нет в «Подборе ключей»" : `${c.volume.toLocaleString("ru-RU")} — ${VOL_LABEL[c.volClass ?? "none"]}`}>{fmtVolume(c.volume)}{c.volClass && c.volClass !== "small" ? <span className="help ml-1">{VOL_LABEL[c.volClass]}</span> : null}</td>
                      <td className="text-right tabular-nums">{c.articles}</td>
                      <td className="text-[12.5px] text-muted" title={`Свободно из стандартных: ${FORMULATIONS.filter((m) => !c.usedModifiers.includes(m)).map(modifierLabel).join(", ") || "нет"}`}>{c.usedModifiers.map(modifierLabel).join(", ")} <span className="whitespace-nowrap">· свободно {c.freeModifiers}</span></td>
                      <td className="text-right tabular-nums text-muted">{c.photosPublished}</td>
                      <td className="text-right tabular-nums text-muted">{c.photosReserve}</td>
                      <td className="text-right tabular-nums">{c.byPhotos}</td>
                      <td className="text-right tabular-nums">{c.freeSites}</td>
                      <td className="text-right tabular-nums font-semibold">{c.capacity}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
