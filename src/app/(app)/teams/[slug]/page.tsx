import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { canManageTeam, requireUser } from "@/lib/auth";
import { Badge, Card, Field, PageHeader } from "@/components/ui";
import { ActionForm } from "@/components/ActionForm";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { addTeamMember, deleteBinding, deleteTeam, removeTeamMember, updateTeam } from "@/actions/admin";
import { BindingForm } from "@/components/BindingForm";
import { CAPABILITY_LABELS, SCOPE_LABELS } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function TeamPage({ params }: { params: Promise<{ slug: string }> }) {
  const me = await requireUser();
  const { slug } = await params;
  const team = await prisma.team.findUnique({
    where: { slug },
    include: {
      members: { include: { user: { select: { id: true, name: true, email: true } } }, orderBy: { createdAt: "asc" } },
      bindings: { include: { provider: true, model: true, apiKey: true, slot: { include: { project: true } } }, orderBy: { createdAt: "asc" } },
    },
  });
  if (!team) notFound();
  const isAdmin = me.role === "ADMIN";
  const canManage = canManageTeam(me, team.id);
  const [users, providers] = await Promise.all([
    prisma.user.findMany({ where: { isActive: true }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
    prisma.provider.findMany({ where: { isActive: true }, orderBy: { order: "asc" }, include: { models: { where: { isEnabled: true }, orderBy: { name: "asc" } }, apiKeys: { where: { status: "ACTIVE" }, orderBy: { label: "asc" } } } }),
  ]);
  const memberIds = new Set(team.members.map((m) => m.userId));
  const providerOptions = providers.map((p) => ({
    id: p.id, name: p.name, kind: p.kind,
    models: p.models.map((m) => ({ id: m.id, modelId: m.modelId, name: m.name, capabilities: m.capabilities })),
    keys: p.apiKeys.map((k) => ({ id: k.id, label: k.label, secretHint: k.secretHint, ownerId: k.ownerId, status: k.status })),
  }));

  return (
    <>
      <PageHeader back={{ href: "/teams", label: "Команды" }} title={team.name} subtitle={team.description ?? undefined} />
      <div className="space-y-4">
        <Card title="Участники">
          {team.members.length === 0 ? <p className="help">Пока никого.</p> : (
            <ul className="divide-y divide-line">
              {team.members.map((m) => (
                <li key={m.userId} className="flex items-center justify-between gap-3 py-2">
                  <div><span className="font-medium">{m.user.name}</span> <span className="help">{m.user.email}</span> {m.role === "LEAD" && <Badge tone="brand">лидер</Badge>}</div>
                  {isAdmin && (
                    <ActionForm action={removeTeamMember} className="inline" hidden={{ teamId: team.id, userId: m.userId, slug }}>
                      <SubmitButton className="btn-ghost btn-sm" pendingText="…">Убрать</SubmitButton>
                    </ActionForm>
                  )}
                </li>
              ))}
            </ul>
          )}
          {isAdmin && users.some((u) => !memberIds.has(u.id)) && (
            <ActionForm action={addTeamMember} className="mt-3 flex flex-wrap items-end gap-2 border-t border-line pt-3" hidden={{ teamId: team.id, slug }}>
              <div className="flex-1 min-w-[180px]"><Field label="Добавить участника">
                <select name="userId" className="input">{users.filter((u) => !memberIds.has(u.id)).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select>
              </Field></div>
              <div className="w-36"><Field label="Роль"><select name="role" className="input"><option value="MEMBER">участник</option><option value="LEAD">лидер</option></select></Field></div>
              <SubmitButton className="btn-primary btn-sm" pendingText="…">Добавить</SubmitButton>
            </ActionForm>
          )}
        </Card>

        <Card title="Правила команды" description="Правила уровня «команда + проект» и «команда по типу слота». Они перекрывают настройки инструмента по умолчанию для участников этой команды.">
          {team.bindings.length === 0 ? <p className="help">Правил нет: участники используют настройки инструментов по умолчанию.</p> : (
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Уровень</th><th>Где</th><th>Провайдер · модель</th><th>Ключ</th><th></th></tr></thead>
                <tbody>
                  {team.bindings.map((b) => (
                    <tr key={b.id}>
                      <td><Badge>{SCOPE_LABELS[b.scope]}</Badge></td>
                      <td>{b.slot ? <><Link href={`/projects/${b.slot.project.slug}`} className="font-medium hover:underline">{b.slot.project.name}</Link><span className="text-muted"> · {b.slot.name}</span></> : <span>все слоты типа «{CAPABILITY_LABELS[b.capability ?? ""]}»</span>}</td>
                      <td><b>{b.provider.name}</b>{b.model ? <span className="text-muted"> · {b.model.modelId}</span> : null}</td>
                      <td><Link href={`/keys/${b.apiKey.id}`} className="underline decoration-line">{b.apiKey.label}</Link></td>
                      <td className="text-right">{canManage && <ActionForm action={deleteBinding} className="inline" hidden={{ id: b.id }}><SubmitButton className="btn-ghost btn-sm" confirm="Удалить правило?" pendingText="…">✕</SubmitButton></ActionForm>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {canManage && (
            <details className="mt-4">
              <summary className="btn-primary cursor-pointer list-none inline-flex">+ Правило команды по типу слота</summary>
              <div className="mt-3 rounded-xl border border-line p-3 sm:p-4">
                <p className="help mb-3">Для правила «команда + конкретный инструмент» откройте страницу инструмента.{!isAdmin && " Вы лидер этой команды и можете задавать её правила."}</p>
                <BindingForm providers={providerOptions} teams={[{ id: team.id, name: team.name }]} users={users} slots={[]} isAdmin={isAdmin} meId={me.id} leadTeamIds={me.leadTeamIds} fixedScope="TEAM" fixedTeamId={team.id} compact />
              </div>
            </details>
          )}
        </Card>

        {isAdmin && (
          <Card title="Настройки команды">
            <ActionForm action={updateTeam} hidden={{ id: team.id }}>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Название"><input name="name" className="input" defaultValue={team.name} /></Field>
                <Field label="Описание"><input name="description" className="input" defaultValue={team.description ?? ""} /></Field>
              </div>
              <SubmitButton pendingText="…">Сохранить</SubmitButton>
            </ActionForm>
            <ActionForm action={deleteTeam} className="mt-3" hidden={{ id: team.id }}>
              <SubmitButton className="btn-danger btn-sm" confirm="Удалить команду и её правила?" pendingText="…">Удалить команду</SubmitButton>
            </ActionForm>
          </Card>
        )}
      </div>
    </>
  );
}
