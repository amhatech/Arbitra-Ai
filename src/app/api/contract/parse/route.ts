import { createHash } from "node:crypto";
import { generateObject } from "ai";

import { errorResponse, AppError } from "@/lib/errors";
import { getComplianceModel } from "@/lib/ai";
import { getAuthenticatedUser } from "@/lib/supabase/auth";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import {
  contractParseInputSchema,
  contractParseOutputSchema,
  hasObjectiveDefinition,
  hasSubjectiveAcceptance,
} from "@/lib/validation";
import type { Json } from "@/types";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(request: Request): Promise<Response> {
  try {
    const rawBody = await request.text();
    if (rawBody.length > 22_000) {
      throw new AppError("Request body exceeds the allowed size.", 413, "BODY_TOO_LARGE");
    }

    let requestBody: unknown;
    try {
      requestBody = JSON.parse(rawBody) as unknown;
    } catch {
      throw new AppError("Request body must be valid JSON.", 400, "INVALID_JSON");
    }

    const input = contractParseInputSchema.safeParse(requestBody);
    if (!input.success) {
      throw new AppError(
        "Provide a negotiationLog between 20 and 20,000 characters.",
        400,
        "INVALID_NEGOTIATION_LOG",
      );
    }
    const { email: authenticatedEmail } = await getAuthenticatedUser();

    const { object } = await generateObject({
      model: getComplianceModel(),
      schema: contractParseOutputSchema,
      system: [
        "You extract a freelance contract from a negotiation log.",
        "Return only facts explicitly agreed by both parties. Never invent email addresses, prices, currency, milestones, or technical requirements.",
        "Every milestone description must be an objective, observable pass/fail acceptance criterion.",
        "Remove subjective adjectives such as beautiful, modern, clean, intuitive, polished, or easy.",
        "Do not translate subjective design goals into technical decisions unless those decisions are explicitly stated in the negotiation.",
        "If a design requirement has no explicit framework, style tokens, measurable dimensions, components, or equivalent acceptance criteria, preserve no speculative details; the server will reject it.",
        "Milestone amounts must sum exactly to total_budget. Use decimal numbers with at most two fractional digits.",
        "Use lowercase valid email addresses, uppercase ISO 4217 currency codes, and only the allowed verification_type values.",
      ].join(" "),
      prompt: `Extract this negotiation log into the required contract structure:\n\n${input.data.negotiationLog}`,
      temperature: 0,
    });

    const validated = contractParseOutputSchema.safeParse(object);
    if (!validated.success) {
      throw new AppError(
        "The negotiation does not contain a complete, schema-valid contract.",
        422,
        "CONTRACT_NOT_ACTIONABLE",
      );
    }

    const draft = validated.data;
    if (draft.freelancer_email.toLowerCase() === draft.client_email.toLowerCase()) {
      throw new AppError(
        "The freelancer and client must be different parties.",
        422,
        "CONTRACT_PARTIES_MUST_DIFFER",
      );
    }
    if (
      authenticatedEmail !== draft.freelancer_email.toLowerCase() &&
      authenticatedEmail !== draft.client_email.toLowerCase()
    ) {
      throw new AppError(
        "The signed-in verified email must match the freelancer or client in the negotiation.",
        403,
        "USER_NOT_A_CONTRACT_PARTY",
      );
    }

    const nonObjectiveMilestone = draft.milestones.find(
      (milestone) =>
        hasSubjectiveAcceptance(`${milestone.title} ${milestone.description}`) ||
        !hasObjectiveDefinition(milestone.description),
    );
    if (nonObjectiveMilestone) {
      throw new AppError(
        `Milestone "${nonObjectiveMilestone.title}" needs explicit, testable acceptance criteria. Replace subjective design terms with specified frameworks, components, dimensions, tests, or other observable requirements.`,
        422,
        "SUBJECTIVE_ACCEPTANCE_CRITERIA",
      );
    }

    const milestoneTotal = Math.round(
      draft.milestones.reduce((sum, milestone) => sum + milestone.amount, 0) * 100,
    );
    if (milestoneTotal !== Math.round(draft.total_budget * 100)) {
      throw new AppError(
        "Milestone amounts must sum exactly to the agreed contract budget.",
        422,
        "MILESTONE_TOTAL_MISMATCH",
      );
    }

    const payload: Json = {
      freelancer_email: draft.freelancer_email.toLowerCase(),
      freelancer_email_verified:
        authenticatedEmail === draft.freelancer_email.toLowerCase(),
      client_email: draft.client_email.toLowerCase(),
      client_email_verified: authenticatedEmail === draft.client_email.toLowerCase(),
      total_budget: draft.total_budget,
      currency: draft.currency,
      milestones: draft.milestones.map((milestone): Json => ({
        title: milestone.title,
        amount: milestone.amount,
        verification_type: milestone.verification_type,
        description: milestone.description,
      })),
    };
    const fingerprint = createHash("sha256")
      .update(input.data.negotiationLog)
      .digest("hex");
    const supabase = getSupabaseAdmin();
    const { data: contractId, error } = await supabase.rpc(
      "upsert_contract_from_negotiation",
      {
        p_fingerprint: fingerprint,
        p_payload: payload,
      },
    );

    if (error) {
      console.error("Contract upsert failed", error);
      if (error.code === "23514" || error.code === "22023") {
        throw new AppError(
          "This contract cannot be updated in its current state or its amounts are inconsistent.",
          409,
          "CONTRACT_UPSERT_REJECTED",
        );
      }
      throw new AppError("The contract could not be saved.", 503, "DATABASE_WRITE_FAILED");
    }

    return Response.json(
      {
        contractId,
        contract: draft,
        status: "NEGOTIATING",
        emailVerificationRequired: true,
      },
      { status: 201 },
    );
  } catch (error) {
    return errorResponse(error, "Contract parsing failed");
  }
}
