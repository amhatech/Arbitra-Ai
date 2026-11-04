import "server-only";

import { createClient } from "@supabase/supabase-js";

import type { Database } from "@/types";
import { AppError } from "@/lib/errors";

export function getSupabaseAdmin() {
  const url = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey) {
    throw new AppError(
      "Supabase server configuration is missing.",
      503,
      "SUPABASE_NOT_CONFIGURED",
    );
  }

  return createClient<Database>(url, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
  });
}
