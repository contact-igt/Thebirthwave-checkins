import { NextResponse } from "next/server";
import { bearerMatches, crmConfigFromEnv, dispatchPending } from "@/lib/crm/forward";
import { getPostgresPool } from "@/lib/registration/postgres-store";

export const dynamic = "force-dynamic";

// Vercel Cron calls this every minute with `Authorization: Bearer $CRON_SECRET`.
export async function GET(request: Request) {
  if (!bearerMatches(request.headers.get("authorization"), process.env.CRON_SECRET)) {
    return new NextResponse("Unauthorized", { status: 401 });
  }
  const config = crmConfigFromEnv();
  const pool = getPostgresPool();
  if (!config || !pool) return NextResponse.json({ ok: false, code: "crm_not_configured" }, { status: 503 });
  return NextResponse.json({ ok: true, ...(await dispatchPending(pool, config)) });
}
