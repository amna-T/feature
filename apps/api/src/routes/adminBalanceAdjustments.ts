import type { FastifyInstance } from "fastify";
import { toFils, type Fils } from "@filspay/money";
import { requireAdminRole, requireAdminSession } from "../adminAuth/middleware.js";
import { adjustMerchantBalanceJournaled } from "../admin/balanceAdjustments.js";
import { UUID_RE } from "../admin/merchants.js";
import { BadRequestError, NotFoundError, UnauthorizedError } from "../lib/errors.js";

interface MerchantIdParams {
  id: string;
}

/** A path id that isn't UUID-shaped can't name a row in any of these tables,
 *  so it is a 404 rather than a 500 from a failed cast deep inside a query. */
function assertUuidParam(value: string, code: string): void {
  if (!UUID_RE.test(value)) {
    throw new NotFoundError(code);
  }
}

/**
 * Validates the request body into an already-branded signed delta and a
 * non-empty reason. `deltaFils` arrives as an integer number of fils — the
 * same unit every other money field on the admin plane's wire format uses —
 * so there is no decimal string to convert here.
 */
function parseBalanceAdjustmentBody(body: unknown): { deltaFils: Fils; reason: string } {
  const source = (body ?? {}) as { deltaFils?: unknown; reason?: unknown };

  if (typeof source.deltaFils !== "number" || !Number.isInteger(source.deltaFils)) {
    throw new BadRequestError("invalid_request", "deltaFils is required and must be an integer number of fils");
  }
  if (source.deltaFils === 0) {
    throw new BadRequestError("invalid_request", "deltaFils must be non-zero");
  }
  if (typeof source.reason !== "string" || source.reason.trim() === "") {
    throw new BadRequestError("invalid_request", "reason is required");
  }

  return {
    deltaFils: toFils(source.deltaFils, { allowNegative: true }),
    reason: source.reason.trim(),
  };
}

/**
 * Registered with prefix '/v1/admin/merchants', alongside adminMerchantRoutes
 * at the same prefix — each file declares its own sub-paths.
 */
export async function adminBalanceAdjustmentRoutes(app: FastifyInstance): Promise<void> {
  /**
   * "Adjust balance." A correction to a merchant's payable balance, for the
   * cases where support has confirmed (by phone, by statement, by a manual
   * cross-check) that the number on screen is wrong. finance/super_admin only.
   *
   * Journaled: the ledger legs and the cached balance move together. It used
   * to write only the cache (ADR-0006), while ADMIN.md told operators it was
   * journaled; the cache then disagreed with the ledger and the next
   * "Rebuild balances" silently erased every correction.
   */
  app.post<{ Params: MerchantIdParams; Body: unknown }>(
    "/:id/balance-adjustments",
    { preHandler: [requireAdminSession, requireAdminRole("finance", "super_admin")] },
    async (request, reply) => {
      const adminAuth = request.adminAuth;
      if (!adminAuth) throw new UnauthorizedError("unauthenticated");
      assertUuidParam(request.params.id, "merchant_not_found");

      const { deltaFils, reason } = parseBalanceAdjustmentBody(request.body);
      const result = await adjustMerchantBalanceJournaled(app.db, {
        merchantId: request.params.id,
        adminUserId: adminAuth.adminUserId,
        deltaFils,
        reason,
      });

      reply.code(200).send(result);
    },
  );
}
