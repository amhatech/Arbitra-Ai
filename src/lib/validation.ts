import { z } from "zod";

export const contractParseInputSchema = z.strictObject({
  negotiationLog: z.string().trim().min(20).max(20_000),
});

export const contractParseOutputSchema = z.strictObject({
  freelancer_email: z.email().max(254),
  client_email: z.email().max(254),
  total_budget: z.number().positive().multipleOf(0.01).max(99_999_999.99),
  currency: z.string().regex(/^[A-Z]{3}$/),
  milestones: z
    .array(
      z.strictObject({
        title: z.string().trim().min(1).max(160),
        amount: z.number().positive().multipleOf(0.01).max(99_999_999.99),
        verification_type: z.enum(["github_commit", "figma_link"]),
        description: z.string().trim().min(12).max(6000),
      }),
    )
    .min(1)
    .max(30),
});

export const workVerificationInputSchema = z.strictObject({
  milestoneId: z.uuid(),
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  commitHash: z.string().regex(/^[a-fA-F0-9]{7,64}$/),
});

export const workVerificationOutputSchema = z.strictObject({
  score: z.number().int().min(0).max(100),
  summary: z.string().trim().min(1).max(2000),
  evidence: z.array(z.string().trim().min(1).max(1000)).max(20),
});

export const milestoneGridRowSchema = z.strictObject({
  id: z.string().min(1),
  contractId: z.string().min(1),
  title: z.string(),
  amount: z.number(),
  currency: z.string().length(3),
  status: z.enum([
    "AWAITING_FUNDS",
    "ESCROWED",
    "PENDING_RELEASE",
    "PAID",
    "MUTED_DISPUTE",
  ]),
  score: z.number().int().min(0).max(100).nullable(),
  verificationType: z.enum(["github_commit", "figma_link"]),
  commitHash: z.string().nullable(),
  verificationTimestamp: z.string().nullable(),
  releaseCountdownEta: z.string().nullable(),
  releasedAmount: z.number().nonnegative(),
  canAuthorize: z.boolean(),
  canRelease: z.boolean(),
});

export const milestoneListResponseSchema = z.strictObject({
  milestones: z.array(milestoneGridRowSchema),
});

const subjectiveTerms =
  /\b(beautiful|gorgeous|elegant|intuitive|user[- ]friendly|modern|sleek|nice|cool|clean|polished|seamless|easy|amazing|great|awesome)\b/i;
const objectiveIndicators =
  /\b(tailwind|react|next\.?js|typescript|api|endpoint|schema|commit|figma|test|wcag|aria|viewport|breakpoint|pixel|px|rem|em|percent|%|milliseconds?|seconds?|route|button|form|field|database|postgres|supabase|json|response|status code|must render|must include|must support|acceptance criteria|at least|exactly)\b|\b\d+(?:\.\d+)?\b/i;

export function hasSubjectiveAcceptance(description: string): boolean {
  return subjectiveTerms.test(description);
}

export function hasObjectiveDefinition(description: string): boolean {
  return objectiveIndicators.test(description);
}
