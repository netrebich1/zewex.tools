import { requireUser } from "@/lib/auth";
import { Card, Empty, PageHeader } from "@/components/ui";
import { ActionForm } from "@/components/ActionForm";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { saveCopyAuto, saveCopyRules, saveCopySites } from "@/actions/copy";
import { settingsData } from "@/lib/copy/queries";
import { sheetsConnection } from "@/lib/articles/sheets";
import { GROUP_LABEL } from "@/lib/copy/keys";

export const dynamic = "force-dynamic";

/** Сайты-доноры и сайты-получатели Article Copy, правила сборки, таблица публикаций, фоновая автосборка. */
export default async function CopySettingsPage() {
  const me = await requireUser();
  const [d, sheets] = await Promise.all([settingsData(me), sheetsConnection()]);
  const st = d.settings;
  const admin = me.role === "ADMIN";
  const teams = [...new Set(d.sites.map((s) => s.team))];

  return (
    <>
      <PageHeader title="Сайты и правила" subtitle="Откуда берём фото (доноры) и куда публикуем новые статьи (получатели) — это разные роли одного списка сайтов." back={{ href: "/pinterest/copy", label: "Запас" }} />
      <div className="space-y-5">
        <Card title="Сайты: доноры и получатели" description="Донор — из его опубликованных статей и резерва берутся кадры в общий банк (по умолчанию все сайты). Получатель — на него ставятся новые мешап-статьи; тема, которая уже стоит на сайте в любой формулировке, на него больше не попадёт. Сайт может быть и тем, и другим. Ниши не смешиваются: на интерьерный сайт идут только темы интерьера.">
          {d.sites.length === 0 ? (
            <Empty title="Сайтов нет" hint="Сначала подключите сайт в сервисе «Статьи»." />
          ) : (
            <ActionForm action={saveCopySites} className="space-y-4">
              <div className="table-wrap">
                <table className="table">
                  <thead><tr><th>Сайт</th><th className="hidden sm:table-cell">Группа</th><th className="text-right hidden sm:table-cell">Статей</th><th className="text-center">Донор<div className="help font-normal">берём фото</div></th><th className="text-center">Получатель<div className="help font-normal">публикуем</div></th></tr></thead>
                  <tbody>
                    {teams.map((t) => [
                      <tr key={`t-${t}`}><td colSpan={5} className="bg-ink/5 text-[12.5px] font-semibold">{t}</td></tr>,
                      ...d.sites.filter((s) => s.team === t).map((s) => (
                        <tr key={s.id}>
                          <td className="font-medium">{s.name}</td>
                          <td className="hidden sm:table-cell text-muted">{GROUP_LABEL[s.grp]}</td>
                          <td className="hidden sm:table-cell text-right tabular-nums text-muted">{s.articles}</td>
                          <td className="text-center"><input type="checkbox" name="donor" value={s.id} defaultChecked={s.donor} /></td>
                          <td className="text-center"><input type="checkbox" name="site" value={s.id} defaultChecked={s.bound} /></td>
                        </tr>
                      )),
                    ])}
                  </tbody>
                </table>
              </div>
              <p className="help">Сами мешап-статьи донорами не бывают никогда — их кадры уже учтены у исходных статей. Снимите «донор» у тестовых и чужих по тематике сайтов.</p>
              <SubmitButton className="btn-brand" pendingText="Сохраняю…">Сохранить сайты</SubmitButton>
            </ActionForm>
          )}
        </Card>

        <Card title="Правила сборки" description="По этим числам считается запас и собираются статьи. Меняет администратор; общий банк — только главный администратор.">
          <ActionForm action={saveCopyRules} className="space-y-4">
            <div className="flex flex-wrap items-end gap-4">
              <label className="block"><span className="label">Фото в статье по умолчанию</span><input name="photosPerArticle" type="number" min={5} max={100} defaultValue={st.photosPerArticle} disabled={!admin} className="input py-1.5 w-28" /></label>
              <label className="block"><span className="label">Общих кадров с одной статьёй, % не больше</span><input name="maxOverlapPct" type="number" min={0} max={100} defaultValue={st.maxOverlapPct} disabled={!admin} className="input py-1.5 w-28" /></label>
              <label className="block"><span className="label">Одно фото в статьях одной темы, раз не больше</span><input name="maxUsesPerCore" type="number" min={1} max={20} defaultValue={st.maxUsesPerCore} disabled={!admin} className="input py-1.5 w-28" /></label>
              <label className="block"><span className="label">Одно фото во всех статьях, раз не больше</span><input name="maxUsesTotal" type="number" min={1} max={20} defaultValue={st.maxUsesTotal} disabled={!admin} className="input py-1.5 w-28" /></label>
              <label className="block"><span className="label">Одно фото на одном сайте, раз не больше</span><input name="maxPerSite" type="number" min={1} max={10} defaultValue={st.maxPerSite} disabled={!admin} className="input py-1.5 w-28" /></label>
              <label className="block"><span className="label">Доля резерва в статье, %</span><input name="reservePct" type="number" min={0} max={100} defaultValue={st.reservePct} disabled={!admin} className="input py-1.5 w-28" /></label>
              <label className="block"><span className="label">Не собирать, если кадров меньше</span><input name="minPhotos" type="number" min={5} max={100} defaultValue={st.minPhotos} disabled={!admin} className="input py-1.5 w-28" /></label>
              <label className="block"><span className="label">Резерв с оценкой ИИ от</span><input name="minReserveScore" type="number" min={0} max={10} step={0.5} defaultValue={st.minReserveScore} disabled={!admin} className="input py-1.5 w-28" /></label>
            </div>
            <p className="help">Оба лимита считают и исходную статью: при «3 на тему» кадр появится ещё в двух статьях той же темы, при «6 всего» — ещё в пяти статьях любых тем. Партия может задать своё число фото (и диапазон «от–до»).</p>
            <label className="block"><span className="label">Google-таблица публикаций</span><input name="sheetUrl" defaultValue={st.sheetUrl ?? ""} placeholder="https://docs.google.com/spreadsheets/d/…" disabled={!admin} className="input py-1.5 w-full max-w-xl" /></label>
            <p className="help">Каждая опубликованная мешап-статья дописывается строкой на вкладку своего сайта (вкладка = домен, создаётся сама): Keyword, Niche, Class, Volume, Publish URL, Data Publish, Photos, Batch, Site. {sheets.email ? <>Дайте таблице доступ «Редактор» для <b>{sheets.email}</b>.</> : "Сервисный аккаунт Google Таблиц не настроен в «Статьях»."}</p>
            <label className="inline-flex items-center gap-2 text-[14px]">
              <input type="checkbox" name="sharedBank" defaultChecked={st.sharedBank} disabled={!me.superAdmin} />
              Общий банк фото на все команды <span className="help">(выключено — каждая команда собирает только из своих статей)</span>
            </label>
            {admin && <div><SubmitButton className="btn-brand" pendingText="Сохраняю…">Сохранить правила</SubmitButton></div>}
          </ActionForm>
        </Card>

        <Card title="Фоновая автосборка (не основной режим)" description="Основной способ — партии. Этот режим «капает» по норме в сутки на каждого получателя: сам выбирает тему, формулировку и кадры. По умолчанию выключен.">
          <ActionForm action={saveCopyAuto} className="space-y-4">
            <label className="inline-flex items-center gap-2 text-[14px] font-medium">
              <input type="checkbox" name="autoEnabled" defaultChecked={st.autoEnabled} disabled={!admin} />
              Собирать и публиковать статьи автоматически по суточной норме
            </label>
            <div className="flex flex-wrap items-end gap-4">
              <label className="block"><span className="label">Статей в сутки на один сайт</span><input name="dailyPerSite" type="number" min={1} max={50} defaultValue={st.dailyPerSite} disabled={!admin} className="input py-1.5 w-28" /></label>
            </div>
            <label className="inline-flex items-center gap-2 text-[14px]">
              <input type="checkbox" name="reviewBeforePublish" defaultChecked={st.reviewBeforePublish} disabled={!admin} />
              Показывать статью в модерации статей перед публикацией <span className="help">(выключено — публикуется сама)</span>
            </label>
            <p className="help">Текст пишется ключами ИИ той команды, чей сайт. Написание идёт в общей очереди сервиса «Статьи» и подчиняется его лимитам сайта.</p>
            {admin && <div><SubmitButton className="btn-brand" pendingText="Сохраняю…">Сохранить</SubmitButton></div>}
          </ActionForm>
        </Card>
      </div>
    </>
  );
}
