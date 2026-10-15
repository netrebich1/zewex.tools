import { redirect } from "next/navigation";
import { getCurrentUser, requireUser, type CurrentUser } from "@/lib/auth";
import { canUseTool } from "@/lib/permissions";

/** Финансы — закрытый инструмент: роль не важна, нужен выданный доступ (`ToolAccess`) или владелец портала. */
export const FINANCE = "finance";

export async function requireFinance(): Promise<CurrentUser> {
  const me = await requireUser();
  if (!canUseTool(me, FINANCE)) redirect("/?denied=1");
  return me;
}

/** Для API: null — нет доступа (отвечаем 401). */
export async function financeUser(): Promise<CurrentUser | null> {
  const me = await getCurrentUser();
  return me && canUseTool(me, FINANCE) ? me : null;
}
