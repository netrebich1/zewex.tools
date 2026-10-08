import { notFound } from "next/navigation";
import Link from "next/link";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { Badge, Card, Field, PageHeader } from "@/components/ui";
import { ActionForm } from "@/components/ActionForm";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { addModel, deleteModel, syncModels, toggleModel, updateProvider } from "@/actions/admin";
import { CAPABILITY_LABELS, fmtMoney } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function ProviderPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ all?: string; q?: string }> }) {
  const me = await requireUser();
  const { slug } = await params;
  const { all, q } = await searchParams;
  const provider = await prisma.provider.findUnique({
    where: { slug },
    include: { models: { orderBy: [{ isEnabled: "desc" }, { name: "asc" }] }, apiKeys: { select: { id: true, label: true, secretHint: true, status: true, ownerId: true }, orderBy: { label: "asc" } } },
  });
  if (!provider) notFound();
  const isAdmin = me.role === "ADMIN";
  const query = (q ?? "").toLowerCase();
  const visibleModels = provider.models.filter((m) => (all === "1" || m.isEnabled || query) && (!query || m.modelId.toLowerCase().includes(query) || m.name.toLowerCase().includes(query)));
  const caps = ["CHAT", "IMAGE", "EMBEDDING"];

  return (
    <>
      <PageHeader back={{ href: "/providers", label: "Провайдеры" }} title={provider.name} subtitle={<>{provider.baseUrl}{provider.docsUrl && <> · <a href={provider.docsUrl} target="_blank" rel="noreferrer" className="underline">документация</a></>}</>} actions={<Badge tone={provider.kind === "LLM" ? "ink" : "brand"}>{provider.kind === "LLM" ? "LLM-провайдер" : "Провайдер данных"}</Badge>} />

      <div className="space-y-4">
        <Card title="Ключи этого провайдера" actions={<Link href="/keys/new" className="btn-ghost btn-sm">+ Добавить ключ</Link>}>
          {provider.apiKeys.length === 0 ? <p className="help">Ключей нет.</p> : (
            <ul className="flex flex-wrap gap-2">
              {provider.apiKeys.filter((k) => isAdmin || !k.ownerId || k.ownerId === me.id).map((k) => (
                <li key={k.id}><Link href={`/keys/${k.id}`} className={`badge border ${k.status === "ACTIVE" ? "border-line bg-surface hover:border-ink/40" : "border-danger/30 bg-danger-soft text-danger"}`}>{k.label} · {k.secretHint}</Link></li>
              ))}
            </ul>
          )}
        </Card>

        {provider.kind === "LLM" && (
          <Card
            title="Модели"
            description="Включённые модели можно выбирать в правилах. Цены указаны за 1 млн токенов."
            actions={isAdmin && provider.modelsEndpoint ? (
              <ActionForm action={syncModels} className="inline" hidden={{ providerId: provider.id }}>
                <SubmitButton className="btn-primary btn-sm" pendingText="Загружаю…">↻ Обновить список у провайдера</SubmitButton>
              </ActionForm>
            ) : undefined}
          >
            <form className="mb-3 flex flex-wrap gap-2" method="get">
              <input name="q" className="input max-w-xs" placeholder="Поиск по моделям…" defaultValue={q ?? ""} />
              {all === "1" && <input type="hidden" name="all" value="1" />}
              <button className="btn-ghost btn-sm">Найти</button>
              <Link href={all === "1" ? `/providers/${slug}` : `/providers/${slug}?all=1`} className="btn-ghost btn-sm">{all === "1" ? "Только включённые" : `Показать все (${provider.models.length})`}</Link>
            </form>
            {visibleModels.length === 0 ? (
              <p className="help">{provider.models.length === 0 ? "Моделей нет. Добавьте ключ и нажмите «Обновить список», либо добавьте модель вручную." : "Ничего не включено. Нажмите «Показать все» и включите нужные."}</p>
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead><tr><th>Модель</th><th>ID в API</th><th>Тип</th><th>Вход</th><th>Выход</th><th>Контекст</th><th></th></tr></thead>
                  <tbody>
                    {visibleModels.slice(0, 300).map((m) => (
                      <tr key={m.id} className={m.isEnabled ? "" : "opacity-60"}>
                        <td className="font-medium">{m.name}</td>
                        <td className="font-mono text-[12px]">{m.modelId}</td>
                        <td className="text-[12px]">{m.capabilities.split(",").map((c) => CAPABILITY_LABELS[c] ?? c).join(", ")}</td>
                        <td>{fmtMoney(m.inputPrice)}</td>
                        <td>{fmtMoney(m.outputPrice)}</td>
                        <td className="text-muted">{m.contextLength ? `${Math.round(m.contextLength / 1000)}k` : "—"}</td>
                        <td className="text-right whitespace-nowrap">
                          {isAdmin && (
                            <span className="inline-flex gap-1">
                              <ActionForm action={toggleModel} className="inline" hidden={{ id: m.id, slug }}>
                                <SubmitButton className={`btn-sm ${m.isEnabled ? "btn-ghost" : "btn-primary"}`} pendingText="…">{m.isEnabled ? "Выключить" : "Включить"}</SubmitButton>
                              </ActionForm>
                              <ActionForm action={deleteModel} className="inline" hidden={{ id: m.id, slug }}>
                                <SubmitButton className="btn-ghost btn-sm" confirm="Удалить модель из каталога?" pendingText="…">✕</SubmitButton>
                              </ActionForm>
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {visibleModels.length > 300 && <p className="help mt-2">Показаны первые 300, уточните поиск.</p>}
              </div>
            )}
            {isAdmin && (
              <details className="mt-4">
                <summary className="btn-ghost cursor-pointer list-none inline-flex">+ Добавить модель вручную</summary>
                <ActionForm action={addModel} className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 rounded-xl border border-line p-3 sm:p-4" hidden={{ providerId: provider.id, slug }}>
                  <Field label="ID модели (как в API)"><input name="modelId" className="input font-mono" required placeholder="gpt-4.1-mini" /></Field>
                  <Field label="Название"><input name="name" className="input" placeholder="GPT-4.1 mini" /></Field>
                  <div>
                    <span className="label">Умеет</span>
                    <div className="flex flex-wrap gap-3 pt-2">
                      {caps.map((c) => <label key={c} className="inline-flex items-center gap-1.5 text-[14px]"><input type="checkbox" name="caps" value={c} defaultChecked={c === "CHAT"} /> {CAPABILITY_LABELS[c]}</label>)}
                    </div>
                  </div>
                  <Field label="Цена входа, $ за 1M"><input name="inputPrice" className="input" inputMode="decimal" /></Field>
                  <Field label="Цена выхода, $ за 1M"><input name="outputPrice" className="input" inputMode="decimal" /></Field>
                  <Field label="Контекст, токенов"><input name="contextLength" className="input" inputMode="numeric" /></Field>
                  <div className="sm:col-span-2 lg:col-span-3"><SubmitButton pendingText="…">Добавить модель</SubmitButton></div>
                </ActionForm>
              </details>
            )}
          </Card>
        )}

        {isAdmin && (
          <Card title="Настройки провайдера">
            <ActionForm action={updateProvider} hidden={{ id: provider.id }}>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Название"><input name="name" className="input" defaultValue={provider.name} /></Field>
                <Field label="Базовый адрес API"><input name="baseUrl" className="input" defaultValue={provider.baseUrl} /></Field>
                <Field label="Эндпоинт списка моделей" hint="Пусто — у провайдера нет такого списка."><input name="modelsEndpoint" className="input" defaultValue={provider.modelsEndpoint ?? ""} /></Field>
                {provider.kind === "LLM" && (
                  <>
                    <Field label="Модель по умолчанию для текста" hint="С ней ключ подключается к сервису одной галочкой.">
                      <select name="defaultChatModel" className="input" defaultValue={provider.defaultChatModel ?? ""}>
                        <option value="">— не задана —</option>
                        {provider.models.filter((m) => m.isEnabled && m.capabilities.includes("CHAT")).map((m) => <option key={m.id} value={m.modelId}>{m.name} · {m.modelId}</option>)}
                      </select>
                    </Field>
                    <Field label="Модель по умолчанию для картинок">
                      <select name="defaultImageModel" className="input" defaultValue={provider.defaultImageModel ?? ""}>
                        <option value="">— не задана —</option>
                        {provider.models.filter((m) => m.isEnabled && m.capabilities.includes("IMAGE")).map((m) => <option key={m.id} value={m.modelId}>{m.name} · {m.modelId}</option>)}
                      </select>
                    </Field>
                  </>
                )}
                <Field label="Документация"><input name="docsUrl" className="input" defaultValue={provider.docsUrl ?? ""} /></Field>
                <Field label="Состояние">
                  <select name="isActive" className="input" defaultValue={provider.isActive ? "1" : "0"}>
                    <option value="1">Активен</option>
                    <option value="0">Скрыт (не предлагается в правилах)</option>
                  </select>
                </Field>
              </div>
              <p className="help">Адаптер: {provider.adapter} · авторизация: {provider.authType}</p>
              <SubmitButton pendingText="…">Сохранить</SubmitButton>
            </ActionForm>
          </Card>
        )}
      </div>
    </>
  );
}
