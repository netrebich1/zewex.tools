import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { analyticsUser } from "@/lib/analytics/access";
import { newState, oauthConfig, oauthStartUrl } from "@/lib/analytics/google";

export const dynamic = "force-dynamic";

/** GET /api/analytics/oauth/start → страница согласия Google (analytics.readonly). state живёт в cookie 10 минут. */
export async function GET() {
  const me = await analyticsUser();
  if (!me) return new Response("Нет доступа", { status: 401 });
  if (!oauthConfig()) return NextResponse.redirect(new URL("/analytics/settings?error=oauth", process.env.APP_URL || "https://zewex.tools"));
  const state = newState();
  const jar = await cookies();
  jar.set("zx_ga_state", state, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/api/analytics/oauth", maxAge: 600 });
  return NextResponse.redirect(oauthStartUrl(state));
}
