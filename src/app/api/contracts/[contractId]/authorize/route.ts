import { z } from "zod";

import { errorResponse, AppError } from "@/lib/errors";
import { getAuthenticatedUser } from "@/lib/supabase/auth";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { createEscrowAuthorization } from "@/lib/paypal";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ contractId: string }>;
}

export async function POST(_request: Request, context: RouteContext): Promise<Response> {
  try {
    const { email } = await getAuthenticatedUser();
    const { contractId } = await context.params;
    if (!z.uuid().safeParse(contractId).success) {
      throw new AppError("Contract ID is invalid.", 400, "INVALID_CONTRACT_ID");
    }

    const supabase = getSupabaseAdmin();
    const { data: contract, error: contractError } = await supabase
      .from("contracts")
      .select("*")
      .eq("id", contractId)
      .maybeSingle();

    if (contractError) {
      console.error("Contract funding lookup failed", contractError);
      throw new AppError("Contract could not be loaded.", 503, "DATABASE_READ_FAILED");
    }
    if (!contract) {
      throw new AppError("Contract was not found.", 404, "CONTRACT_NOT_FOUND");
    }
    if (contract.client_email !== email || !contract.client_email_verified) {
      throw new AppError(
        "Only the verified client can authorize this escrow.",
        403,
        "CLIENT_AUTHORIZATION_REQUIRED",
      );
    }
    if (!contract.freelancer_email_verified) {
      throw new AppError(
        "The freelancer must verify their email before escrow can be authorized.",
        409,
        "FREELANCER_VERIFICATION_REQUIRED",
      );
    }
    if (contract.current_status !== "NEGOTIATING") {
      throw new AppError(
        "Only a negotiating contract can start escrow authorization.",
        409,
        "CONTRACT_NOT_NEGOTIATING",
      );
    }

    if (contract.paypal_order_id && contract.paypal_approval_url) {
      return Response.json({
        orderId: contract.paypal_order_id,
        approvalUrl: contract.paypal_approval_url,
      });
    }

    const order = await createEscrowAuthorization(
      contract.total_budget,
      contract.currency,
    );
    const approvalUrl = order.links.find((link) => link.rel === "approve")?.href;
    if (!approvalUrl) {
      throw new AppError(
        "PayPal did not provide an approval link for this order.",
        502,
        "PAYPAL_APPROVAL_LINK_MISSING",
      );
    }

    const { data: updatedContract, error: updateError } = await supabase
      .from("contracts")
      .update({
        paypal_order_id: order.id,
        paypal_approval_url: approvalUrl,
      })
      .eq("id", contractId)
      .eq("current_status", "NEGOTIATING")
      .is("paypal_order_id", null)
      .select("paypal_order_id,paypal_approval_url")
      .maybeSingle();

    if (updateError) {
      console.error("PayPal order tracking failed", updateError);
      throw new AppError(
        "The PayPal order could not be linked to the contract.",
        503,
        "DATABASE_WRITE_FAILED",
      );
    }

    if (updatedContract?.paypal_order_id && updatedContract.paypal_approval_url) {
      return Response.json({
        orderId: updatedContract.paypal_order_id,
        approvalUrl: updatedContract.paypal_approval_url,
      });
    }

    const { data: existingContract, error: existingError } = await supabase
      .from("contracts")
      .select("paypal_order_id,paypal_approval_url")
      .eq("id", contractId)
      .maybeSingle();
    if (existingError) {
      console.error("PayPal order race lookup failed", existingError);
      throw new AppError(
        "The PayPal order state could not be reconciled.",
        503,
        "DATABASE_READ_FAILED",
      );
    }
    if (existingContract?.paypal_order_id && existingContract.paypal_approval_url) {
      return Response.json({
        orderId: existingContract.paypal_order_id,
        approvalUrl: existingContract.paypal_approval_url,
      });
    }

    throw new AppError(
      "The contract changed before the PayPal order could be stored.",
      409,
      "CONTRACT_STATE_CHANGED",
    );
  } catch (error) {
    return errorResponse(error, "PayPal escrow order creation failed");
  }
}
