import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { analyzeSerp } from "@/lib/domains/serp";
import { isGeoSuffix, LIMITS } from "@/lib/domains/types";
import { parseBrandLines } from "@/lib/domains/generator";
import { domainsKeyTeamId } from "@/lib/domains/keyTeam";
import { hit, tooMany } from "@/lib/ratelimit";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * POST /api/domains/serp { brands: string (строки «бренд ; FR»), keyword? }
 * Google TOP-10 по брендам в их странах (DataForSEO → SerpAPI), фильтр по бренду, приставки конкурентов.
 */
export async function POST(req: Request) {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
  let body: { brands?: string; keyword?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Тело запроса должно быть JSON" }, { status: 400 });
  }
  const items = parseBrandLines(String(body.brands ?? "")).items.slice(0, LIMITS.brands);
  if (!items.length) return NextResponse.json({ error: "Сначала добавьте бренды в формате «бренд ; FR»" }, { status: 400 });
  const countries = Array.from(new Set(items.map((it) => it.country)));
  const retry = hit(`domains-serp:${me.id}`, 20, 600);
  if (retry) return NextResponse.json({ error: tooMany(retry) }, { status: 429 });

  const r = await analyzeSerp({ userId: me.id, teamId: await domainsKeyTeamId() }, { items, keyword: String(body.keyword ?? "") });
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: 502 });
  const suffixes = r.value.suffixes.map((s) => { const geo = countries.some((c) => isGeoSuffix(s.suffix, c)); return { ...s, geo, tier: geo ? 1 : 2 }; });
  return NextResponse.json({
    snapshot: r.value.snapshot,
    suffixes,
    failed: r.value.failed,
    allDomains: r.value.allDomains,
    queries: r.value.truncated ? `Выдача снята по первым ${LIMITS.serpQueries} брендам` : null,
  }, { headers: { "Cache-Control": "no-store" } });
}
