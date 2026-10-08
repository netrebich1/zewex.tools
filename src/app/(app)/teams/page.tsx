import Link from "next/link";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { Card, Empty, Field, PageHeader } from "@/components/ui";
import { ActionForm } from "@/components/ActionForm";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { createTeam } from "@/actions/admin";

export const dynamic = "force-dynamic";

export default async function TeamsPage() {
  const me = await requireUser();
  const teams = await prisma.team.findMany({ orderBy: { name: "asc" }, include: { members: { include: { user: { select: { name: true } } } }, _count: { select: { bindings: true } } } });
  return (
    <>
      <PageHeader title="Команды" subtitle="Команда — группа людей, для которой можно задать свои ключи и модели. Один человек может быть в нескольких командах." />
      {teams.length === 0 ? <Empty title="Команд пока нет" hint="Например: «Моя команда» и «Команда партнёра»." /> : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {teams.map((t) => (
            <Link key={t.id} href={`/teams/${t.slug}`} className="card p-4 hover:border-brand transition">
              <h3 className="font-semibold text-[16px]">{t.name}</h3>
              {t.description && <p className="help mt-1 line-clamp-2">{t.description}</p>}
              <p className="mt-3 text-[13px] text-muted">{t.members.length ? t.members.map((m) => m.user.name).join(", ") : "без участников"}</p>
              <p className="text-[13px] text-muted">Правил: {t._count.bindings}</p>
            </Link>
          ))}
        </div>
      )}
      {me.role === "ADMIN" && (
        <Card className="mt-6 max-w-xl" title="Новая команда">
          <ActionForm action={createTeam}>
            <Field label="Название"><input name="name" className="input" required placeholder="Команда партнёра" /></Field>
            <Field label="Описание"><input name="description" className="input" placeholder="Кто и зачем" /></Field>
            <SubmitButton pendingText="…">Создать команду</SubmitButton>
          </ActionForm>
        </Card>
      )}
    </>
  );
}
