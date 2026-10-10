import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { assignScope, canAssignGlobal, canCreateKey, canCreatePersonalKey, canCreateSharedKey, keyTeamScope } from "@/lib/permissions";
import { Card, Field, PageHeader, sp, type SearchParams } from "@/components/ui";
import { ActionForm } from "@/components/ActionForm";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { createKey } from "@/actions/admin";
import { KeySecretFields } from "@/components/KeySecretFields";
import { KeyOwnerFields, type KeyOwnerOption } from "@/components/KeyOwnerFields";

export const dynamic = "force-dynamic";

export default async function NewKeyPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const me = await requireUser();
  if (!canCreateKey(me)) redirect("/keys?denied=1");
  const params = await searchParams;
  const providers = await prisma.provider.findMany({ where: { isActive: true }, orderBy: { order: "asc" } });
  const keyTeams = keyTeamScope(me);
  const assignTeams = assignScope(me);
  const [projects, teams] = await Promise.all([
    prisma.project.findMany({ orderBy: [{ order: "asc" }, { name: "asc" }], select: { id: true, name: true, _count: { select: { slots: true } } } }),
    prisma.team.findMany({
      where: keyTeams === "all" && assignTeams === "all" ? {} : { id: { in: [...(keyTeams === "all" ? [] : keyTeams), ...(assignTeams === "all" ? [] : assignTeams)] } },
      orderBy: { name: "asc" }, select: { id: true, name: true },
    }),
  ]);
  const owners: KeyOwnerOption[] = [];
  if (canCreateSharedKey(me)) owners.push({ value: "shared", label: "Общий: всем по правилам" });
  for (const t of teams) if (keyTeams === "all" || keyTeams.includes(t.id)) owners.push({ value: `team:${t.id}`, label: `Команда «${t.name}»` });
  if (canCreatePersonalKey(me)) owners.push({ value: "personal", label: "Личный: только мне" });
  const wantTeam = sp(params, "team");
  const defaultOwner = owners.find((o) => wantTeam && o.value === `team:${wantTeam}`)?.value ?? owners[0]?.value ?? "personal";
  const assignable = teams.filter((t) => assignTeams === "all" || assignTeams.includes(t.id));

  return (
    <>
      <PageHeader back={{ href: "/keys", label: "Ключи" }} title="Новый ключ" subtitle="Ключ хранится в зашифрованном виде, в интерфейсе виден только его хвост. После сохранения он сразу проверяется." />
      <Card className="max-w-2xl">
        <ActionForm action={createKey}>
          <KeySecretFields providers={providers.map((p) => ({ id: p.id, name: p.name, authType: p.authType }))} />
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Месячный лимит, $ (необязательно)" hint="При достижении вызовы через этот ключ блокируются до конца месяца."><input name="monthlyLimitUsd" className="input" inputMode="decimal" placeholder="например 50" /></Field>
            <KeyOwnerFields
              owners={owners}
              defaultOwner={defaultOwner}
              projects={projects.map((p) => ({ id: p.id, name: p.name, hint: `слотов: ${p._count.slots}` }))}
              teams={assignable}
              global={canAssignGlobal(me)}
            />
          </div>
          <Field label="Заметка"><input name="notes" className="input" placeholder="Чей аккаунт, где пополнять…" /></Field>
          <SubmitButton className="btn-brand" pendingText="Сохраняю и проверяю…">Сохранить ключ</SubmitButton>
        </ActionForm>
      </Card>
    </>
  );
}
