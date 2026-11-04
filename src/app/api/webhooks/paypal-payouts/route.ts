import { z } from "zod";

import { errorResponse, AppError } from "@/lib/errors";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { verifyPayPalWebhook } from "@/lib/paypal";
import type { Json } from "@/types";

export const runtime = "nodejs";

const payoutEventSchema = z.object({
  id: z.string().min(1),
  event_type: z.string().min(1),
  resource: z.object({
    payout_batch_id: z.string().min(1).optional(),
    transaction_status: z.string().optional(),
    batch_header: z
      .object({ payout_batch_id: z.string().min(1) })
      .optional(),
  }),
});

const terminalPayoutFailureEvents = new Set([
  "PAYMENT.PAYOUTS-ITEM.BLOCKED",
  "PAYMENT.PAYOUTS-ITEM.DENIED",
  "PAYMENT.PAYOUTS-ITEM.FAILED",
  "PAYMENT.PAYOUTS-ITEM.RETURNED",
]);

export async function POST(request: Request): Promise<Response> {
  try {
    const rawBody = await request.text();
    if (rawBody.length > 100_000) {
      throw new AppError("Webhook body exceeds the allowed size.", 413, "BODY_TOO_LARGE");
    }

    let rawEvent: unknown;
    try {
      rawEvent = JSON.parse(rawBody) as unknown;
    } catch {
      throw new AppError("Webhook body must be valid JSON.", 400, "INVALID_JSON");
    }

    const eventResult = payoutEventSchema.safeParse(rawEvent);
    if (!eventResult.success) {
      throw new AppError("PayPal payout event is invalid.", 400, "INVALID_PAYPAL_EVENT");
    }

    const event = eventResult.data;
    const verificationEvent = JSON.parse(JSON.stringify(rawEvent)) as Json;
    if (!(await verifyPayPalWebhook(request.headers, verificationEvent))) {
      throw new AppError("PayPal webhook signature is invalid.", 401, "INVALID_PAYPAL_SIGNATURE");
    }

    const batchId =
      event.resource.payout_batch_id ?? event.resource.batch_header?.payout_batch_id;
    if (!batchId) {
      throw new AppError("PayPal event has no payout batch ID.", 400, "MISSING_PAYOUT_BATCH_ID");
    }

    const supabase = getSupabaseAdmin();
    const { data: payout, error: payoutError } = await supabase
      .from("milestone_payouts")
      .select("id,status")
      .eq("paypal_batch_id", batchId)
      .maybeSingle();

    if (payoutError) {
      console.error("PayPal payout lookup failed", payoutError);
      throw new AppError("Payout could not be loaded.", 503, "DATABASE_READ_FAILED");
    }
    if (!payout) {
      throw new AppError("PayPal payout batch is not tracked.", 404, "PAYOUT_NOT_FOUND");
    }

    if (event.event_type === "PAYMENT.PAYOUTS-ITEM.SUCCEEDED") {
      const { error } = await supabase.rpc("complete_milestone_payout", {
        p_payout_id: payout.id,
        p_paypal_batch_id: batchId,
      });
      if (error) {
        console.error("PayPal payout completion failed", error);
        throw new AppError("Payout completion could not be recorded.", 503, "DATABASE_WRITE_FAILED");
      }
    } else if (terminalPayoutFailureEvents.has(event.event_type)) {
      const { error } = await supabase.rpc("fail_milestone_payout", {
        p_payout_id: payout.id,
        p_error_message: `PayPal payout event: ${event.event_type}`,
      });
      if (error) {
        console.error("PayPal payout failure could not be recorded", error);
        throw new AppError("Payout failure could not be recorded.", 503, "DATABASE_WRITE_FAILED");
      }
    }

    return Response.json({ received: true, eventId: event.id });
  } catch (error) {
    return errorResponse(error, "PayPal payout webhook failed");
  }
}
