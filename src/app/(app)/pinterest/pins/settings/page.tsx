import Link from "next/link";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { Card, Field, PageHeader } from "@/components/ui";
import { ActionForm } from "@/components/ActionForm";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { createSite } from "@/actions/pins";

export const dynamic = "force-dynamic";

export default async function PinsSettings() {
  const me = await requireUser();
  const teams = await prisma.team.findMany({ where: me.role === "ADMIN" ? {} : { id: { in: me.teamIds } }, orderBy: { name: "asc" } });

  return (
    <>
      <PageHeader title="Настройки" subtitle="Подключения WordPress для медиатеки, новые сайты. Ключи ИИ подключаются в разделе «Ключи» портала." actions={<><Link href="/keys" className="btn-ghost">Ключи ИИ</Link><Link href="/usage" className="btn-ghost">Расход</Link></>} />
      <div className="space-y-4">
        <Card title="Доступы к сайтам" description="Логины WordPress хранятся в общем разделе портала и назначаются сервисам, чтобы не вводить их заново для каждого инструмента.">
          <Link href="/access" className="btn-primary">Открыть «Доступы к сайтам»</Link>
        </Card>
        <Card title="Новый сайт" description="Сайт получает рецепт по умолчанию, настроить его можно сразу после создания.">
          <ActionForm action={createSite} className="flex flex-wrap items-end gap-3">
            <Field label="Команда"><select name="teamId" className="input">{teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></Field>
            <Field label="Домен сайта"><input name="name" className="input" required placeholder="site.com" /></Field>
            <SubmitButton pendingText="…">Создать сайт</SubmitButton>
          </ActionForm>
        </Card>
      </div>
    </>
  );
}
