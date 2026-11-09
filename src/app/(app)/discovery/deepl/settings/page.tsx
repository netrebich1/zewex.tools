import Link from "next/link";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { Alert, Card, PageHeader } from "@/components/ui";
import { ActionForm } from "@/components/ActionForm";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { DeeplHeader } from "@/components/deepl/DeeplHeader";
import { deleteDeeplPrompt, deleteDeeplScenario, saveDeeplPrompt } from "@/actions/deepl";
import { describeSettings, parseSettings } from "@/lib/deepl/types";

export const dynamic = "force-dynamic";

const PURPOSES: Record<string, string> = { headings: "Заголовки H2", post_edit: "Постредактура", any: "Любой этап" };

export default async function DeeplSettingsPage() {
  const me = await requireUser();
  const admin = me.role === "ADMIN";
  const [prompts, scenarios, slot] = await Promise.all([
    prisma.deeplPrompt.findMany({ orderBy: [{ purpose: "asc" }, { name: "asc" }] }),
    prisma.deeplScenario.findMany({ orderBy: [{ sortOrder: "asc" }, { name: "asc" }] }),
    prisma.slot.findFirst({ where: { key: "text_main", project: { slug: "deepl" } }, select: { _count: { select: { bindings: true } } } }),
  ]);

  return (
    <>
      <DeeplHeader />
      <PageHeader back={{ href: "/discovery/deepl", label: "Прогоны" }} title="Промты и сценарии" subtitle="Промты этапов H2 и постредактуры, сохранённые сценарии. Ключи DeepL — на вкладке «Ключи DeepL»." />

      <div className="space-y-5">
        <Card title="Ключ OpenRouter для редактуры" description="H2, постредактура и добор ключей идут через слот «Редактура (OpenRouter)» проекта DeepL Articler; модель можно задать в прогоне.">
          {(slot?._count.bindings ?? 0) > 0
            ? <p className="text-[14px]">Ключ подключён. {admin && <Link href="/projects/deepl" className="underline">Правила и модели →</Link>}</p>
            : <Alert tone="warn">Ключ ещё не подключён. {admin ? <>Откройте <Link href="/projects/deepl" className="underline">страницу проекта</Link> или страницу ключа OpenRouter и отметьте «DeepL Articler».</> : "Попросите администратора подключить ключ OpenRouter."}</Alert>}
        </Card>

        <Card title="Промты" description="Промт H2 получает список заголовков и Title/H1; промт постредактуры правит текст по 3 секции. Системные правила (разметка, ссылки, женский голос автора, точечная правка) добавляются к любому промту автоматически.">
          <div className="space-y-3">
            {prompts.map((p) => (
              <details key={p.id} className="rounded-lg border border-line">
                <summary className="cursor-pointer px-3 py-2 text-[14px]"><b>{p.name}</b> <span className="help">· {PURPOSES[p.purpose] ?? p.purpose} · {p.body.length} знаков</span></summary>
                <div className="border-t border-line p-3 space-y-2">
                  <ActionForm action={saveDeeplPrompt} hidden={{ id: p.id }} className="space-y-2">
                    <div className="flex flex-wrap gap-2">
                      <input name="name" className="input grow min-w-[200px]" defaultValue={p.name} />
                      <select name="purpose" className="input w-auto" defaultValue={p.purpose}>
                        {Object.entries(PURPOSES).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                      </select>
                    </div>
                    <textarea name="body" className="input min-h-[260px] font-mono text-[12px]" defaultValue={p.body} />
                    <SubmitButton className="btn-primary btn-sm" pendingText="…">Сохранить</SubmitButton>
                  </ActionForm>
                  <ActionForm action={deleteDeeplPrompt} hidden={{ id: p.id }} className="inline">
                    <SubmitButton className="btn-ghost btn-sm text-danger" pendingText="…" confirm={`Удалить промт «${p.name}»? Сценарии с ним придётся поправить.`}>Удалить промт</SubmitButton>
                  </ActionForm>
                </div>
              </details>
            ))}
            <details className="rounded-lg border border-dashed border-line">
              <summary className="cursor-pointer px-3 py-2 text-[14px] font-medium">+ Новый промт</summary>
              <ActionForm action={saveDeeplPrompt} className="space-y-2 border-t border-line p-3">
                <div className="flex flex-wrap gap-2">
                  <input name="name" className="input grow min-w-[200px]" placeholder="Название" />
                  <select name="purpose" className="input w-auto" defaultValue="post_edit">
                    {Object.entries(PURPOSES).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </select>
                </div>
                <textarea name="body" className="input min-h-[200px] font-mono text-[12px]" placeholder="Текст промта" />
                <SubmitButton className="btn-primary btn-sm" pendingText="…">Создать</SubmitButton>
              </ActionForm>
            </details>
          </div>
        </Card>

        <Card title="Сценарии" description="Сохраняются из формы нового прогона кнопкой «Сохранить сценарий» и применяются там одним выбором.">
          {scenarios.length === 0 ? <p className="help">Сценариев нет.</p> : (
            <div className="table-wrap">
              <table className="table">
                <tbody>
                  {scenarios.map((s) => (
                    <tr key={s.id}>
                      <td className="font-medium">{s.name}</td>
                      <td className="help">{describeSettings(parseSettings(s.settings))}</td>
                      <td className="text-right">
                        <ActionForm action={deleteDeeplScenario} hidden={{ id: s.id }} className="inline">
                          <SubmitButton className="btn-ghost btn-sm text-danger" pendingText="…" confirm={`Удалить сценарий «${s.name}»?`}>Удалить</SubmitButton>
                        </ActionForm>
                      </td>
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
