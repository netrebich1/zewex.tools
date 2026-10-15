import { ArticlesNav } from "@/components/articles/ArticlesNav";
import { getCurrentUser } from "@/lib/auth";
import { moderationCounts } from "@/lib/articles/queries";

export default async function ArticlesLayout({ children }: { children: React.ReactNode }) {
  // Счётчики модерации в меню (дальше меню обновляет их само через /api/articles/moderation?counts=1).
  const me = await getCurrentUser();
  const counts = me ? await moderationCounts(me).catch(() => null) : null;
  return (
    <div>
      <ArticlesNav counts={counts} />
      {children}
    </div>
  );
}
