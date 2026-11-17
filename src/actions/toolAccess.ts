"use server";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { isOwnerEmail, realSession } from "@/lib/auth";
import { isPrivateTool } from "@/lib/permissions";

export type FormState = { error?: string; ok?: string };

/**
 * Выдать или забрать закрытый инструмент (`PRIVATE_TOOLS`). Только владелец портала в своём кабинете:
 * ни другой админ, ни главный админ этого не могут.
 */
export async function setToolAccess(_p: FormState, f: FormData): Promise<FormState> {
  const s = await realSession();
  if (!s || s.actAsUserId || !isOwnerEmail(s.user.email)) return { error: "Доступ к закрытым инструментам выдаёт только владелец" };
  const userId = String(f.get("userId") ?? "");
  const slug = String(f.get("slug") ?? "");
  if (!isPrivateTool(slug)) return { error: "Неизвестный инструмент" };
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, name: true } });
  if (!u) return { error: "Пользователь не найден" };
  const on = f.get("on") === "1";
  const key = { userId_slug: { userId, slug } };
  if (on) await prisma.toolAccess.upsert({ where: key, update: {}, create: { userId, slug, grantedById: s.user.id } });
  else await prisma.toolAccess.deleteMany({ where: { userId, slug } });
  console.log(`[tool-access] ${s.user.email} ${on ? "grant" : "revoke"} ${slug} → ${u.name} (${u.id})`);
  revalidatePath(`/users/${userId}`);
  return { ok: on ? "Доступ выдан" : "Доступ закрыт" };
}
