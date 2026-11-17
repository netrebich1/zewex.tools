import { NextResponse, type NextRequest } from "next/server";
import { PATH_HEADER } from "@/lib/requestPath";

const PUBLIC = ["/login", "/register", "/icon.svg", "/logout"];

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const headers = new Headers(req.headers);
  headers.set(PATH_HEADER, pathname);
  const next = () => NextResponse.next({ request: { headers } });
  if (PUBLIC.some((p) => pathname === p || pathname.startsWith(p + "/")) || pathname.startsWith("/_next") || pathname.startsWith("/api")) {
    return next();
  }
  if (!req.cookies.get("zx_session")?.value) {
    const base = process.env.APP_URL || req.nextUrl.origin;
    return NextResponse.redirect(new URL("/login", base));
  }
  return next();
}

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
