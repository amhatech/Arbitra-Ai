import { generateObject } from "ai";

import { errorResponse, AppError } from "@/lib/errors";
import { getComplianceModel } from "@/lib/ai";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { isValidHmacSha256 } from "@/lib/webhook-signature";
import {
  workVerificationInputSchema,
  workVerificationOutputSchema,
} from "@/lib/validation";
import type { Contract, Json, Milestone } from "@/types";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(request: Request): Promise<Response> {
  try {
    const secret = process.env.WORK_VERIFIER_WEBHOOK_SECRET;
    if (!secret) {
      throw new AppError(
        "Work-verifier webhook is not configured.",
        503,
        "WORK_VERIFIER_NOT_CONFIGURED",
      );
    }

    const rawBody = await request.text();
    if (rawBody.length > 110_000) {
      throw new AppError("Request body exceeds the allowed size.", 413, "BODY_TOO_LARGE");
    }
    if (!isValidHmacSha256(rawBody, request.headers.get("x-hub-signature-256"), secret)) {
      throw new AppError("Webhook signature is invalid.", 401, "INVALID_WEBHOOK_SIGNATURE");
    }

    let requestBody: unknown;
    try {
      requestBody = JSON.parse(rawBody) as unknown;
    } catch {
      throw new AppError("Request body must be valid JSON.", 400, "INVALID_JSON");
    }

    const input = workVerificationInputSchema.safeParse(requestBody);
    if (!input.success) {
      throw new AppError("Work-verification payload is invalid.", 400, "INVALID_VERIFICATION_INPUT");
    }

    const repository = process.env.WORK_VERIFIER_REPOSITORY;
    const githubToken = process.env.GITHUB_TOKEN;
    if (!repository || !githubToken) {
      throw new AppError(
        "GitHub repository verification is not configured.",
        503,
        "GITHUB_VERIFIER_NOT_CONFIGURED",
      );
    }
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
      throw new AppError(
        "WORK_VERIFIER_REPOSITORY must use the owner/repository format.",
        503,
        "GITHUB_REPOSITORY_CONFIGURATION_INVALID",
      );
    }
    if (input.data.repository !== repository) {
      throw new AppError(
        "Commit repository is not authorized for this verifier.",
        403,
        "GITHUB_REPOSITORY_NOT_AUTHORIZED",
      );
    }

    const diffResponse = await fetch(
      `https://api.github.com/repos/${repository}/commits/${input.data.commitHash}`,
      {
        headers: {
          Accept: "application/vnd.github.diff",
          Authorization: `Bearer ${githubToken}`,
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "arbitra-ai-work-verifier",
        },
        signal: AbortSignal.timeout(10_000),
        cache: "no-store",
      },
    );
    if (!diffResponse.ok) {
      console.error("GitHub commit diff fetch failed", {
        repository,
        status: diffResponse.status,
      });
      throw new AppError(
        diffResponse.status === 404
          ? "Commit was not found in the authorized GitHub repository."
          : "GitHub could not provide the commit diff.",
        diffResponse.status === 404 ? 404 : 502,
        "GITHUB_DIFF_FETCH_FAILED",
      );
    }
    const diff = await diffResponse.text();
    if (!diff.trim() || diff.length > 100_000) {
      throw new AppError(
        "GitHub commit diff is empty or exceeds the supported size.",
        422,
        "GITHUB_DIFF_UNUSABLE",
      );
    }

    const supabase = getSupabaseAdmin();
    const { data: milestone, error: milestoneError } = await supabase
      .from("milestones")
      .select("*")
      .eq("id", input.data.milestoneId)
      .maybeSingle();

    if (milestoneError) {
      console.error("Milestone lookup failed", milestoneError);
      throw new AppError("Milestone could not be loaded.", 503, "DATABASE_READ_FAILED");
    }
    if (!milestone) {
      throw new AppError("Milestone was not found.", 404, "MILESTONE_NOT_FOUND");
    }
    if (milestone.status !== "ESCROWED") {
      throw new AppError(
        "Only an escrowed milestone can be verified.",
        409,
        "MILESTONE_NOT_ESCROWED",
      );
    }
    if (milestone.verification_type !== "github_commit") {
      throw new AppError(
        "This milestone requires Figma evidence rather than a code commit.",
        422,
        "VERIFICATION_TYPE_MISMATCH",
      );
    }

    const { data: contract, error: contractError } = await supabase
      .from("contracts")
      .select("*")
      .eq("id", milestone.contract_id)
      .maybeSingle();

    if (contractError) {
      console.error("Contract lookup failed", contractError);
      throw new AppError("Contract could not be loaded.", 503, "DATABASE_READ_FAILED");
    }
    if (!contract) {
      throw new AppError("Milestone contract was not found.", 404, "CONTRACT_NOT_FOUND");
    }
    const typedMilestone: Milestone = milestone;
    const typedContract: Contract = contract;
    if (typedContract.current_status !== "ACTIVE") {
      throw new AppError("Contract is not active.", 409, "CONTRACT_NOT_ACTIVE");
    }
    if (!typedContract.freelancer_email_verified || !typedContract.client_email_verified) {
      throw new AppError(
        "Both contract parties must have verified email addresses before work can be released.",
        409,
        "EMAIL_VERIFICATION_REQUIRED",
      );
    }

    const { object } = await generateObject({
      model: getComplianceModel(),
      schema: workVerificationOutputSchema,
      system: [
        "You are an evidence auditor, not a coding assistant.",
        "Compare the submitted code diff only to the milestone acceptance criteria.",
        "Score 0-100 based on directly observable evidence in the diff; do not infer tests, deployments, files, or behavior that are not shown.",
        "A score of 85 or higher means the stated criteria are objectively satisfied. Subjective judgment is not evidence.",
        "For each evidence item, cite a concrete changed file, symbol, test, or observable code fact. Do not claim to have executed tests.",
        "If the diff is empty, unrelated, incomplete, or does not show enough evidence, score below 85.",
      ].join(" "),
      prompt: `Milestone title: ${typedMilestone.title}\nAcceptance criteria:\n${typedMilestone.description}\n\nAuthorized repository: ${repository}\nSubmitted commit: ${input.data.commitHash}\nCode diff fetched directly from GitHub:\n${diff}`,
      temperature: 0,
    });

    const evidence: Json = object.evidence;
    const { data: updatedMilestone, error: updateError } = await supabase.rpc(
      "record_work_verification",
      {
        p_milestone_id: typedMilestone.id,
        p_ai_score: object.score,
        p_commit_sha: input.data.commitHash,
        p_summary: object.summary,
        p_evidence: evidence,
      },
    );

    if (updateError) {
      console.error("Milestone verification write failed", updateError);
      if (updateError.code === "P0002") {
        throw new AppError("Milestone was not found.", 404, "MILESTONE_NOT_FOUND");
      }
      if (updateError.code === "23514") {
        throw new AppError(
          "Milestone state changed before verification could be recorded.",
          409,
          "MILESTONE_STATE_CHANGED",
        );
      }
      throw new AppError(
        "Verification result could not be recorded.",
        503,
        "DATABASE_WRITE_FAILED",
      );
    }

    return Response.json({
      score: object.score,
      summary: object.summary,
      evidence: object.evidence,
      milestone: updatedMilestone,
      releaseHoldHours: object.score >= 85 ? 24 : null,
    });
  } catch (error) {
    return errorResponse(error, "Work verification failed");
  }
}
