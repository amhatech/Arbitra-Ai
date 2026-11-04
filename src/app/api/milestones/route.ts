import { errorResponse, AppError } from "@/lib/errors";
import { getAuthenticatedUser } from "@/lib/supabase/auth";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import type { Milestone, MilestoneGridRow } from "@/types";

export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  try {
    const { email } = await getAuthenticatedUser();
    const supabase = getSupabaseAdmin();
    const [
      { data: freelancerContracts, error: freelancerError },
      { data: clientContracts, error: clientError },
    ] = await Promise.all([
      supabase.from("contracts").select("*").eq("freelancer_email", email),
      supabase.from("contracts").select("*").eq("client_email", email),
    ]);

    if (freelancerError || clientError) {
      console.error("Contract list query failed", { freelancerError, clientError });
      throw new AppError("Contract details could not be loaded.", 503, "DATABASE_READ_FAILED");
    }

    const contracts = [...(freelancerContracts ?? []), ...(clientContracts ?? [])];
    const contractsById = new Map(contracts.map((contract) => [contract.id, contract]));
    const contractIds = [...contractsById.keys()];
    if (contractIds.length === 0) {
      return Response.json({ milestones: [] });
    }

    const { data: milestones, error: milestonesError } = await supabase
      .from("milestones")
      .select("*")
      .in("contract_id", contractIds)
      .order("created_at", { ascending: false });

    if (milestonesError) {
      console.error("Milestone list query failed", milestonesError);
      throw new AppError("Milestones could not be loaded.", 503, "DATABASE_READ_FAILED");
    }

    const rows: MilestoneGridRow[] = milestones.flatMap((milestone: Milestone) => {
      const contract = contractsById.get(milestone.contract_id);
      if (!contract) {
        return [];
      }

      return [
        {
          id: milestone.id,
          contractId: milestone.contract_id,
          title: milestone.title,
          amount: milestone.amount,
          currency: contract.currency,
          status: milestone.status,
          score: milestone.ai_score,
          verificationType: milestone.verification_type,
          commitHash: milestone.verification_commit_sha,
          verificationTimestamp: milestone.verification_timestamp,
          releaseCountdownEta: milestone.release_countdown_eta,
          releasedAmount: milestone.released_amount,
          canAuthorize: contract.client_email === email && contract.client_email_verified,
          canRelease: contract.client_email === email && contract.client_email_verified,
        },
      ];
    });

    return Response.json({ milestones: rows });
  } catch (error) {
    return errorResponse(error, "Milestone list failed");
  }
}
