import { requireUser } from "@/lib/auth";
import { accessFormData } from "@/lib/sites/form";
import { Card, PageHeader } from "@/components/ui";
import { SiteAccessForm } from "@/components/sites/SiteAccessForm";

export const dynamic = "force-dynamic";

export default async function NewSitePage() {
  const me = await requireUser();
  const { teams, projects, members } = await accessFormData(me);
  return (
    <>
      <PageHeader back={{ href: "/sites", label: "Сайты" }} title="Новый сайт" subtitle="Доступ по REST API WordPress хранится в зашифрованном виде и сразу проверяется. Затем сайт включается в нужных сервисах." />
      <Card className="max-w-5xl"><SiteAccessForm teams={teams} projects={projects} members={members} /></Card>
    </>
  );
}
