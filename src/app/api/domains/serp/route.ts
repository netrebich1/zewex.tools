import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { analyzeSerp } from "@/lib/domains/serp";
import { getCountry, isGeoSuffix, LIMITS } from "@/lib/domains/types";
import { parseList } from "@/lib/domains/generator";
import { hit, tooMany } from "@/lib/ratelimit";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * POST /api/domains/serp { brands: string, countryCode, keyword? }
 * Google TOP-10 по брендам (DataForSEO → SerpAPI), фильтр по бренду, приставки конкурентов.
 */
export async function POST(req: Request) {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
  let body: { brands?: string; countryCode?: string; keyword?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Тело запроса должно быть JSON" }, { status: 400 });
  }
  const brands = parseList(String(body.brands ?? "")).slice(0, LIMITS.brands);
  const countryCode = String(body.countryCode ?? "").trim().toLowerCase();
  if (!brands.length) return NextResponse.json({ error: "Сначала добавьте бренды" }, { status: 400 });
  if (!getCountry(countryCode)) return NextResponse.json({ error: "Выберите страну" }, { status: 400 });
  const retry = hit(`domains-serp:${me.id}`, 20, 600);
  if (retry) return NextResponse.json({ error: tooMany(retry) }, { status: 429 });

  const r = await analyzeSerp({ userId: me.id, teamId: me.teamIds[0] ?? null }, { brands, countryCode, keyword: String(body.keyword ?? "") });
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: 502 });
  const suffixes = r.value.suffixes.map((s) => { const geo = isGeoSuffix(s.suffix, countryCode); return { ...s, geo, tier: geo ? 1 : 2 }; });
  return NextResponse.json({
    snapshot: r.value.snapshot,
    suffixes,
    failed: r.value.failed,
    allDomains: r.value.allDomains,
    queries: brands.length > LIMITS.serpQueries && !body.keyword ? `Выдача снята по первым ${LIMITS.serpQueries} брендам` : null,
  }, { headers: { "Cache-Control": "no-store" } });
}
