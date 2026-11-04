import assert from "node:assert/strict";
import test from "node:test";

import {
  contractParseInputSchema,
  contractParseOutputSchema,
  hasObjectiveDefinition,
  hasSubjectiveAcceptance,
  workVerificationInputSchema,
} from "../src/lib/validation.ts";

test("contract parser input is bounded and rejects extra fields", () => {
  assert.equal(
    contractParseInputSchema.safeParse({
      negotiationLog: "Freelancer and client agree to build the product.",
    }).success,
    true,
  );
  assert.equal(
    contractParseInputSchema.safeParse({
      negotiationLog: "A sufficiently long negotiation log.",
      clientEmail: "attacker@example.com",
    }).success,
    false,
  );
});

test("contract output requires schema-valid, objective milestones", () => {
  const parsed = contractParseOutputSchema.safeParse({
    freelancer_email: "freelancer@example.com",
    client_email: "client@example.com",
    total_budget: 1200,
    currency: "USD",
    milestones: [
      {
        title: "Responsive login page",
        amount: 1200,
        verification_type: "github_commit",
        description:
          "Build a Next.js login page with email and password inputs and return HTTP 200 after valid authentication.",
      },
    ],
  });

  assert.equal(parsed.success, true);
  const subjective = contractParseOutputSchema.safeParse({
      freelancer_email: "freelancer@example.com",
      client_email: "client@example.com",
      total_budget: 1200,
      currency: "USD",
      milestones: [
        {
          title: "The beautiful application",
          amount: 1200,
          verification_type: "github_commit",
          description: "Deliver a beautiful application.",
        },
      ],
    });
  assert.equal(subjective.success, true);
  if (subjective.success) {
    const milestone = subjective.data.milestones[0];
    assert.equal(
      hasSubjectiveAcceptance(`${milestone.title} ${milestone.description}`) ||
        !hasObjectiveDefinition(milestone.description),
      true,
    );
  }
});

test("subjective milestones are detected and objective acceptance criteria are recognized", () => {
  assert.equal(hasSubjectiveAcceptance("Build a beautiful app"), true);
  assert.equal(
    hasObjectiveDefinition(
      "Use the Tailwind CSS dark mode framework and render a login button.",
    ),
    true,
  );
  assert.equal(hasObjectiveDefinition("Make it feel delightful"), false);
});

test("work webhook accepts repository and commit identifiers, never caller-provided diffs", () => {
  assert.equal(
    workVerificationInputSchema.safeParse({
      milestoneId: "550e8400-e29b-41d4-a716-446655440000",
      repository: "arbitra/escrow",
      commitHash: "a".repeat(40),
    }).success,
    true,
  );
  assert.equal(
    workVerificationInputSchema.safeParse({
      milestoneId: "550e8400-e29b-41d4-a716-446655440000",
      repository: "arbitra/escrow",
      commitHash: "a".repeat(40),
      diff: "untrusted caller-supplied code",
    }).success,
    false,
  );
});
