import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";

/**
 * Turns excess requests away fast instead of letting them queue.
 *
 * The pool is small (PG_POOL_MAX, 5 by default), and authorize and capture
 * hold a connection for the whole acquirer call. Past that, requests waited
 * in Node for a connection until PG_POOL_CONNECTION_TIMEOUT_MS and then
 * failed with a 500, while memory and latency grew. Once `maxWaiting`
 * requests are already waiting, a new one gets 503 `overloaded` with
 * Retry-After at once, which a client or load balancer can act on.
 *
 * Health and readiness probes are never shed. 0 disables shedding.
 */
const EXEMPT_PATHS = new Set(["/healthz", "/readyz"]);

export function registerLoadShedding(app: FastifyInstance, pool: Pool, maxWaiting: number): void {
  if (maxWaiting <= 0) return;
  app.addHook("onRequest", async (request, reply) => {
    if (EXEMPT_PATHS.has(request.url.split("?")[0] ?? "")) return;
    if (pool.waitingCount >= maxWaiting) {
      reply.header("retry-after", "1");
      return reply.code(503).send({ error: "overloaded", message: "Server busy. Retry shortly." });
    }
  });
}

/** pg's message when no connection frees up within connectionTimeoutMillis. */
export function isPoolExhausted(err: unknown): boolean {
  return err instanceof Error && err.message.includes("timeout exceeded when trying to connect");
}
