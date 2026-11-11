import { requireUser } from "@/lib/auth";
import { ActionForm } from "@/components/ActionForm";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { Alert, Card, Field, PageHeader } from "@/components/ui";
import { SocialNav } from "@/components/social/SocialNav";
import { saveSocialTemplate } from "@/actions/social";
import { metricoolHeader } from "@/lib/social/runs";
import { fmtDate } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function SocialSettings() {
  const me = await requireUser();
  const tpl = await metricoolHeader();
  const canEdit = me.role === "ADMIN" || me.leadTeamIds.length > 0;
  return (
    <>
      <SocialNav />
      <PageHeader title="Шаблон Metricool" subtitle="Metricool принимает только файл со своими колонками: их нельзя добавлять, удалять и переставлять. Поэтому строка заголовков берётся из шаблона вашего аккаунта." />
      <div className="mb-4">
        {tpl.custom ? (
          <Alert tone="ok">Загружен шаблон из аккаунта: {tpl.header.length} колонок, обновлён {fmtDate(tpl.updatedAt)}.</Alert>
        ) : (
          <Alert tone="warn">Шаблон не загружен. Сейчас используются {tpl.header.length} колонок из справки Metricool — названия верные, но порядок в вашем аккаунте может отличаться. Загрузите шаблон до первого импорта.</Alert>
        )}
      </div>
      <Card title="Как получить шаблон" description="Делается один раз. Повторить, если Metricool поменяет колонки (импорт начнёт ругаться на файл).">
        <ol className="list-decimal space-y-1 pl-5 text-[14px]">
          <li>Откройте Metricool и переключите язык интерфейса на английский (шаблон на другом языке не подойдёт).</li>
          <li>Planner → кнопка с тремя точками → Import CSV → Download template.</li>
          <li>Загрузите скачанный файл сюда. Данные из него не нужны — берётся только первая строка.</li>
        </ol>
      </Card>
      {canEdit && (
        <div className="mt-4">
          <Card title="Загрузить шаблон">
            <ActionForm action={saveSocialTemplate}>
              <Field label="Файл шаблона (.csv)"><input type="file" name="file" accept=".csv,text/csv" className="input w-full" /></Field>
              <Field label="или строка заголовков" hint="Первая строка шаблона целиком, как в файле."><textarea name="header" rows={3} className="input w-full font-mono !text-[13px]" /></Field>
              <div className="flex flex-wrap gap-2">
                <SubmitButton className="btn-brand">Сохранить шаблон</SubmitButton>
                {tpl.custom && <button type="submit" name="reset" value="1" className="btn-ghost">Вернуть колонки из справки</button>}
              </div>
            </ActionForm>
          </Card>
        </div>
      )}
      <div className="mt-4">
        <Card title={`Колонки сейчас (${tpl.header.length})`}>
          <p className="break-words font-mono text-[12.5px] leading-relaxed text-muted">{tpl.header.join(" · ")}</p>
        </Card>
      </div>
    </>
  );
}
