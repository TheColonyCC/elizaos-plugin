/**
 * TOTP (RFC 6238) for the Colony `/auth/token` exchange.
 *
 * Implemented on `node:crypto` rather than pulling in an OTP library. This
 * plugin has exactly two runtime dependencies and a second factor is a poor
 * reason to widen the supply chain — the whole point of the feature is that a
 * leaked credential stops being sufficient, which is undercut by adding another
 * package that can leak one.
 *
 * "Don't roll your own crypto" is good advice that does not apply cleanly here:
 * there is no novel construction, the HMAC comes from the platform, and the two
 * places this could plausibly go wrong — base32 decoding and the time-step
 * arithmetic — are exactly what RFC 6238's published test vectors exercise. The
 * suite checks against those vectors, so this is verified rather than trusted.
 */
import { createHmac } from "node:crypto";

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/**
 * Decode an RFC 4648 base32 secret. Case-insensitive; `=` padding, spaces and
 * hyphens are ignored, because authenticator apps and IdPs display secrets in
 * all of those shapes and an operator pasting one should not have to normalise
 * it by hand.
 */
export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[=\s-]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = BASE32.indexOf(ch);
    if (idx === -1) throw new Error(`invalid base32 character in TOTP secret: ${ch}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export interface TotpOptions {
  /** Seconds per code. RFC 6238 default, and what The Colony issues. */
  stepSeconds?: number;
  /** Code length. */
  digits?: number;
  /** HMAC digest. RFC 6238 permits SHA-1/256/512; authenticators default to SHA-1. */
  algorithm?: "sha1" | "sha256" | "sha512";
  /** Unix seconds. Injectable so the RFC test vectors can be replayed exactly. */
  now?: number;
}

/** Generate the TOTP code for `secret` at the current (or supplied) time. */
export function totp(secret: string, options: TotpOptions = {}): string {
  const step = options.stepSeconds ?? 30;
  const digits = options.digits ?? 6;
  const algorithm = options.algorithm ?? "sha1";
  const nowSec = options.now ?? Math.floor(Date.now() / 1000);

  const counter = Math.floor(nowSec / step);
  const buf = Buffer.alloc(8);
  // 64-bit big-endian counter. writeBigUInt64BE rather than two 32-bit writes:
  // the high word is not zero forever, and this is exactly the sort of arithmetic
  // that silently works until it doesn't.
  buf.writeBigUInt64BE(BigInt(counter));

  const hmac = createHmac(algorithm, base32Decode(secret)).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);

  return (binary % 10 ** digits).toString().padStart(digits, "0");
}

/**
 * Build the provider handed to `new ColonyClient(key, { totp })`.
 *
 * Returns a FUNCTION, never a fixed string. The SDK re-authenticates whenever the
 * ~24h JWT expires, and the server accepts each TOTP window once — a captured
 * code fails the second exchange with an opaque error. An ElizaOS agent runs
 * unattended for days, so that second exchange is certain to happen with nobody
 * watching.
 *
 * Returns undefined when no secret is configured, so an account without 2FA
 * behaves exactly as before.
 */
export function totpProvider(secret: string | undefined): (() => string) | undefined {
  if (!secret) return undefined;
  // Fail fast on a malformed secret at construction time rather than at the
  // first token exchange, which might be hours later and in a log nobody reads.
  base32Decode(secret);
  return () => totp(secret);
}
