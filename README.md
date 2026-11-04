# Arbitra AI

Arbitra AI is a Next.js 15, Supabase, Gemini, and PayPal Sandbox application for
freelance contract negotiation, milestone evidence review, and client-controlled
funding releases.

## Requirements

- Node.js 20.9 or newer
- A Supabase project with the SQL migration applied
- A Google Gemini API key
- PayPal REST API credentials and registered capture/payout webhooks
- A GitHub fine-grained token with read-only access to the configured repository

## Local setup

1. Install dependencies with `npm install`.
2. Copy `.env.example` to `.env.local` and fill in the server credentials.
3. Apply [`supabase/migrations/20261104150000_arbitra_compliance.sql`](./supabase/migrations/20261104150000_arbitra_compliance.sql) to the Supabase project.
4. Add `http://localhost:3000/api/paypal/return` to the PayPal Sandbox app's return URL configuration if required by the app settings.
5. Configure the Supabase Auth email provider and allow `http://localhost:3000/dashboard` as a redirect URL.
6. Run `npm run dev` and open `http://localhost:3000/dashboard`.

The application requires a verified Supabase email matching either party on a
contract. The first party creates a negotiation; the second party must sign in
with their own verified email before the client can fund the contract.

## Webhook configuration

Configure the PayPal REST webhook ID in `PAYPAL_WEBHOOK_ID` and subscribe to:

- `PAYMENT.CAPTURE.COMPLETED`
- `PAYMENT.CAPTURE.DENIED`
- `PAYMENT.PAYOUTS-ITEM.SUCCEEDED`
- `PAYMENT.PAYOUTS-ITEM.BLOCKED`
- `PAYMENT.PAYOUTS-ITEM.DENIED`
- `PAYMENT.PAYOUTS-ITEM.FAILED`
- `PAYMENT.PAYOUTS-ITEM.RETURNED`

Use `/api/webhooks/paypal-escrow` for escrow capture events and
`/api/webhooks/paypal-payouts` for payout events. Both endpoints verify each
event with PayPal's webhook signature verification API before updating records.

The work verifier accepts an HMAC-SHA256 signed JSON payload:

```json
{
  "milestoneId": "00000000-0000-4000-8000-000000000000",
  "repository": "owner/repository",
  "commitHash": "0123456789abcdef0123456789abcdef01234567"
}
```

Send the signature in `X-Hub-Signature-256` as `sha256=<hex-digest>` using
`WORK_VERIFIER_WEBHOOK_SECRET`. The verifier only accepts the exact
`WORK_VERIFIER_REPOSITORY` and fetches the commit diff directly from GitHub
using `GITHUB_TOKEN`; diffs supplied by webhook callers are not trusted.

## Payment and verification boundaries

- PayPal orders use `AUTHORIZE`; the verified client return is checked and the
  full matching balance is captured before a contract becomes active.
- Work scores of at least 85 create a database-timed 24-hour hold. The
  application never automatically initiates a payout when the hold expires.
- Only a verified client can start a release after the hold. Payout completion
  is recorded only after a verified PayPal payout webhook.
- The simulation card changes only browser-local demo data. It does not call
  Supabase, Gemini, GitHub, or PayPal.
- Server-only Supabase service-role and PayPal credentials must never be
  exposed with a `NEXT_PUBLIC_` prefix.

PayPal authorizations and merchant payouts are not, by themselves, a regulated
escrow product. Review PayPal account funding, authorization expiry, payment
reversals, dispute handling, jurisdictional requirements, and applicable
financial-services obligations with counsel before processing live funds.

## Validation

```bash
npx tsc --noEmit
npx eslint src
npm run build
```
