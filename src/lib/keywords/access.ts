import { redirect } from "next/navigation";
import { getCurrentUser, requireUser, type CurrentUser } from "@/lib/auth";
import { canUseTool } from "@/lib/permissions";
import { KEYWORDS } from "./types";

/** Подбор ключей: обычный инструмент (`Permissions.tools`), данные общие для всех, кому он открыт. */
export async function requireKeywords(): Promise<CurrentUser> {
  const me = await requireUser();
  if (!canUseTool(me, KEYWORDS)) redirect("/?denied=1");
  return me;
}

export async function keywordsUser(): Promise<CurrentUser | null> {
  const me = await getCurrentUser();
  return me && canUseTool(me, KEYWORDS) ? me : null;
}
