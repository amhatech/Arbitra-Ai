import "server-only";

import { google } from "@ai-sdk/google";

import { AppError } from "@/lib/errors";

export function getComplianceModel() {
  if (!process.env.GOOGLE_GENERATIVE_AI_API_KEY) {
    throw new AppError(
      "Google AI server configuration is missing.",
      503,
      "AI_NOT_CONFIGURED",
    );
  }

  return google("gemini-2.5-flash");
}
