import { z } from "zod";

import { errorResponse, AppError } from "@/lib/errors";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { getEscrowCapture, verifyPayPalWebhook } from "@/lib/paypal";
import type { Json } from "@/types";

export const runtime = "nodejs";

const escrowEventSchema = z.object({
  id: z.string().min(1),
  event_type: z.string().min(1),
  resource: z.object({ id: z.string().min(1) }),
});

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
    const parsedEvent = escrowEventSchema.safeParse(rawEvent);
    if (!parsedEvent.success) {
      throw new AppError("PayPal capture event is invalid.", 400, "INVALID_PAYPAL_EVENT");
    }

    const event = parsedEvent.data;
    if (!(await verifyPayPalWebhook(request.headers, JSON.parse(JSON.stringify(rawEvent)) as Json))) {
      throw new AppError("PayPal webhook signature is invalid.", 401, "INVALID_PAYPAL_SIGNATURE");
    }

    if (
      event.event_type !== "PAYMENT.CAPTURE.COMPLETED" &&
      event.event_type !== "PAYMENT.CAPTURE.DENIED"
    ) {
      return Response.json({ received: true, ignored: true, eventId: event.id });
    }

    const supabase = getSupabaseAdmin();
    const { data: contract, error: contractError } = await supabase
      .from("contracts")
      .select("*")
      .eq("paypal_capture_id", event.resource.id)
      .maybeSingle();

    if (contractError) {
      console.error("PayPal escrow capture lookup failed", contractError);
      throw new AppError("Escrow contract could not be loaded.", 503, "DATABASE_READ_FAILED");
    }
    if (!contract) {
      throw new AppError(
        "PayPal escrow capture is not tracked yet.",
        503,
        "CAPTURE_NOT_TRACKED",
      );
    }

    if (event.event_type === "PAYMENT.CAPTURE.DENIED") {
      const { error: failureError } = await supabase.rpc(
        "fail_pending_escrow_capture",
        { p_capture_id: event.resource.id },
      );
      if (failureError) {
        console.error("Denied PayPal capture could not be reconciled", failureError);
        throw new AppError("Escrow capture failure could not be recorded.", 503, "DATABASE_WRITE_FAILED");
      }

      return Response.json({ received: true, failed: true, eventId: event.id });
    }

    const capture = await getEscrowCapture(event.resource.id);
    if (
      capture.status !== "COMPLETED" ||
      capture.amount.currency_code !== contract.currency ||
      Math.round(Number(capture.amount.value) * 100) !==
        Math.round(contract.total_budget * 100) ||
      !contract.paypal_authorization_id
    ) {
      throw new AppError(
        "PayPal capture does not match the authorized contract balance.",
        409,
        "PAYPAL_CAPTURE_MISMATCH",
      );
    }

    if (contract.current_status === "ACTIVE") {
      return Response.json({ received: true, activated: true, eventId: event.id });
    }

    const { error: activationError } = await supabase.rpc(
      "activate_contract_after_authorization",
      {
        p_contract_id: contract.id,
        p_order_id: contract.paypal_order_id ?? "",
        p_authorization_id: contract.paypal_authorization_id,
        p_capture_id: capture.id,
        p_authorized_amount: Number(capture.amount.value),
        p_currency: capture.amount.currency_code,
        p_client_email: contract.client_email,
      },
    );
    if (activationError) {
      console.error("PayPal webhook contract activation failed", activationError);
      throw new AppError("Captured escrow could not be activated.", 503, "DATABASE_WRITE_FAILED");
    }

    return Response.json({ received: true, activated: true, eventId: event.id });
  } catch (error) {
    return errorResponse(error, "PayPal escrow webhook failed");
  }
}
