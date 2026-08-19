import { NextResponse, type NextRequest } from "next/server";
import {
  exchangeStaffCredential,
  STAFF_SESSION_COOKIE,
  staffSessionCookieOptions,
} from "@/lib/auth/staff";
import { consumeRateLimit, requestIp } from "@/lib/auth/rate-limit";
import { createAdminClient } from "@/lib/supabase/admin";

export async function GET(
  request: NextRequest,
  context: RouteContext<"/staff/[staffCode]">,
) {
  const { staffCode } = await context.params;
  try {
    const client = createAdminClient();
    const limit = await consumeRateLimit(
      client,
      "staff_link_exchange",
      requestIp(request.headers),
    );
    if (!limit.allowed) {
      return NextResponse.redirect(
        new URL("/staff?error=limited", request.url),
      );
    }
    const exchange = await exchangeStaffCredential(client, "link", staffCode);
    if (!exchange) {
      return NextResponse.redirect(
        new URL("/staff?error=invalid", request.url),
      );
    }
    const response = NextResponse.redirect(
      new URL("/staff/session", request.url),
    );
    response.cookies.set(
      STAFF_SESSION_COOKIE,
      exchange.token,
      staffSessionCookieOptions,
    );
    response.headers.set("Cache-Control", "private, no-store");
    response.headers.set("Referrer-Policy", "no-referrer");
    return response;
  } catch {
    return NextResponse.redirect(
      new URL("/staff?error=unavailable", request.url),
    );
  }
}
