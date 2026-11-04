import { z } from "zod";

import { errorResponse, AppError } from "@/lib/errors";
import { getAuthenticatedUser } from "@/lib/supabase/auth";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ milestoneId: string }>;
}

export async function POST(_request: Request, context: RouteContext): Promise<Response> {
  try {
    const { email } = await getAuthenticatedUser();
    const { milestoneId } = await context.params;
    if (!z.uuid().safeParse(milestoneId).success) {
      throw new AppError("Milestone ID is invalid.", 400, "INVALID_MILESTONE_ID");
    }

    const supabase = getSupabaseAdmin();
    const { data: milestone, error } = await supabase.rpc("raise_milestone_dispute", {
      p_milestone_id: milestoneId,
      p_user_email: email,
    });

    if (error) {
      console.error("Milestone dispute request failed", error);
      if (error.code === "P0002") {
        throw new AppError("Milestone was not found.", 404, "MILESTONE_NOT_FOUND");
      }
      if (error.code === "42501") {
        throw new AppError(
          "Only a verified contract party can dispute this milestone.",
          403,
          "CONTRACT_PARTY_REQUIRED",
        );
      }
      if (error.code === "23514") {
        throw new AppError(
          "The milestone is not in its active 24-hour dispute window.",
          409,
          "DISPUTE_WINDOW_CLOSED",
        );
      }
      throw new AppError("The dispute could not be recorded.", 503, "DATABASE_WRITE_FAILED");
    }

    return Response.json({ milestone });
  } catch (error) {
    return errorResponse(error, "Milestone dispute failed");
  }
}
