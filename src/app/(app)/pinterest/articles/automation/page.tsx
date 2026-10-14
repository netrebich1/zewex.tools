import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { PageHeader } from "@/components/ui";
import { automationPayload } from "@/lib/articles/automation";
import { AutomationTable } from "@/components/articles/AutomationTable";

export const dynamic = "force-dynamic";

/** Автозапуск сайтов: счётчики по шагам, переключатели и лимиты цепочек по сайтам, мастер-выключатели, диагностика. */
export default async function ArticlesAutomationPage() {
  const me = await requireUser();
  const payload = await automationPayload(me);
  return (
    <>
      <PageHeader
        title="Автозапуск сайтов"
        subtitle="Путь статьи: поиск фото → ручная проверка фото → написание → публикация. Обновляется каждые 30 секунд."
        actions={
          <>
            <Link href="/pinterest/articles/sites" className="btn-ghost">Настройки сайтов</Link>
            <Link href="/pinterest/articles/runs/new" className="btn-brand">Новый запуск</Link>
          </>
        }
      />
      <AutomationTable initial={payload} />
    </>
  );
}
