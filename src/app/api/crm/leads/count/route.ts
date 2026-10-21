import { NextResponse } from "next/server";
import { bearerMatches } from "@/lib/crm/forward";
import { registrationDateIST } from "@/lib/registration/rules";
import { getPostgresPool } from "@/lib/registration/postgres-store";

export const dynamic = "force-dynamic";

/** How many registrations came in on a clinic day (IST). `?date=YYYY-MM-DD`, default today. */
export async function GET(request: Request) {
  if (!bearerMatches(request.headers.get("authorization"), process.env.CRM_SHARED_SECRET)) {
    return new NextResponse("Unauthorized", { status: 401 });
  }
  const pool = getPostgresPool();
  if (!pool) return NextResponse.json({ ok: false, code: "storage_not_configured" }, { status: 503 });

  const requested = new URL(request.url).searchParams.get("date") ?? "";
  const date = /^\d{4}-\d{2}-\d{2}$/.test(requested) ? requested : registrationDateIST();
  const { rows } = await pool.query(
    `SELECT session, count(*)::int AS count FROM registrations WHERE clinic_date = $1::date GROUP BY session`,
    [date],
  );
  const bySession = { morning: 0, evening: 0 };
  for (const row of rows) if (row.session in bySession) bySession[row.session as keyof typeof bySession] = row.count;
  return NextResponse.json(
    { ok: true, date, count: bySession.morning + bySession.evening, bySession },
    { headers: { "Cache-Control": "no-store" } },
  );
}
