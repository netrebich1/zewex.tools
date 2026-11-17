import { redirect } from "next/navigation";

/** Старый адрес раздела «Рецепты» (переименован в «Сценарии»): переадресация на /pinterest/blog/scenarios. */
export default async function OldRecipesRedirect({ params, searchParams }: { params: Promise<{ rest?: string[] }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { rest } = await params;
  const sp = await searchParams;
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) for (const x of Array.isArray(v) ? v : v != null ? [v] : []) q.append(k, x);
  redirect(`/pinterest/blog/scenarios${rest?.length ? `/${rest.map(encodeURIComponent).join("/")}` : ""}${q.size ? `?${q}` : ""}`);
}
