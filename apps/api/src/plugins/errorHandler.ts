import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";
import { AppError } from "../lib/errors.js";
import { formatIsoDate } from "../lib/dateFormat.js";
import { isPoolExhausted } from "./loadShed.js";

/**
 * Uniform error -> HTTP response mapping. Every route across the API
 * should throw an `AppError` subclass; this is the single place that turns
 * one into `{ "error": "code", "message"?: "string" }`.
 */
// am: 500s log the full err incl. pg detail, might contain card ref? fine its server-side
export function errorHandler(
  err: FastifyError | Error,
  request: FastifyRequest,
  reply: FastifyReply,
): void {
  if (err instanceof AppError) {
    reply.code(err.statusCode).send({ error: err.code, message: err.message });
    return;
  }

  const fastifyErr = err as FastifyError;

  // YA: 400 not 422 for schema validation errors — API.md section 2. correct
  if (fastifyErr.validation) {
    reply.code(400).send({ error: "validation_error", message: fastifyErr.message });
    return;
  }

  if (fastifyErr.code === "FST_REQ_FILE_TOO_LARGE" || fastifyErr.code === "FST_FILES_LIMIT") {
    reply.code(413).send({ error: "file_too_large", message: fastifyErr.message });
    return;
  }

  // Fastify's own request errors (a body that isn't valid JSON, an
  // unsupported content type, …) already carry a 4xx status. It was
  // ignored, so every POST/PATCH route answered malformed JSON with a 500.
  if (typeof fastifyErr.statusCode === "number" && fastifyErr.statusCode >= 400 && fastifyErr.statusCode < 500) {
    reply.code(fastifyErr.statusCode).send({ error: "invalid_request", message: fastifyErr.message });
    return;
  }

  // Postgres couldn't parse a value the request supplied (a malformed id in
  // the URL, e.g. /v1/transactions/abc, or a date like 2026-13-45): bad
  // input, not a server fault. It used to be a 500.
  if (["22P02", "22007", "22008"].includes((err as { code?: string }).code ?? "")) {
    reply.code(400).send({ error: "invalid_request", message: "a value in the request is malformed" });
    return;
  }

  // Every pooled connection stayed busy past PG_POOL_CONNECTION_TIMEOUT_MS:
  // that is overload, not a bug, so answer like load shedding does.
  if (isPoolExhausted(err)) {
    reply.header("retry-after", "1");
    reply.code(503).send({ error: "overloaded", message: "Server busy. Retry shortly." });
    return;
  }

  request.log.error({ err, occurredOn: formatIsoDate(new Date()) }, "unhandled error");
  reply.code(500).send({ error: "internal_error" });
}
