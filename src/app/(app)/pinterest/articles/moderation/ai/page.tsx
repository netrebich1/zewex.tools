import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { PageHeader } from "@/components/ui";
import { aiRunsOverview } from "@/lib/articles/aiModeration";
import { AiModerationPanel } from "@/components/articles/AiModerationPanel";

export const dynamic = "force-dynamic";

/**
 * ИИ-модерация фото (оригинал: src/pages/AiModerationPage.tsx): запуск по сайту, запуски, решения с фильтрами и массовыми
 * действиями, диалог «итог / удалено / добавлено», вкладка «Мало фото». Данные — /api/articles/ai, обновляются сами.
 */
export default async function AiModerationPage() {
  const me = await requireUser();
  const initial = await aiRunsOverview(me);
  return (
    <>
      <PageHeader
        back={{ href: "/pinterest/articles", label: "Статьи" }}
        title="ИИ-модерация фото"
        subtitle="ИИ проверяет подобранные фото вместо сотрудника: тема и подлинность (дешёвая модель) + мнение редактора (средняя), спорные кадры — второй взгляд. «Тест» только предлагает, «Авто» применяет уверенные решения (≥75), сомнительные отдаёт людям."
        actions={
          <>
            <Link href="/pinterest/articles/moderation/photos" className="btn-ghost">Модерация фото</Link>
            <Link href="/pinterest/articles/automation" className="btn-ghost">Автозапуск</Link>
          </>
        }
      />
      <AiModerationPanel initial={initial} />
    </>
  );
}
