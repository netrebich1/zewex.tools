import { requireKeywords } from "@/lib/keywords/access";
import { KeywordsScreen } from "@/components/keywords/KeywordsScreen";
import type { SearchParams } from "@/components/ui";

export const dynamic = "force-dynamic";

/** Подбор ключей Pinterest: лист Evergreen и взятые в работу ключи. */
export default async function KeywordsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const me = await requireKeywords();
  return <KeywordsScreen tab="main" searchParams={await searchParams} me={me} />;
}
