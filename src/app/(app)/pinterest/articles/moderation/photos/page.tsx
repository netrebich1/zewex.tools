import { redirect } from "next/navigation";
import { type SearchParams, sp } from "@/components/ui";

export const dynamic = "force-dynamic";

/** Модерация фото переехала на общую страницу «Модерация» (вкладки «Фото от ИИ» / «Фото без ИИ» / «Мало фото»). Старые ссылки ведут туда. */
export default async function PhotoModerationRedirect({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const u = new URLSearchParams();
  const g = sp(params, "group");
  if (g === "ai" || g === "new" || g === "low") u.set("tab", g);
  for (const k of ["site", "article"] as const) {
    const v = sp(params, k);
    if (v) u.set(k, v);
  }
  const s = u.toString();
  redirect(`/pinterest/articles/moderation/articles${s ? `?${s}` : ""}`);
}
