import { requireUser } from "@/lib/auth";
import { Card, Empty, PageHeader } from "@/components/ui";
import { ActionForm } from "@/components/ActionForm";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { saveCopyRules, saveCopySites } from "@/actions/copy";
import { settingsData } from "@/lib/copy/queries";
import { GROUP_LABEL } from "@/lib/copy/keys";

export const dynamic = "force-dynamic";

/** Сайты, на которые Article Copy может публиковать, и общие правила сборки. */
export default async function CopySettingsPage() {
  const me = await requireUser();
  const d = await settingsData(me);
  const st = d.settings;
  const admin = me.role === "ADMIN";
  const teams = [...new Set(d.sites.map((s) => s.team))];

  return (
    <>
      <PageHeader title="Сайты и правила" subtitle="Отметьте сайты, на которые можно ставить мешап-статьи. Тема, которая уже стоит на сайте в любой формулировке, на него больше не попадёт." back={{ href: "/pinterest/copy", label: "Запас" }} />
      <div className="space-y-5">
        <Card title="Сайты" description="Список берётся из сервиса «Статьи». Ниши не смешиваются: на сайт интерьера идут только темы интерьера, на женский — только женские.">
          {d.sites.length === 0 ? (
            <Empty title="Сайтов нет" hint="Сначала подключите сайт в сервисе «Статьи»." />
          ) : (
            <ActionForm action={saveCopySites} className="space-y-4">
              {teams.map((t) => (
                <div key={t}>
                  <div className="mb-1.5 text-[13px] font-semibold">{t}</div>
                  <div className="grid gap-x-6 gap-y-1.5 sm:grid-cols-2 lg:grid-cols-3">
                    {d.sites.filter((s) => s.team === t).map((s) => (
                      <label key={s.id} className="inline-flex items-center gap-2 text-[14px]">
                        <input type="checkbox" name="site" value={s.id} defaultChecked={s.bound} />
                        <span>{s.name}</span>
                        <span className="help">{GROUP_LABEL[s.grp]} · статей {s.articles}</span>
                      </label>
                    ))}
                  </div>
                </div>
              ))}
              <SubmitButton className="btn-brand" pendingText="Сохраняю…">Сохранить сайты</SubmitButton>
            </ActionForm>
          )}
        </Card>

        <Card title="Правила сборки" description="По этим числам считается запас и будут собираться статьи. Меняет администратор; общий банк — только главный администратор.">
          <ActionForm action={saveCopyRules} className="space-y-4">
            <div className="flex flex-wrap items-end gap-4">
              <label className="block"><span className="label">Фото в статье</span><input name="photosPerArticle" type="number" min={5} max={100} defaultValue={st.photosPerArticle} disabled={!admin} className="input py-1.5 w-28" /></label>
              <label className="block"><span className="label">Общих кадров с одной статьёй, % не больше</span><input name="maxOverlapPct" type="number" min={0} max={100} defaultValue={st.maxOverlapPct} disabled={!admin} className="input py-1.5 w-28" /></label>
              <label className="block"><span className="label">Одно фото на сайте, раз не больше</span><input name="maxPerSite" type="number" min={1} max={10} defaultValue={st.maxPerSite} disabled={!admin} className="input py-1.5 w-28" /></label>
              <label className="block"><span className="label">Резерв с оценкой ИИ от</span><input name="minReserveScore" type="number" min={0} max={10} step={0.5} defaultValue={st.minReserveScore} disabled={!admin} className="input py-1.5 w-28" /></label>
            </div>
            <label className="inline-flex items-center gap-2 text-[14px]">
              <input type="checkbox" name="sharedBank" defaultChecked={st.sharedBank} disabled={!me.superAdmin} />
              Общий банк фото на все команды <span className="help">(выключено — каждая команда собирает только из своих статей)</span>
            </label>
            {admin && <div><SubmitButton className="btn-brand" pendingText="Сохраняю…">Сохранить правила</SubmitButton></div>}
          </ActionForm>
        </Card>
      </div>
    </>
  );
}
