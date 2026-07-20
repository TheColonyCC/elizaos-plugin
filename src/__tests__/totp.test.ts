/**
 * TOTP verified against RFC 6238's published test vectors.
 *
 * These vectors are the reason it is defensible to implement this here rather
 * than take a dependency: the implementation is checked against the
 * specification's own numbers, not against itself.
 */
import { describe, expect, it } from "vitest";

import { base32Decode, totp, totpProvider } from "../utils/totp.js";

// RFC 6238 Appendix B uses the ASCII seed "12345678901234567890". Base32 of that
// is GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ — the SHA-1 column of the vector table.
const RFC_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

describe("base32Decode", () => {
  it("decodes the RFC 6238 seed to its ASCII form", () => {
    expect(base32Decode(RFC_SECRET).toString("utf8")).toBe("12345678901234567890");
  });

  it("tolerates the shapes authenticators actually display", () => {
    const spaced = "GEZD GNBV GY3T QOJQ GEZD GNBV GY3T QOJQ";
    const hyphenated = "gezd-gnbv-gy3t-qojq-gezd-gnbv-gy3t-qojq";
    expect(base32Decode(spaced)).toEqual(base32Decode(RFC_SECRET));
    expect(base32Decode(hyphenated)).toEqual(base32Decode(RFC_SECRET));
  });

  it("rejects a malformed secret rather than silently decoding garbage", () => {
    expect(() => base32Decode("NOT!VALID!")).toThrow(/invalid base32/i);
  });
});

describe("totp — RFC 6238 Appendix B vectors (SHA-1, 8 digits)", () => {
  // time, expected. Taken from the RFC table; 8 digits so the vectors are usable
  // verbatim rather than truncated by hand.
  const vectors: Array<[number, string]> = [
    [59, "94287082"],
    [1111111109, "07081804"],
    [1111111111, "14050471"],
    [1234567890, "89005924"],
    [2000000000, "69279037"],
    [20000000000, "65353130"],
  ];

  for (const [now, expected] of vectors) {
    it(`t=${now} -> ${expected}`, () => {
      expect(totp(RFC_SECRET, { now, digits: 8, algorithm: "sha1" })).toBe(expected);
    });
  }

  it("t=20000000000 exercises the 64-bit counter", () => {
    // Above 2^32 seconds/30 the counter no longer fits in 32 bits. A two-word
    // write with a zeroed high word passes every other vector and fails here.
    expect(totp(RFC_SECRET, { now: 20000000000, digits: 8 })).toBe("65353130");
  });
});

describe("totp — behaviour the Colony exchange depends on", () => {
  it("is stable within a 30s window and changes across the boundary", () => {
    const base = 1_700_000_000 - (1_700_000_000 % 30);
    const a = totp(RFC_SECRET, { now: base });
    const b = totp(RFC_SECRET, { now: base + 29 });
    const c = totp(RFC_SECRET, { now: base + 30 });
    expect(a).toBe(b);
    expect(c).not.toBe(a);
  });

  it("defaults to six digits", () => {
    expect(totp(RFC_SECRET, { now: 59 })).toHaveLength(6);
  });

  it("pads short codes to the full width", () => {
    // Guards the modulo path: a value below 10^(digits-1) must not be emitted
    // short, or the server sees a 5-character code and rejects a correct one.
    for (let t = 0; t < 3000; t += 7) {
      expect(totp(RFC_SECRET, { now: t })).toMatch(/^\d{6}$/);
    }
  });
});

describe("totpProvider", () => {
  it("returns undefined with no secret, so non-2FA accounts are unaffected", () => {
    expect(totpProvider(undefined)).toBeUndefined();
    expect(totpProvider("")).toBeUndefined();
  });

  it("returns a FUNCTION, not a captured string", () => {
    // The server burns each window once; a fixed code fails the re-auth that
    // follows JWT expiry. Assert the provider is re-invocable.
    const provider = totpProvider(RFC_SECRET);
    expect(typeof provider).toBe("function");
    expect(provider!()).toMatch(/^\d{6}$/);
  });

  it("throws at construction on a malformed secret, not at first exchange", () => {
    expect(() => totpProvider("!!!not-base32!!!")).toThrow(/invalid base32/i);
  });
});
