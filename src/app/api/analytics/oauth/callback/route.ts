import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { encryptSecret } from "@/lib/crypto";
import { analyticsUser } from "@/lib/analytics/access";
import { exchangeCode } from "@/lib/analytics/google";
import { refreshAccountProperties } from "@/lib/analytics/sync";

export const dynamic = "force-dynamic";

/** GET /api/analytics/oauth/callback?code&state → сохранить refresh token, подтянуть список свойств, вернуться в настройки. */
export async function GET(req: Request) {
  const base = process.env.APP_URL || "https://zewex.tools";
  const back = (q: Record<string, string>) => NextResponse.redirect(new URL(`/analytics/settings?${new URLSearchParams(q)}`, base));
  const me = await analyticsUser();
  if (!me) return NextResponse.redirect(new URL("/login", base));
  const url = new URL(req.url);
  const jar = await cookies();
  const expected = jar.get("zx_ga_state")?.value;
  jar.delete("zx_ga_state");
  if (url.searchParams.get("error")) return back({ error: `Google: ${url.searchParams.get("error")}` });
  const code = url.searchParams.get("code");
  if (!code || !expected || url.searchParams.get("state") !== expected) return back({ error: "Подключение не подтверждено (истекло время или открыто в другом браузере). Попробуйте ещё раз." });
  try {
    const t = await exchangeCode(code);
    if (!t.email) return back({ error: "Google не сообщил почту аккаунта. Попробуйте ещё раз." });
    const existing = await prisma.gaAccount.findFirst({ where: { email: t.email, kind: "oauth", userId: me.id }, select: { id: true } });
    const data = { refreshTokenEnc: encryptSecret(t.refreshToken), accessTokenEnc: encryptSecret(t.accessToken), accessExpires: new Date(Date.now() + (t.expiresIn - 60) * 1000), status: "OK", lastError: null };
    const acc = existing ? await prisma.gaAccount.update({ where: { id: existing.id }, data }) : await prisma.gaAccount.create({ data: { userId: me.id, kind: "oauth", email: t.email, ...data } });
    const r = await refreshAccountProperties(acc.id).catch((e) => ({ added: 0, total: -1, error: e instanceof Error ? e.message : String(e) }));
    if ("error" in r) return back({ ok: `Аккаунт ${t.email} подключён`, error: `Список сайтов не загрузился: ${r.error}` });
    return back({ ok: `Аккаунт ${t.email} подключён, сайтов: ${r.total}`, account: acc.id });
  } catch (e) {
    return back({ error: e instanceof Error ? e.message : String(e) });
  }
}
