import { NextRequest, NextResponse } from 'next/server';

// Assigns a per-browser session_id cookie on first visit. Several routes
// (chat sandbox tools, MCP token/tool caching) key state off this cookie
// but nothing was ever setting it — every visitor fell back to the same
// literal string 'anonymous', so all of them shared one sandbox container
// and one MCP token cache instead of getting their own.
const SESSION_COOKIE = 'session_id';
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

export function middleware(request: NextRequest) {
  if (request.cookies.get(SESSION_COOKIE)) {
    return NextResponse.next();
  }

  const response = NextResponse.next();
  response.cookies.set(SESSION_COOKIE, crypto.randomUUID(), {
    httpOnly: true,
    sameSite: 'lax',
    secure: request.nextUrl.protocol === 'https:',
    maxAge: SESSION_MAX_AGE_SECONDS,
    path: '/',
  });
  return response;
}

export const config = {
  matcher: '/((?!_next/static|_next/image|favicon.ico).*)',
};
