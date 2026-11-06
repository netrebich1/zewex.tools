import { Card, Field, PageHeader } from "@/components/ui";
import { ActionForm } from "@/components/ActionForm";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { isAdmin, requireUploader } from "@/lib/uploader/access";
import { uplSettings } from "@/lib/uploader/runs";
import { HUMANIZE_FIELDS, parseHumanize } from "@/lib/uploader/types";
import { saveDolphinTokenAction, saveSettingsAction } from "@/actions/uploader";
import { teamTokenRows } from "@/lib/uploader/teams";

export const dynamic = "force-dynamic";

/** Настройки: токены Dolphin API по командам портала, «человечность» агента, задержки проверки, адрес массовой загрузки. */
export default async function UploaderSettingsPage() {
  const me = await requireUploader();
  const [s, tokens] = await Promise.all([uplSettings(), teamTokenRows(me)]);
  const h = parseHumanize(s.humanize);
  const admin = isAdmin(me);
  return (
    <>
      <PageHeader title="Настройки" subtitle="Общие для всех агентов. Меняет администратор; агенты получают настройки при каждом выходе на связь, пересобирать программу не нужно." />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Токены Dolphin Anty API по командам" description="У каждой команды свой аккаунт Dolphin и свой токен (dolphin-anty.com → API). Агент получает токен только своей команды, и в сопоставлении сайтам предлагаются только профили их команды — профили команд не пересекаются. Меняет администратор или лид команды; хранится зашифрованным.">
          <div className="space-y-3">{tokens.map((t) => (
            <div key={t.teamId} className="rounded-xl border border-line p-3">
              <div className="flex flex-wrap items-center gap-2 text-[13.5px]"><b>{t.teamName}</b>{t.hint ? <code>{t.hint}</code> : <span className="text-warn">токен не задан — агенты команды не откроют профили</span>}{t.updatedAt ? <span className="help">· {t.updatedAt.toLocaleString("ru-RU", { timeZone: "Europe/Kyiv" })}</span> : null}</div>
              {t.canEdit && (
                <ActionForm action={saveDolphinTokenAction} className="mt-2 flex flex-wrap gap-2">
                  <input type="hidden" name="teamId" value={t.teamId} />
                  <input name="token" className="input font-mono text-[12.5px] min-w-[240px] flex-1" placeholder={`токен Dolphin API команды ${t.teamName}`} autoComplete="off" required />
                  <SubmitButton className="btn-primary" pendingText="Сохраняю…">{t.hint ? "Заменить" : "Сохранить"}</SubmitButton>
                </ActionForm>
              )}
            </div>
          ))}</div>
        </Card>
        <Card title="Поведение агента («как человек»)" description="Диапазоны «от–до»: агент каждый раз берёт случайное значение. Проверка истории: через сколько минут после конца заливки и как часто повторять, если Pinterest ещё обрабатывает.">
          <ActionForm action={saveSettingsAction} className="space-y-3">
            <fieldset disabled={!admin} className="space-y-3">
              <div className="grid gap-2 sm:grid-cols-2">
                {HUMANIZE_FIELDS.map((f) => (
                  <Field key={f.key} label={`${f.label}, ${f.unit}`}>
                    <div className="flex items-center gap-1.5"><input name={`${f.key}_min`} type="number" min={0} className="input w-[90px]" defaultValue={h[f.key][0]} /><span className="help">—</span><input name={`${f.key}_max`} type="number" min={0} className="input w-[90px]" defaultValue={h[f.key][1]} /></div>
                  </Field>
                ))}
              </div>
              <label className="flex items-center gap-1.5 text-[13.5px]"><input type="checkbox" name="browseFeed" defaultChecked={h.browseFeed} /> Перед загрузкой прокрутить ленту Pinterest</label>
              <div className="grid gap-2 sm:grid-cols-3">
                <Field label="Проверка через, мин"><input name="verifyDelayMin" type="number" min={1} max={240} className="input" defaultValue={s.verifyDelayMin} /></Field>
                <Field label="Повтор проверки через, мин"><input name="verifyRetryMin" type="number" min={5} max={720} className="input" defaultValue={s.verifyRetryMin} /></Field>
                <Field label="Повторов проверки"><input name="verifyRetries" type="number" min={0} max={10} className="input" defaultValue={s.verifyRetries} /></Field>
              </div>
              <Field label="Адрес страницы массовой загрузки Pinterest (если пусто — агент находит сам)" hint="Если Pinterest поменял адрес, впишите новый сюда — агент возьмёт его без обновления.">
                <input name="bulkUrl" className="input font-mono text-[12.5px]" defaultValue={s.bulkUrl ?? ""} placeholder="https://www.pinterest.com/…" />
              </Field>
              {admin && <SubmitButton className="btn-primary" pendingText="Сохраняю…">Сохранить</SubmitButton>}
            </fieldset>
          </ActionForm>
        </Card>
      </div>
    </>
  );
}
