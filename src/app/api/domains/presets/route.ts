import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { countryByCode } from "@/lib/domains/countries";
import { defaultCountryPreset } from "@/lib/domains/presets";

export const dynamic = "force-dynamic";

/**
 * Наборы стран подбора доменов (общие для портала).
 * Гео-приставки всегда из встроенной базы (geo.ts); сохраняются только доп. зоны страны.
 * POST { country, preset: { tlds } } — сохранить; DELETE ?country=xx — убрать доп. зоны.
 */
export async function POST(req: Request) {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
  let body: { country?: string; preset?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Тело запроса должно быть JSON" }, { status: 400 });
  }
  const code = String(body.country ?? "").trim().toLowerCase();
  if (!countryByCode(code)) return NextResponse.json({ error: "Неизвестная страна" }, { status: 400 });
  const preset = defaultCountryPreset(code, (body.preset as { tlds?: unknown } | undefined)?.tlds);
  await prisma.domainCountryPreset.upsert({
    where: { countryCode: code },
    update: { tiers: preset.tiers as unknown as Prisma.InputJsonValue, tlds: preset.tlds, updatedById: me.id },
    create: { countryCode: code, tiers: preset.tiers as unknown as Prisma.InputJsonValue, tlds: preset.tlds, updatedById: me.id },
  });
  return NextResponse.json({ ok: true, preset });
}

export async function DELETE(req: Request) {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
  const code = (new URL(req.url).searchParams.get("country") ?? "").trim().toLowerCase();
  if (!countryByCode(code)) return NextResponse.json({ error: "Неизвестная страна" }, { status: 400 });
  await prisma.domainCountryPreset.deleteMany({ where: { countryCode: code } });
  return NextResponse.json({ ok: true, preset: defaultCountryPreset(code) });
}
