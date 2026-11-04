import { z } from "zod";

import { errorResponse, AppError } from "@/lib/errors";
import { getAuthenticatedUser } from "@/lib/supabase/auth";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { releaseMilestonePayout } from "@/lib/paypal";

export const runtime = "nodejs";
export const maxDuration = 30;

interface RouteContext {
  params: Promise<{ milestoneId: string }>;
}

const releaseInputSchema = z.strictObject({
  amount: z.number().positive().multipleOf(0.01).max(99_999_999.99),
});

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  try {
    const { email } = await getAuthenticatedUser();
    const { milestoneId } = await context.params;
    if (!z.uuid().safeParse(milestoneId).success) {
      throw new AppError("Milestone ID is invalid.", 400, "INVALID_MILESTONE_ID");
    }

    let requestBody: unknown;
    try {
      requestBody = (await request.json()) as unknown;
    } catch {
      throw new AppError("Request body must be valid JSON.", 400, "INVALID_JSON");
    }
    const input = releaseInputSchema.safeParse(requestBody);
    if (!input.success) {
      throw new AppError("Payout amount is invalid.", 400, "INVALID_AMOUNT");
    }

    const supabase = getSupabaseAdmin();
    const { data: milestone, error: milestoneError } = await supabase
      .from("milestones")
      .select("*")
      .eq("id", milestoneId)
      .maybeSingle();

    if (milestoneError) {
      console.error("Payout milestone lookup failed", milestoneError);
      throw new AppError("Milestone could not be loaded.", 503, "DATABASE_READ_FAILED");
    }
    if (!milestone) {
      throw new AppError("Milestone was not found.", 404, "MILESTONE_NOT_FOUND");
    }

    const { data: contract, error: contractError } = await supabase
      .from("contracts")
      .select("*")
      .eq("id", milestone.contract_id)
      .maybeSingle();
    if (contractError) {
      console.error("Payout contract lookup failed", contractError);
      throw new AppError("Contract could not be loaded.", 503, "DATABASE_READ_FAILED");
    }
    if (!contract) {
      throw new AppError("Contract was not found.", 404, "CONTRACT_NOT_FOUND");
    }
    if (contract.client_email !== email || !contract.client_email_verified) {
      throw new AppError(
        "Only the verified client can release this milestone.",
        403,
        "CLIENT_AUTHORIZATION_REQUIRED",
      );
    }
    if (
      contract.current_status !== "ACTIVE" ||
      milestone.status !== "PENDING_RELEASE" ||
      !milestone.release_countdown_eta ||
      new Date(milestone.release_countdown_eta).getTime() > Date.now()
    ) {
      throw new AppError(
        "The 24-hour hold must expire before payout can be initiated.",
        409,
        "RELEASE_HOLD_ACTIVE",
      );
    }
    if (!contract.freelancer_email_verified) {
      throw new AppError(
        "Freelancer email verification is required before payout.",
        409,
        "FREELANCER_VERIFICATION_REQUIRED",
      );
    }

    const payout = await releaseMilestonePayout(
      contract.freelancer_email,
      input.data.amount,
      milestone.id,
    );

    return Response.json(
      {
        payoutBatchId: payout.batch_header.payout_batch_id,
        payoutStatus: payout.batch_header.batch_status,
        milestoneId: milestone.id,
        message:
          "PayPal accepted the payout batch. Final settlement is recorded only after a verified PayPal payout webhook.",
      },
      { status: 202 },
    );
  } catch (error) {
    return errorResponse(error, "Milestone payout failed");
  }
}
