import { NextResponse, type NextRequest } from "next/server";

const PUBLIC = ["/login", "/register", "/invite", "/icon.svg", "/logout"];

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (PUBLIC.some((p) => pathname === p || pathname.startsWith(p + "/")) || pathname.startsWith("/_next") || pathname.startsWith("/api")) {
    return NextResponse.next();
  }
  if (!req.cookies.get("zx_session")?.value) {
    const base = process.env.APP_URL || req.nextUrl.origin;
    return NextResponse.redirect(new URL("/login", base));
  }
  return NextResponse.next();
}

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
