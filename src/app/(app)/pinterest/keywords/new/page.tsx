import { requireKeywords } from "@/lib/keywords/access";
import { KeywordsScreen } from "@/components/keywords/KeywordsScreen";
import type { SearchParams } from "@/components/ui";

export const dynamic = "force-dynamic";

/** Новые кандидаты (подсказки поиска, генерация) — та же таблица. */
export default async function NewKeywordsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const me = await requireKeywords();
  return <KeywordsScreen tab="new" searchParams={await searchParams} me={me} />;
}
