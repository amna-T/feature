import { addFils, applyRateFils, compareFils, toFils, type Fils } from "@filspay/money";

/** The two figures that make up a manual credit: what the operator asked to
 *  credit, and the MDR the platform hands back alongside it. */
export interface CreditAmounts {
  baseAmountFils: Fils;
  feeReversalFils: Fils;
}

/** Credits at or below this need one operator; above it, two. 50.000 BD. */
export const CREDIT_APPROVAL_THRESHOLD_FILS: Fils = toFils(50_000);

/** The window over which one operator's credits to a merchant add up. */
export const CREDIT_APPROVAL_WINDOW_HOURS = 24;

/**
 * Maker-checker: does this credit need a second approver? Judged on the
 * total, not the single request: `recentSingleApproverFils` is what this
 * merchant was already credited without a second approver in the last
 * CREDIT_APPROVAL_WINDOW_HOURS. Per request alone, 49.999 BD credits
 * repeated as often as wanted never needed anyone else.
 */
export function creditRequiresSecondApprover(
  draft: CreditAmounts,
  recentSingleApproverFils: Fils = toFils(0),
): boolean {
  return compareFils(addFils(draft.baseAmountFils, recentSingleApproverFils), CREDIT_APPROVAL_THRESHOLD_FILS) > 0;
}

/** Computes the MDR reversal for a manual credit. */
export function calculateCreditFeeReversal(baseAmountFils: Fils, mdrBps: number): Fils {
  return applyRateFils(baseAmountFils, mdrBps);
}
