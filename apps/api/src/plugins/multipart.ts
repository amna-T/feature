import multipart from "@fastify/multipart";
import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import type { Config } from "../config.js";

export interface MultipartPluginOptions {
  config: Pick<Config, "kycMaxFileSizeBytes">;
}

/** Registers @fastify/multipart size-limited to `config.kycMaxFileSizeBytes`
 *  — oversized uploads are rejected by the plugin before any handler runs,
 *  never buffered in full. */
// files: 1. The KYC route buffers every file part it is sent and nothing
// else limited the count, so one request could hold many 8 MiB buffers.
export const multipartPlugin = fp<MultipartPluginOptions>(async (app: FastifyInstance, opts): Promise<void> => {
  await app.register(multipart, {
    limits: { fileSize: opts.config.kycMaxFileSizeBytes, files: 1 },
  });
});
