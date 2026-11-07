/**
 * Все API инструмента «Подбор доменов» (DataForSEO, SerpAPI, ИИ) идут только ключами команды WexOra —
 * решение владельца 2026-10-23. Кто бы ни запускал подбор, ключ выбирается по правилам WexOra, расход пишется на WexOra.
 * Если у слота нет ключа WexOra, вызов отказывает, а не берёт ключ другой команды или общий.
 */
import { prisma } from "@/lib/db";
import { resolveSlot, type ResolveSlotResult } from "@/lib/run";
import { PROJECT_SLUG } from "./types";

export const KEY_TEAM_NAME = "WexOra";

let cached: string | null = null;

/** id команды WexOra (по названию, без учёта регистра). */
export async function domainsKeyTeamId(): Promise<string> {
  if (cached) return cached;
  const team = await prisma.team.findFirst({ where: { name: KEY_TEAM_NAME }, select: { id: true } });
  if (!team) throw new Error(`Команда ${KEY_TEAM_NAME} не найдена — ключи «Подбора доменов» берутся только от неё`);
  cached = team.id;
  return team.id;
}

/** Правило слота «Подбора доменов» строго с ключом WexOra. */
export async function resolveDomainsSlot(userId: string, slotKey: string): Promise<ResolveSlotResult> {
  const teamId = await domainsKeyTeamId();
  const r = await resolveSlot(userId, PROJECT_SLUG, slotKey, teamId);
  if (!r.ok) return { ...r, error: `${r.error} Ключи «Подбора доменов» берутся только от команды ${KEY_TEAM_NAME}.` };
  const key = await prisma.apiKey.findUnique({ where: { id: r.value.binding.apiKey.id }, select: { teamId: true } });
  if (key?.teamId !== teamId) {
    return { ok: false, status: 409, error: `Для «${r.value.slot.name}» нет ключа команды ${KEY_TEAM_NAME}: подключите ключ ${KEY_TEAM_NAME} к «Подбору доменов» на странице ключа.` };
  }
  return r;
}
