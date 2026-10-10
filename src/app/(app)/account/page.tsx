import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { Badge, Card, Field, PageHeader } from "@/components/ui";
import { ActionForm } from "@/components/ActionForm";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { changePasswordAction, updateProfileAction } from "@/actions/auth";
import { PERMISSION_FIELDS, describePermissions } from "@/lib/permissions";

export const dynamic = "force-dynamic";

export default async function AccountPage() {
  const me = await requireUser();
  const teams = await prisma.team.findMany({ where: { members: { some: { userId: me.id } } }, select: { id: true, name: true } });
  return (
    <>
      <PageHeader title="Аккаунт" subtitle={me.email} />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Профиль">
          <div className="mb-3 flex flex-wrap gap-1.5">
            <Badge tone={me.role === "ADMIN" ? "ink" : "neutral"}>{me.role === "ADMIN" ? "админ" : describePermissions(me.perms)}</Badge>
            {teams.map((t) => <Badge key={t.id} tone="brand">{t.name}{me.leadTeamIds.includes(t.id) ? " · лидер" : ""}</Badge>)}
          </div>
          {me.role !== "ADMIN" && (
            <details className="mb-3">
              <summary className="text-[13px] text-muted cursor-pointer hover:text-ink">Мои права</summary>
              <dl className="mt-2 space-y-1 text-[13px]">
                {PERMISSION_FIELDS.map((f) => <div key={f.key} className="flex justify-between gap-3"><dt className="text-muted">{f.label}</dt><dd>{f.options.find((o) => o.value === me.perms[f.key])?.label ?? "—"}</dd></div>)}
              </dl>
            </details>
          )}
          <ActionForm action={updateProfileAction}>
            <Field label="Имя"><input name="name" className="input" defaultValue={me.name} required /></Field>
            <SubmitButton pendingText="…">Сохранить</SubmitButton>
          </ActionForm>
        </Card>
        <Card title="Сменить пароль">
          <ActionForm action={changePasswordAction}>
            <Field label="Текущий пароль"><input name="current" type="password" className="input" autoComplete="current-password" required /></Field>
            <Field label="Новый пароль"><input name="next" type="password" className="input" autoComplete="new-password" minLength={8} required /></Field>
            <SubmitButton pendingText="…">Обновить пароль</SubmitButton>
          </ActionForm>
        </Card>
      </div>
    </>
  );
}
