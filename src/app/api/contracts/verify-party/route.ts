import { errorResponse, AppError } from "@/lib/errors";
import { getAuthenticatedUser } from "@/lib/supabase/auth";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";

export async function POST(): Promise<Response> {
  try {
    const { email } = await getAuthenticatedUser();
    const supabase = getSupabaseAdmin();
    const { data: updatedContracts, error } = await supabase.rpc(
      "verify_contract_party",
      { p_email: email },
    );

    if (error) {
      console.error("Contract-party email verification sync failed", error);
      throw new AppError(
        "Verified email status could not be synchronized.",
        503,
        "EMAIL_VERIFICATION_SYNC_FAILED",
      );
    }

    return Response.json({ verified: true, updatedContracts });
  } catch (error) {
    return errorResponse(error, "Contract-party verification sync failed");
  }
}
