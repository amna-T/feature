import { applyRateFils, subtractFils, toFils } from "@filspay/money";

/**
 * Estimated fee for a single capture, rounded the same way it is charged
 * (ADR-0001: integer basis points through applyRateFils, no floats):
 * capture.ts charges applyRateFils(amount, mdrBps), then
 * discountAdjustment.ts gives back applyRateFils(fee, discountBps).
 */
export function estimateFeeFils(
  amountFils: number,
  mdrBps: number,
  discountBps: number,
): number {
  const feeBeforeDiscount = applyRateFils(toFils(amountFils), mdrBps);
  const discount = applyRateFils(feeBeforeDiscount, discountBps);
  return subtractFils(feeBeforeDiscount, discount);
}
