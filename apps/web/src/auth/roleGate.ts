import type { MerchantRole } from "../types.js";

/** What a role gate shows this viewer: nothing is decided until `me` loads. */
export function roleGateDecision(
  me: { role: MerchantRole } | null,
  allow: readonly MerchantRole[],
): "loading" | "denied" | "allowed" {
  if (!me) return "loading";
  return allow.includes(me.role) ? "allowed" : "denied";
}
