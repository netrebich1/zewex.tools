import Link from "next/link";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { canViewUsers, describePermissions, parsePermissions } from "@/lib/permissions";
import { Badge, Card, PageHeader } from "@/components/ui";
import { NewUserForm } from "@/components/users/NewUserForm";
import { fmtDate } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function UsersPage() {
  const me = await requireUser();
  if (!canViewUsers(me)) redirect("/?denied=1");
  const isAdmin = me.role === "ADMIN";
  const [users, teams] = await Promise.all([
    prisma.user.findMany({ orderBy: { createdAt: "asc" }, include: { memberships: { include: { team: { select: { name: true } } } }, _count: { select: { apiKeys: true } } } }),
    prisma.team.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }),
  ]);
  const appUrl = process.env.APP_URL ?? "";
  return (
    <>
      <PageHeader title="Пользователи" subtitle={isAdmin ? "Регистрация закрыта. Аккаунт сотруднику создаёте вы: задаёте логин и пароль и передаёте их сами. Права настраиваются на странице сотрудника." : "Список сотрудников портала. Добавлять людей и менять права может только администратор."} />
      <div className={isAdmin ? "grid gap-4 lg:grid-cols-[1fr_380px]" : ""}>
        <div className="space-y-3">
          {users.map((u) => {
            const pending = !u.passwordHash;
            const body = (
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <div className="font-semibold text-[16px]">{u.name} {u.id === me.id && <span className="help">(вы)</span>}</div>
                  <div className="help">{u.email} · с {fmtDate(u.createdAt)}</div>
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    <Badge tone={u.role === "ADMIN" ? "ink" : "neutral"}>{u.role === "ADMIN" ? "админ" : describePermissions(parsePermissions(u.permissions))}</Badge>
                    {!u.isActive && <Badge tone="danger">отключён</Badge>}
                    {pending && <Badge tone="warn">пароль не задан</Badge>}
                    {u.memberships.map((m) => <Badge key={m.teamId} tone="brand">{m.team.name}{m.role === "LEAD" ? " · лидер" : ""}</Badge>)}
                    {u._count.apiKeys > 0 && <Badge>личных ключей: {u._count.apiKeys}</Badge>}
                  </div>
                </div>
                {isAdmin && <span className="btn-ghost btn-sm">Настроить →</span>}
              </div>
            );
            return isAdmin
              ? <Link key={u.id} href={`/users/${u.id}`} className="card block p-4 sm:p-5 hover:border-brand transition">{body}</Link>
              : <Card key={u.id}>{body}</Card>;
          })}
        </div>
        {isAdmin && (
          <Card title="Добавить сотрудника" description="Вы сами задаёте логин и пароль и передаёте их человеку. Писем портал не отправляет.">
            <NewUserForm teams={teams} loginUrl={`${appUrl}/login`} />
          </Card>
        )}
      </div>
    </>
  );
}
