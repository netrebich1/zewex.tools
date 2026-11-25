import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { researchBrand, type BrandResearch } from "@/lib/domains/research";
import { domainsKeyTeamId } from "@/lib/domains/keyTeam";
import { getCountry, LIMITS } from "@/lib/domains/types";
import { hit, tooMany } from "@/lib/ratelimit";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * POST /api/domains/research { items: [{ brand, country }], useAi? } → ключевые слова и модификаторы каждого бренда.
 * Клиент шлёт бренды пачками по LIMITS.researchChunk, чтобы видеть прогресс и не упираться в таймаут.
 */
export async function POST(req: Request) {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
  let body: { items?: Array<{ brand?: string; country?: string }>; useAi?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Тело запроса должно быть JSON" }, { status: 400 });
  }
  const items = (Array.isArray(body.items) ? body.items : [])
    .map((x) => ({ brand: String(x?.brand ?? "").trim(), country: String(x?.country ?? "").trim().toLowerCase() }))
    .filter((x) => x.brand && getCountry(x.country))
    .slice(0, LIMITS.researchChunk);
  if (!items.length) return NextResponse.json({ error: "Нет брендов с понятной страной" }, { status: 400 });
  const retry = hit(`domains-research:${me.id}`, 200, 600);
  if (retry) return NextResponse.json({ error: tooMany(retry) }, { status: 429 });

  // Ключи и расход — только команды WexOra (keyTeam.ts)
  const ctx = { userId: me.id, teamId: await domainsKeyTeamId() };
  const results: BrandResearch[] = await Promise.all(
    items.map((it) =>
      researchBrand(ctx, it.brand, it.country, { useAi: body.useAi !== false }).catch((e) => ({
        brand: it.brand, country: it.country, modifiers: [], queries: 0, competitorDomains: [], tlds: [], costUsd: 0,
        errors: [e instanceof Error ? e.message : String(e)],
      })),
    ),
  );
  return NextResponse.json({ results }, { headers: { "Cache-Control": "no-store" } });
}
