import { z } from "zod";

import { errorResponse, AppError } from "@/lib/errors";
import { getAuthenticatedUser } from "@/lib/supabase/auth";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import {
  authorizeEscrowOrder,
  captureEscrowAuthorization,
  getEscrowCapture,
} from "@/lib/paypal";

export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  try {
    const { email } = await getAuthenticatedUser();
    const requestUrl = new URL(request.url);
    const orderId = requestUrl.searchParams.get("token");
    if (!orderId || !/^[A-Za-z0-9-]{1,80}$/.test(orderId)) {
      throw new AppError("PayPal order ID is missing or invalid.", 400, "INVALID_ORDER_ID");
    }

    const supabase = getSupabaseAdmin();
    const { data: contract, error: contractError } = await supabase
      .from("contracts")
      .select("*")
      .eq("paypal_order_id", orderId)
      .maybeSingle();
    if (contractError) {
      console.error("PayPal return contract lookup failed", contractError);
      throw new AppError("Contract could not be loaded.", 503, "DATABASE_READ_FAILED");
    }
    if (!contract || contract.client_email !== email || !contract.client_email_verified) {
      throw new AppError(
        "This PayPal order is not associated with your verified client account.",
        403,
        "CLIENT_AUTHORIZATION_REQUIRED",
      );
    }
    if (contract.current_status === "ACTIVE" && contract.paypal_authorization_id) {
      return redirectToDashboard("success");
    }
    if (contract.current_status !== "NEGOTIATING") {
      throw new AppError("Contract is not awaiting escrow authorization.", 409, "CONTRACT_NOT_NEGOTIATING");
    }

    let authorizationId = contract.paypal_authorization_id;
    let capture = contract.paypal_capture_id
      ? await getEscrowCapture(contract.paypal_capture_id)
      : null;

    if (!authorizationId) {
      const result = await authorizeEscrowOrder(orderId);
      const authorization = result.purchase_units
        .flatMap((purchaseUnit) => purchaseUnit.payments?.authorizations ?? [])
        .find((candidate) => candidate.status === "CREATED");

      if (
        result.status !== "COMPLETED" ||
        !authorization ||
        Math.round(Number(authorization.amount.value) * 100) !==
          Math.round(contract.total_budget * 100) ||
        authorization.amount.currency_code !== contract.currency
      ) {
        throw new AppError(
          "PayPal authorization did not match the full contract balance.",
          409,
          "PAYPAL_AUTHORIZATION_MISMATCH",
        );
      }

      authorizationId = authorization.id;
      capture = await captureEscrowAuthorization(
        authorization.id,
        contract.total_budget,
        contract.currency,
        orderId,
      );
    }

    if (
      !authorizationId ||
      !capture ||
      Math.round(Number(capture.amount.value) * 100) !==
        Math.round(contract.total_budget * 100) ||
      capture.amount.currency_code !== contract.currency
    ) {
      throw new AppError(
        "PayPal capture did not match the full contract balance.",
        409,
        "PAYPAL_CAPTURE_MISMATCH",
      );
    }

    if (capture.status === "PENDING") {
      const { error: pendingError } = await supabase.rpc("record_pending_escrow_capture", {
        p_contract_id: contract.id,
        p_order_id: orderId,
        p_authorization_id: authorizationId,
        p_capture_id: capture.id,
        p_client_email: email,
      });
      if (pendingError) {
        console.error("Pending PayPal capture could not be recorded", pendingError);
        throw new AppError(
          "PayPal capture is pending and could not be linked to the contract.",
          503,
          "CAPTURE_TRACKING_FAILED",
        );
      }
      return redirectToDashboard("pending");
    }

    if (capture.status !== "COMPLETED") {
      throw new AppError(
        "PayPal did not complete the contract-balance capture.",
        409,
        "PAYPAL_CAPTURE_NOT_COMPLETED",
      );
    }

    const { error: activationError } = await supabase.rpc(
      "activate_contract_after_authorization",
      {
        p_contract_id: contract.id,
        p_order_id: orderId,
        p_authorization_id: authorizationId,
        p_capture_id: capture.id,
        p_authorized_amount: Number(capture.amount.value),
        p_currency: capture.amount.currency_code,
        p_client_email: email,
      },
    );
    if (activationError) {
      console.error("Contract activation failed after PayPal capture", activationError);
      throw new AppError(
        "PayPal captured the funds, but the contract could not be activated. Contact support before retrying.",
        503,
        "CONTRACT_ACTIVATION_FAILED",
      );
    }

    return redirectToDashboard("success");
  } catch (error) {
    if (error instanceof AppError) {
      console.error("PayPal authorization return failed", error.code);
      return redirectToDashboard("error", error.code);
    }
    return errorResponse(error, "PayPal authorization return failed");
  }
}

function redirectToDashboard(
  status: "success" | "pending" | "error",
  reason?: string,
): Response {
  const configuredUrl = process.env.APP_BASE_URL;
  const baseUrl = z.url().safeParse(configuredUrl);
  if (!baseUrl.success) {
    throw new AppError("APP_BASE_URL is invalid.", 503, "APP_URL_INVALID");
  }

  const destination = new URL("/dashboard", baseUrl.data);
  destination.searchParams.set("funding", status);
  if (reason) {
    destination.searchParams.set("reason", reason);
  }
  return Response.redirect(destination, 303);
}
