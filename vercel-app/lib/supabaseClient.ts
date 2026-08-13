import { createClient } from "@supabase/supabase-js";

// Safe to expose in the browser: RLS on `tickets` only grants public
// SELECT plus execute on the call_next_ticket() RPC (SECURITY
// DEFINER) — see supabase/schema.sql in the repo root. There is no
// direct write path from this key beyond that vetted function.
const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

if (!url || !anonKey) {
  throw new Error(
    "Missing NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY. " +
      "Copy .env.local.example to .env.local and fill in your Supabase project's values."
  );
}

export const supabase = createClient(url, anonKey);

/** Local calendar date as YYYY-MM-DD, matching the desktop app's
 * `business_date` (Python `date.today().isoformat()`), not UTC. */
export function todayBusinessDate(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
