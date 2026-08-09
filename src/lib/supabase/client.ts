import { createBrowserClient } from "@supabase/ssr";

/**
 * Browser Supabase client. Uses only NEXT_PUBLIC_* variables — safe to import
 * from client components. Never add the service-role key here.
 */
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}
