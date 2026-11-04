import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";

import { AppError } from "@/lib/errors";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import type {
  PayPalAuthorizationResponse,
  PayPalCaptureResponse,
  PayPalOAuthTokenResponse,
  PayPalOrderResponse,
  PayPalPayoutResponse,
  Json,
} from "@/types";

const oauthTokenSchema: z.ZodType<PayPalOAuthTokenResponse> = z.object({
  access_token: z.string().min(1),
  token_type: z.string().min(1),
  expires_in: z.number().positive(),
  scope: z.string().optional(),
});

const orderResponseSchema: z.ZodType<PayPalOrderResponse> = z.object({
  id: z.string().min(1),
  status: z.string().min(1),
  intent: z.literal("AUTHORIZE"),
  links: z.array(
    z.object({
      href: z.url(),
      rel: z.string(),
      method: z.string().optional(),
    }),
  ),
});

const authorizationResponseSchema: z.ZodType<PayPalAuthorizationResponse> =
  z.object({
    id: z.string(),
    status: z.string(),
    purchase_units: z.array(
      z.object({
        payments: z
          .object({
            authorizations: z.array(
              z.object({
                id: z.string(),
                status: z.string(),
                amount: z.object({
                  currency_code: z.string(),
                  value: z.string(),
                }),
              }),
            ),
          })
          .optional(),
      }),
    ),
  });

const captureResponseSchema: z.ZodType<PayPalCaptureResponse> = z.object({
  id: z.string().min(1),
  status: z.string().min(1),
  amount: z.object({
    currency_code: z.string(),
    value: z.string(),
  }),
  final_capture: z.boolean().optional(),
});

const payoutResponseSchema: z.ZodType<PayPalPayoutResponse> = z.object({
  batch_header: z.object({
    payout_batch_id: z.string().min(1),
    batch_status: z.string().min(1),
  }),
  links: z
    .array(
      z.object({
        href: z.url(),
        rel: z.string(),
        method: z.string().optional(),
      }),
    )
    .optional(),
});

const webhookVerificationSchema = z.object({
  verification_status: z.enum(["SUCCESS", "FAILURE"]),
});

let cachedAccessToken: { value: string; expiresAt: number } | null = null;
let tokenRequest: Promise<string> | null = null;

function getApiBaseUrl(): string {
  const environment = process.env.PAYPAL_ENVIRONMENT ?? "sandbox";
  if (environment === "sandbox") {
    return "https://api-m.sandbox.paypal.com";
  }
  if (environment === "live") {
    return "https://api-m.paypal.com";
  }
  throw new AppError(
    "PAYPAL_ENVIRONMENT must be either sandbox or live.",
    503,
    "PAYPAL_CONFIGURATION_INVALID",
  );
}

export async function captureEscrowAuthorization(
  authorizationId: string,
  amount: number,
  currency: string,
  orderId: string,
): Promise<PayPalCaptureResponse> {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(authorizationId)) {
    throw new AppError("PayPal authorization ID is invalid.", 400, "INVALID_AUTHORIZATION_ID");
  }
  if (!/^[A-Za-z0-9-]{1,80}$/.test(orderId)) {
    throw new AppError("PayPal order ID is invalid.", 400, "INVALID_ORDER_ID");
  }

  const requestId = `escrow-${createHash("sha256").update(orderId).digest("hex").slice(0, 30)}`;
  return paypalRequest(
    `/v2/payments/authorizations/${encodeURIComponent(authorizationId)}/capture`,
    {
      method: "POST",
      headers: {
        Prefer: "return=representation",
        "PayPal-Request-Id": requestId,
      },
      body: JSON.stringify({
        amount: {
          currency_code: validateCurrency(currency),
          value: formatAmount(amount),
        },
        final_capture: true,
      }),
    },
    captureResponseSchema,
  );
}

export async function getEscrowCapture(
  captureId: string,
): Promise<PayPalCaptureResponse> {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(captureId)) {
    throw new AppError("PayPal capture ID is invalid.", 400, "INVALID_CAPTURE_ID");
  }

  return paypalRequest(
    `/v2/payments/captures/${encodeURIComponent(captureId)}`,
    { method: "GET" },
    captureResponseSchema,
  );
}

function getCredentials(): { clientId: string; clientSecret: string } {
  const clientId = process.env.PAYPAL_CLIENT_ID;
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new AppError(
      "PayPal server credentials are missing.",
      503,
      "PAYPAL_NOT_CONFIGURED",
    );
  }

  return { clientId, clientSecret };
}

function formatAmount(amount: number): string {
  if (!Number.isFinite(amount) || amount <= 0 || !Number.isInteger(amount * 100)) {
    throw new AppError(
      "Amount must be positive and have no more than two decimal places.",
      400,
      "INVALID_AMOUNT",
    );
  }
  return amount.toFixed(2);
}

function validateCurrency(currency: string): string {
  const normalized = currency.toUpperCase();
  if (!/^[A-Z]{3}$/.test(normalized)) {
    throw new AppError("Currency must be a three-letter ISO code.", 400, "INVALID_CURRENCY");
  }
  return normalized;
}

function getApplicationBaseUrl(): URL {
  const configuredUrl = process.env.APP_BASE_URL;
  if (!configuredUrl) {
    throw new AppError("APP_BASE_URL is required for PayPal checkout.", 503, "APP_URL_NOT_CONFIGURED");
  }

  let url: URL;
  try {
    url = new URL(configuredUrl);
  } catch {
    throw new AppError("APP_BASE_URL is invalid.", 503, "APP_URL_INVALID");
  }

  if (url.protocol !== "https:" && url.hostname !== "localhost") {
    throw new AppError("APP_BASE_URL must use HTTPS outside localhost.", 503, "APP_URL_INVALID");
  }

  return url;
}

async function getAccessToken(): Promise<string> {
  if (cachedAccessToken && cachedAccessToken.expiresAt > Date.now()) {
    return cachedAccessToken.value;
  }
  if (tokenRequest) {
    return tokenRequest;
  }

  tokenRequest = (async () => {
    const { clientId, clientSecret } = getCredentials();
    const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
    const response = await fetch(`${getApiBaseUrl()}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${credentials}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
      cache: "no-store",
    });

    let responseBody: unknown;
    try {
      responseBody = (await response.json()) as unknown;
    } catch {
      throw new AppError("PayPal returned an invalid OAuth response.", 502, "PAYPAL_BAD_RESPONSE");
    }

    if (!response.ok) {
      throw new AppError("PayPal OAuth authentication failed.", 502, "PAYPAL_AUTH_FAILED");
    }

    const token = oauthTokenSchema.safeParse(responseBody);
    if (!token.success) {
      throw new AppError("PayPal returned an invalid OAuth token.", 502, "PAYPAL_BAD_RESPONSE");
    }

    cachedAccessToken = {
      value: token.data.access_token,
      expiresAt: Date.now() + Math.max(token.data.expires_in - 60, 0) * 1000,
    };
    return token.data.access_token;
  })();

  try {
    return await tokenRequest;
  } finally {
    tokenRequest = null;
  }
}

async function paypalRequest<T>(
  path: string,
  init: RequestInit,
  schema: z.ZodType<T>,
): Promise<T> {
  const accessToken = await getAccessToken();
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${accessToken}`);
  headers.set("Content-Type", "application/json");

  const response = await fetch(`${getApiBaseUrl()}${path}`, {
    ...init,
    headers,
    cache: "no-store",
  });

  let responseBody: unknown;
  try {
    responseBody = (await response.json()) as unknown;
  } catch {
    throw new AppError("PayPal returned an invalid response.", 502, "PAYPAL_BAD_RESPONSE");
  }

  if (!response.ok) {
    const providerMessage =
      typeof responseBody === "object" &&
      responseBody !== null &&
      "message" in responseBody &&
      typeof responseBody.message === "string"
        ? responseBody.message
        : "PayPal rejected the request.";
    console.error("PayPal API request failed", {
      path,
      status: response.status,
      providerMessage,
    });
    throw new AppError("PayPal could not complete the transaction.", 502, "PAYPAL_REQUEST_FAILED");
  }

  const parsed = schema.safeParse(responseBody);
  if (!parsed.success) {
    throw new AppError("PayPal returned an unexpected response.", 502, "PAYPAL_BAD_RESPONSE");
  }

  return parsed.data;
}

export async function createEscrowAuthorization(
  amount: number,
  currency = "USD",
): Promise<PayPalOrderResponse> {
  const formattedAmount = formatAmount(amount);
  const currencyCode = validateCurrency(currency);
  const applicationBaseUrl = getApplicationBaseUrl();
  const returnUrl = new URL("/api/paypal/return", applicationBaseUrl);
  const cancelUrl = new URL("/dashboard?funding=cancelled", applicationBaseUrl);

  return paypalRequest(
    "/v2/checkout/orders",
    {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({
        intent: "AUTHORIZE",
        purchase_units: [
          {
            amount: {
              currency_code: currencyCode,
              value: formattedAmount,
            },
          },
        ],
        application_context: {
          user_action: "CONTINUE",
          return_url: returnUrl.toString(),
          cancel_url: cancelUrl.toString(),
        },
      }),
    },
    orderResponseSchema,
  );
}

export async function authorizeEscrowOrder(
  orderId: string,
): Promise<PayPalAuthorizationResponse> {
  if (!/^[A-Za-z0-9-]{1,80}$/.test(orderId)) {
    throw new AppError("PayPal order ID is invalid.", 400, "INVALID_ORDER_ID");
  }

  return paypalRequest(
    `/v2/checkout/orders/${encodeURIComponent(orderId)}/authorize`,
    {
      method: "POST",
      headers: { Prefer: "return=representation" },
    },
    authorizationResponseSchema,
  );
}

export async function releaseMilestonePayout(
  freelancerEmail: string,
  amount: number,
  milestoneId?: string,
): Promise<PayPalPayoutResponse> {
  const email = z.email().safeParse(freelancerEmail.trim().toLowerCase());
  if (!email.success) {
    throw new AppError("Freelancer email is invalid.", 400, "INVALID_RECIPIENT");
  }
  const formattedAmount = formatAmount(amount);
  if (milestoneId && !z.uuid().safeParse(milestoneId).success) {
    throw new AppError("Milestone ID is invalid.", 400, "INVALID_MILESTONE_ID");
  }
  const supabase = getSupabaseAdmin();
  const requestId = randomUUID();
  const { data: reservations, error: reserveError } = await supabase.rpc(
    "reserve_milestone_payout",
    {
      p_freelancer_email: email.data,
      p_amount: amount,
      p_idempotency_key: requestId,
      p_milestone_id: milestoneId ?? null,
    },
  );

  if (reserveError) {
    console.error("Milestone payout reservation failed", reserveError);
    throw new AppError(
      "No eligible milestone could be reserved for this payout.",
      409,
      "PAYOUT_NOT_ELIGIBLE",
    );
  }

  const reservation = reservations[0];
  if (!reservation) {
    throw new AppError("Payout reservation returned no result.", 503, "PAYOUT_RESERVATION_FAILED");
  }

  const senderBatchId = `arb-${reservation.idempotency_key.replaceAll("-", "").slice(0, 24)}`;
  const payout = await paypalRequest(
    "/v1/payments/payouts",
    {
      method: "POST",
      headers: { "PayPal-Request-Id": reservation.idempotency_key },
      body: JSON.stringify({
        sender_batch_header: {
          sender_batch_id: senderBatchId,
          email_subject: "Your Arbitra AI milestone payout",
          email_message: "A verified milestone payout has been initiated.",
        },
        items: [
          {
            recipient_type: "EMAIL",
            amount: {
              value: formattedAmount,
              currency: reservation.currency,
            },
            receiver: email.data,
            note: "Milestone release after the regulatory hold window.",
            sender_item_id: reservation.payout_id.replaceAll("-", "").slice(0, 30),
          },
        ],
      }),
    },
    payoutResponseSchema,
  );

  const { error: batchUpdateError } = await supabase
    .from("milestone_payouts")
    .update({ paypal_batch_id: payout.batch_header.payout_batch_id })
    .eq("id", reservation.payout_id)
    .eq("status", "PROCESSING")
    .select("id")
    .single();

  if (batchUpdateError) {
    console.error("Accepted PayPal payout could not be linked to its reservation", {
      payoutId: reservation.payout_id,
      error: batchUpdateError,
    });
    throw new AppError(
      "PayPal accepted the payout, but local tracking could not be updated. Retry with the same request to reconcile it.",
      503,
      "PAYOUT_TRACKING_FAILED",
    );
  }

  return payout;
}

export async function verifyPayPalWebhook(
  headers: Headers,
  event: Json,
): Promise<boolean> {
  const webhookId = process.env.PAYPAL_WEBHOOK_ID;
  if (!webhookId) {
    throw new AppError(
      "PayPal webhook verification is not configured.",
      503,
      "PAYPAL_WEBHOOK_NOT_CONFIGURED",
    );
  }

  const headerValues = {
    auth_algo: headers.get("paypal-auth-algo"),
    cert_url: headers.get("paypal-cert-url"),
    transmission_id: headers.get("paypal-transmission-id"),
    transmission_sig: headers.get("paypal-transmission-sig"),
    transmission_time: headers.get("paypal-transmission-time"),
  };

  if (Object.values(headerValues).some((value) => !value)) {
    return false;
  }

  const result = await paypalRequest(
    "/v1/notifications/verify-webhook-signature",
    {
      method: "POST",
      body: JSON.stringify({
        ...headerValues,
        webhook_id: webhookId,
        webhook_event: event,
      }),
    },
    webhookVerificationSchema,
  );

  return result.verification_status === "SUCCESS";
}
