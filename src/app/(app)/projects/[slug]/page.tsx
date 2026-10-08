import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { Badge, Card, Empty, Field, PageHeader } from "@/components/ui";
import { ActionForm } from "@/components/ActionForm";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { createSlot, deleteBinding, deleteProject, deleteSlot, updateProject } from "@/actions/admin";
import { BindingForm } from "@/components/BindingForm";
import { RouteCheck } from "@/components/RouteCheck";
import { CAPABILITY_LABELS, SCOPE_LABELS, STATUS_LABELS } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function ProjectPage({ params }: { params: Promise<{ slug: string }> }) {
  const me = await requireUser();
  const { slug } = await params;
  const project = await prisma.project.findUnique({
    where: { slug },
    include: {
      section: true,
      slots: {
        orderBy: { name: "asc" },
        include: { bindings: { include: { provider: true, model: true, apiKey: true, team: true, user: true }, orderBy: { createdAt: "asc" } } },
      },
    },
  });
  if (!project) notFound();
  const isAdmin = me.role === "ADMIN";
  const [sections, providers, teams, users] = await Promise.all([
    prisma.section.findMany({ orderBy: { order: "asc" } }),
    prisma.provider.findMany({
      where: { isActive: true }, orderBy: { order: "asc" },
      include: { models: { where: { isEnabled: true }, orderBy: { name: "asc" } }, apiKeys: { where: { status: "ACTIVE" }, orderBy: { label: "asc" } } },
    }),
    prisma.team.findMany({ orderBy: { name: "asc" } }),
    prisma.user.findMany({ where: { isActive: true }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
  ]);
  const providerOptions = providers.map((p) => ({
    id: p.id, name: p.name, kind: p.kind,
    models: p.models.map((m) => ({ id: m.id, modelId: m.modelId, name: m.name, capabilities: m.capabilities })),
    keys: p.apiKeys.map((k) => ({ id: k.id, label: k.label, secretHint: k.secretHint, ownerId: k.ownerId, status: k.status })),
  }));
  const slotOptions = project.slots.map((s) => ({ id: s.id, name: s.name, capability: s.capability }));
  const scopeOrder = ["USER_PROJECT", "TEAM_PROJECT", "PROJECT"];

  return (
    <>
      <PageHeader
        back={{ href: `/?section=${project.section.slug}`, label: project.section.name }}
        title={project.name}
        subtitle={project.description ?? undefined}
        actions={project.url ? <a href={project.url} target="_blank" rel="noreferrer" className="btn-brand">Открыть инструмент ↗</a> : undefined}
      />

      <div className="space-y-5">
        <Card title="Слоты и правила" description="Слот — что инструменту нужно от внешних сервисов. Правило — какой провайдер, модель и ключ использовать. Побеждает самое частное правило.">
          {project.slots.length === 0 ? (
            <Empty title="Слотов пока нет" hint={isAdmin ? "Добавьте слот ниже, например «Основная генерация текста»." : "Администратор ещё не настроил слоты."} />
          ) : (
            <div className="space-y-4">
              {project.slots.map((slot) => (
                <div key={slot.id} className="rounded-xl border border-line p-3 sm:p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
                    <div>
                      <div className="font-semibold">{slot.name} <code className="ml-1 text-[12px] text-muted bg-ink/5 rounded px-1.5 py-0.5">{slot.key}</code></div>
                      <div className="help">{CAPABILITY_LABELS[slot.capability]}{slot.description ? ` · ${slot.description}` : ""}</div>
                    </div>
                    {isAdmin && (
                      <ActionForm action={deleteSlot} className="inline" hidden={{ id: slot.id, slug: project.slug }}>
                        <SubmitButton className="btn-ghost btn-sm" confirm="Удалить слот и все его правила?" pendingText="…">Удалить слот</SubmitButton>
                      </ActionForm>
                    )}
                  </div>
                  {slot.bindings.length === 0 ? (
                    <p className="help">Правил нет. Будут проверены правила команды и глобальные по типу «{CAPABILITY_LABELS[slot.capability]}».</p>
                  ) : (
                    <div className="table-wrap">
                      <table className="table">
                        <thead><tr><th>Уровень</th><th>Для кого</th><th>Провайдер · модель</th><th>Ключ</th><th></th></tr></thead>
                        <tbody>
                          {[...slot.bindings].sort((a, b) => scopeOrder.indexOf(a.scope) - scopeOrder.indexOf(b.scope)).map((b) => {
                            const canDelete = isAdmin || (b.scope === "USER_PROJECT" && b.userId === me.id);
                            return (
                              <tr key={b.id}>
                                <td><Badge tone={b.scope === "PROJECT" ? "neutral" : b.scope === "TEAM_PROJECT" ? "brand" : "ink"}>{SCOPE_LABELS[b.scope]}</Badge></td>
                                <td>{b.team?.name ?? b.user?.name ?? "все"}</td>
                                <td><b>{b.provider.name}</b>{b.model ? <span className="text-muted"> · {b.model.modelId}</span> : null}</td>
                                <td><Link href={`/keys/${b.apiKey.id}`} className="underline decoration-line hover:decoration-ink">{b.apiKey.label}</Link> <span className="text-muted text-[12px]">{b.apiKey.secretHint}</span>{b.apiKey.status !== "ACTIVE" && <Badge tone="danger">выкл</Badge>}</td>
                                <td className="text-right">
                                  {canDelete && (
                                    <ActionForm action={deleteBinding} className="inline" hidden={{ id: b.id }}>
                                      <SubmitButton className="btn-ghost btn-sm" confirm="Удалить правило?" pendingText="…">✕</SubmitButton>
                                    </ActionForm>
                                  )}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {project.slots.length > 0 && (
            <details className="mt-4 group">
              <summary className="btn-primary cursor-pointer list-none inline-flex">+ Добавить правило</summary>
              <div className="mt-4 rounded-xl border border-line p-3 sm:p-4">
                <BindingForm providers={providerOptions} teams={teams.map((t) => ({ id: t.id, name: t.name }))} users={users} slots={slotOptions} isAdmin={isAdmin} meId={me.id} compact />
              </div>
            </details>
          )}

          {isAdmin && (
            <details className="mt-3">
              <summary className="btn-ghost cursor-pointer list-none inline-flex">+ Добавить слот</summary>
              <ActionForm action={createSlot} className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4 rounded-xl border border-line p-3 sm:p-4" hidden={{ projectId: project.id, slug: project.slug }}>
                <Field label="Название"><input name="name" className="input" required placeholder="Основная генерация текста" /></Field>
                <Field label="Код (латиницей, для кода инструмента)"><input name="key" className="input" placeholder="text_main" /></Field>
                <Field label="Тип">
                  <select name="capability" className="input" defaultValue="CHAT">
                    {Object.entries(CAPABILITY_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                  </select>
                </Field>
                <div className="flex items-end"><SubmitButton pendingText="…">Добавить слот</SubmitButton></div>
                <div className="sm:col-span-2 lg:col-span-4"><Field label="Описание (необязательно)"><input name="description" className="input" placeholder="Где в инструменте это используется" /></Field></div>
              </ActionForm>
            </details>
          )}
        </Card>

        {project.slots.length > 0 && (
          <Card title="Проверка маршрута" description="Покажет, какой ключ и модель получит конкретный человек, и какое правило сработало.">
            <RouteCheck slots={slotOptions} users={isAdmin ? users : users.filter((u) => u.id === me.id)} meId={me.id} />
          </Card>
        )}

        <Card title="Как вызывать из инструмента" description="Инструмент на этом же домене вызывает внутренний прокси, ключи наружу не уходят.">
          <pre className="rounded-xl bg-ink text-white/90 text-[12.5px] p-4 overflow-x-auto">{`POST /api/run
{ "project": "${project.slug}", "slot": "${project.slots[0]?.key ?? "text_main"}",
  "payload": { "messages": [{ "role": "user", "content": "Привет" }] } }`}</pre>
        </Card>

        {isAdmin && (
          <Card title="Настройки инструмента">
            <ActionForm action={updateProject} hidden={{ id: project.id, slug: project.slug }}>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Название"><input name="name" className="input" defaultValue={project.name} required /></Field>
                <Field label="Раздел">
                  <select name="sectionId" className="input" defaultValue={project.sectionId}>
                    {sections.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                </Field>
                <Field label="Статус">
                  <select name="status" className="input" defaultValue={project.status}>
                    {Object.entries(STATUS_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                  </select>
                </Field>
                <Field label="Ссылка на инструмент"><input name="url" className="input" defaultValue={project.url ?? ""} placeholder="https://…" /></Field>
              </div>
              <Field label="Описание"><textarea name="description" className="input" rows={2} defaultValue={project.description ?? ""} /></Field>
              <div className="flex flex-wrap gap-2">
                <SubmitButton pendingText="Сохраняю…">Сохранить</SubmitButton>
              </div>
            </ActionForm>
            <ActionForm action={deleteProject} className="mt-3" hidden={{ id: project.id }}>
              <SubmitButton className="btn-danger btn-sm" confirm="Удалить инструмент вместе со слотами и правилами?" pendingText="…">Удалить инструмент</SubmitButton>
            </ActionForm>
          </Card>
        )}
      </div>
    </>
  );
}
