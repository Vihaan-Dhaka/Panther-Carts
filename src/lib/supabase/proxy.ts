import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

export async function updateSupabaseSession(request: NextRequest) {
  let response = NextResponse.next({ request });
  const client = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll(cookiesToSet, cacheHeaders) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value),
          );
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options),
          );
          Object.entries(cacheHeaders).forEach(([name, value]) =>
            response.headers.set(name, value),
          );
        },
      },
    },
  );

  await client.auth.getClaims();
  response.headers.set("Cache-Control", "private, no-store");
  response.headers.set("Pragma", "no-cache");
  return response;
}
