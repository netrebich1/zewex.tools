import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { ActionForm } from "@/components/ActionForm";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { Alert, Card, Empty, Field, PageHeader } from "@/components/ui";
import { CompNav } from "@/components/competitors/CompNav";
import { saveCompSettings } from "@/actions/competitors";
import { canManage, canSee, countryOptions, loadState } from "@/lib/competitors/sites";
import { DFS_LOCATIONS } from "@/lib/competitors/types";
import { fmtDate, fmtMoney } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function CompetitorsSettings() {
  const me = await requireUser();
  if (!(await canSee(me))) return <Empty title="Нет доступа" hint="«Анализ конкурентов» открыт команде WexOra." />;
  const [state, countries, manage] = await Promise.all([loadState(), countryOptions(), canManage(me)]);
  const s = state.settings;
  const since = new Date(Date.now() - 30 * 86_400_000);
  const [spent, analyzed] = await Promise.all([
    prisma.compSite.aggregate({ _sum: { costUsd: true }, where: { analyzedAt: { gte: since } } }),
    prisma.compSite.count({ where: { analyzedAt: { gte: since }, status: { in: ["done", "empty"] } } }),
  ]);
  // Страны из настроек показываем всегда, даже если площадок по ним сейчас нет.
  const options = [...countries.filter((c) => DFS_LOCATIONS[c.name]), ...s.countries.filter((c) => !countries.some((x) => x.name === c)).map((name) => ({ name, count: 0 }))];
  const perSite = 0.01 + s.kwLimit * 0.00013 + 0.011;

  return (
    <>
      <CompNav />
      <PageHeader title="Настройки" subtitle="Каталог Collaborator собирается раз в сутки после 06:00 по Киеву: все площадки за 3 месяца с кликами Search Console. Ниже — какие из них разбирать автоматически." />
      <div className="mb-4">
        <Alert>
          За 30 дней разобрано площадок: <b>{analyzed}</b>, расход <b>{fmtMoney(spent._sum.costUsd ?? 0)}</b> (ключи команды WexOra).{" "}
          {state.lastSyncAt ? <>Последний сбор каталога — {fmtDate(state.lastSyncAt)}: в каталоге {state.lastSync?.total ?? "—"}, с кликами GSC {state.lastSync?.kept ?? "—"}, новых {state.lastSync?.fresh ?? "—"}.</> : <>Каталог ещё не собирался.</>}
        </Alert>
      </div>
      <Card title="Авторазбор" description={`Одна площадка — запрос в DataForSEO и один вызов модели, примерно ${fmtMoney(perSite)} при ${s.kwLimit} запросах. Вручную можно разобрать любую площадку кнопкой в списке.`}>
        <ActionForm action={saveCompSettings}>
          <label className="flex items-center gap-2 text-[14px]">
            <input type="checkbox" name="enabled" defaultChecked={s.enabled} disabled={!manage} /> Собирать каталог и разбирать новые площадки автоматически
          </label>
          <Field label="Страны" hint="Разбор идёт по базе Google этой страны. В списке только страны, которые есть у площадок и которые знает DataForSEO.">
            <div className="flex flex-wrap gap-x-4 gap-y-1.5">
              {options.map((c) => (
                <label key={c.name} className="flex items-center gap-1.5 text-[14px]">
                  <input type="checkbox" name="countries" value={c.name} defaultChecked={s.countries.includes(c.name)} disabled={!manage} /> {c.name} <span className="help">{c.count}</span>
                </label>
              ))}
            </div>
          </Field>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Field label="Добавлены не раньше, дней назад" hint="От 7 до 92."><input name="periodDays" type="number" min={7} max={92} defaultValue={s.periodDays} className="input" disabled={!manage} /></Field>
            <Field label="Сделок в Collaborator от" hint="0 — брать и без сделок."><input name="minDeals" type="number" min={0} max={50} defaultValue={s.minDeals} className="input" disabled={!manage} /></Field>
            <Field label="Кликов GSC за месяц от"><input name="minClicks" type="number" min={1} defaultValue={s.minClicks} className="input" disabled={!manage} /></Field>
            <Field label="Запросов с сайта" hint="Самые трафиковые из топ-30. От 50 до 1000; больше — дороже."><input name="kwLimit" type="number" min={50} max={1000} step={50} defaultValue={s.kwLimit} className="input" disabled={!manage} /></Field>
            <Field label="Площадок в сутки, не больше" hint="Защита расхода. 0 — авторазбор стоит, только вручную."><input name="dailyLimit" type="number" min={0} max={500} defaultValue={s.dailyLimit} className="input" disabled={!manage} /></Field>
          </div>
          {manage ? <SubmitButton className="btn-brand">Сохранить</SubmitButton> : <p className="help">Менять настройки может администратор или лидер команды WexOra.</p>}
        </ActionForm>
      </Card>
    </>
  );
}
