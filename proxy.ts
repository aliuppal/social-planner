import { NextResponse, type NextRequest } from "next/server";
import { getSessionCookie } from "better-auth/cookies";

/**
 * Optimistic check only: no session cookie → send to /login.
 * Every page and action still validates the session on the server (lib/auth/session.ts).
 */
export function proxy(request: NextRequest) {
  if (!getSessionCookie(request)) {
    const url = new URL("/login", request.url);
    url.searchParams.set("next", request.nextUrl.pathname + request.nextUrl.search);
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/dashboard/:path*", "/settings/:path*", "/calendar/:path*", "/board/:path*", "/approvals/:path*", "/brands/:path*", "/posts/:path*", "/insights/:path*"],
};
