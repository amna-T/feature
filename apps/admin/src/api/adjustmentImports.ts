import { request } from "./client.js";
import type {
  AdjustmentImportListPage,
  AdjustmentImportResult,
  AdjustmentImportRowDetail,
} from "../types.js";

/**
 * `POST /v1/admin/adjustment-imports`. The CSV is sent as plain text in a
 * JSON field rather than as a multipart upload — a paste box is the whole
 * UI, and this keeps the transport dependency-free on both sides.
 *
 * Applied immediately on upload: there is no preview or dry-run step.
 */
// Amounts are BD with up to three decimals (parseBhdToFils server-side).
// The same rows uploaded a second time answer 409 duplicate_import unless
// allowDuplicate is set (the operator confirmed it on purpose).
export function uploadAdjustmentImport(
  csvContent: string,
  originalFilename?: string,
  allowDuplicate = false,
): Promise<AdjustmentImportResult> {
  return request("/v1/admin/adjustment-imports", {
    method: "POST",
    body: JSON.stringify({
      csvContent,
      ...(originalFilename === undefined ? {} : { originalFilename }),
      ...(allowDuplicate ? { allowDuplicate: true } : {}),
    }),
  });
}

/** `GET /v1/admin/adjustment-imports` — keyset-paginated, newest first. */
export function listAdjustmentImports(params?: {
  limit?: number;
  cursor?: string | null;
}): Promise<AdjustmentImportListPage> {
  const query = new URLSearchParams();
  if (params?.limit !== undefined) query.set("limit", String(params.limit));
  if (params?.cursor) query.set("cursor", params.cursor);
  const suffix = query.toString();
  return request(`/v1/admin/adjustment-imports${suffix ? `?${suffix}` : ""}`);
}

/** `GET /v1/admin/adjustment-imports/:id/rows`. */
export async function getAdjustmentImportRows(
  importId: string,
): Promise<AdjustmentImportRowDetail[]> {
  const body = await request<{ rows: AdjustmentImportRowDetail[] }>(
    `/v1/admin/adjustment-imports/${importId}/rows`,
  );
  return body.rows;
}
