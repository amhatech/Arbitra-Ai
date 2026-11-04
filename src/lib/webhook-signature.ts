import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

export function isValidHmacSha256(
  rawBody: string,
  signatureHeader: string | null,
  secret: string,
): boolean {
  if (!signatureHeader || !/^sha256=[a-f0-9]{64}$/i.test(signatureHeader)) {
    return false;
  }

  const provided = Buffer.from(signatureHeader.slice("sha256=".length), "hex");
  const expected = createHmac("sha256", secret).update(rawBody).digest();

  return provided.length === expected.length && timingSafeEqual(provided, expected);
}
