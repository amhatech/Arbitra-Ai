import { createSupabaseServerClient, isSupabaseAuthConfigured } from "@/lib/supabase/server";
import { DashboardClient } from "@/app/dashboard/dashboard-client";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const configurationReady = isSupabaseAuthConfigured();
  let userEmail: string | null = null;

  if (configurationReady) {
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.auth.getUser();
    if (error) {
      console.error("Dashboard session lookup failed", error);
    } else if (data.user?.email && data.user.email_confirmed_at) {
      userEmail = data.user.email.toLowerCase();
    }
  }

  return (
    <DashboardClient
      configurationReady={configurationReady}
      userEmail={userEmail}
    />
  );
}
