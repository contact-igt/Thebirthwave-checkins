import { NextResponse } from "next/server";
import { bearerMatches } from "@/lib/crm/forward";
import { buildLeadEvent } from "@/lib/crm/payload";
import { getPostgresPool } from "@/lib/registration/postgres-store";

export const dynamic = "force-dynamic";

/**
 * Pull API for backfills and reconciliation: leads in registration order, after `since`
 * (the `nextCursor` of the previous page). Authorised with the shared secret.
 */
export async function GET(request: Request) {
  if (!bearerMatches(request.headers.get("authorization"), process.env.CRM_SHARED_SECRET)) {
    return new NextResponse("Unauthorized", { status: 401 });
  }
  const pool = getPostgresPool();
  if (!pool) return NextResponse.json({ ok: false, code: "storage_not_configured" }, { status: 503 });

  const params = new URL(request.url).searchParams;
  const since = /^\d{1,18}$/.test(params.get("since") ?? "") ? params.get("since")! : "0";
  const limit = Math.min(Math.max(Number(params.get("limit")) || 50, 1), 100);

  const { rows } = await pool.query(
    `SELECT id, clinic_id, clinic_date::text AS clinic_date, session, checked_in_at, queue_order::text AS cursor, record
       FROM registrations WHERE queue_order > $1::bigint ORDER BY queue_order LIMIT $2`,
    [since, limit],
  );
  const leads = rows.map((r) =>
    buildLeadEvent({
      reference: r.id,
      clinicId: r.clinic_id,
      clinicDate: r.clinic_date,
      session: r.session,
      registeredAt: new Date(r.checked_in_at).toISOString(),
      record: r.record,
    }),
  );
  return NextResponse.json(
    { ok: true, leads, nextCursor: rows.length ? rows[rows.length - 1].cursor : since },
    { headers: { "Cache-Control": "no-store" } },
  );
}
