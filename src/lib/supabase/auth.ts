import "server-only";

import { AppError } from "@/lib/errors";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export async function getAuthenticatedUser() {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.getUser();

  if (error) {
    console.error("Supabase authentication check failed", error);
    throw new AppError("Your session could not be verified.", 401, "INVALID_SESSION");
  }
  if (!data.user || !data.user.email || !data.user.email_confirmed_at) {
    throw new AppError(
      "Sign in with a verified email address to continue.",
      401,
      "AUTHENTICATION_REQUIRED",
    );
  }

  return { supabase, user: data.user, email: data.user.email.toLowerCase() };
}
