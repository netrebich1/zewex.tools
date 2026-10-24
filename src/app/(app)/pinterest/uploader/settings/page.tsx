import { Card, Field, PageHeader } from "@/components/ui";
import { ActionForm } from "@/components/ActionForm";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { isAdmin, requireUploader } from "@/lib/uploader/access";
import { uplSettings } from "@/lib/uploader/runs";
import { HUMANIZE_FIELDS, parseHumanize } from "@/lib/uploader/types";
import { saveDolphinTokenAction, saveSettingsAction } from "@/actions/uploader";

export const dynamic = "force-dynamic";

/** Настройки: токен Dolphin API (один на команду Dolphin), «человечность» агента, задержки проверки, адрес массовой загрузки. */
export default async function UploaderSettingsPage() {
  const me = await requireUploader();
  const s = await uplSettings();
  const h = parseHumanize(s.humanize);
  const admin = isAdmin(me);
  return (
    <>
      <PageHeader title="Настройки" subtitle="Общие для всех агентов. Меняет администратор; агенты получают настройки при каждом выходе на связь, пересобирать программу не нужно." />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Токен Dolphin Anty API" description="Выдаётся в кабинете Dolphin (dolphin-anty.com → API). Один на команду Dolphin; хранится зашифрованным, агенты получают его по своему токену.">
          <p className="text-[13.5px] mb-2">Сейчас: {s.dolphinHint ? <code>{s.dolphinHint}</code> : <span className="text-warn">не задан — агенты не смогут открыть профили</span>}</p>
          {admin && (
            <ActionForm action={saveDolphinTokenAction} className="space-y-2">
              <input name="token" className="input font-mono text-[12.5px]" placeholder="вставьте токен Dolphin API" autoComplete="off" />
              <SubmitButton className="btn-primary" pendingText="Сохраняю…">Сохранить токен</SubmitButton>
            </ActionForm>
          )}
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
