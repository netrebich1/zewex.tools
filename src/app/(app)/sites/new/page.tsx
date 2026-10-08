import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { Card, PageHeader } from "@/components/ui";
import { SiteAccessForm } from "@/components/sites/SiteAccessForm";

export const dynamic = "force-dynamic";

export default async function NewSitePage() {
  const me = await requireUser();
  const isAdmin = me.role === "ADMIN";
  const [teams, projects] = await Promise.all([
    prisma.team.findMany({ where: isAdmin ? {} : { id: { in: me.teamIds } }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
    prisma.project.findMany({ orderBy: [{ order: "asc" }, { name: "asc" }], select: { id: true, slug: true, name: true } }),
  ]);
  return (
    <>
      <PageHeader back={{ href: "/sites", label: "Сайты" }} title="Новый сайт" subtitle="Доступ по REST API WordPress хранится в зашифрованном виде и сразу проверяется. Затем сайт можно настроить для сервисов." />
      <Card className="max-w-4xl"><SiteAccessForm teams={teams} projects={projects} /></Card>
    </>
  );
}
