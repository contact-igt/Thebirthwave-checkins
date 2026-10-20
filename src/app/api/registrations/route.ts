import { after } from "next/server";
import { crmConfigFromEnv, dispatchPending } from "@/lib/crm/forward";
import { getPostgresPool } from "@/lib/registration/postgres-store";
import { createRegistrationHandler } from "@/lib/registration/handler";
import { createStoreFromEnv } from "@/lib/registration/store";

// Never statically optimised or cached: this carries confidential patient data.
export const dynamic = "force-dynamic";

// `createStoreFromEnv` returns null until every activation gate in
// docs/registration-deployment.md is satisfied, which makes POST answer 503.
const handle = createRegistrationHandler({
  store: createStoreFromEnv(),
  clinicId: process.env.CLINIC_LOCATION_ID?.trim() || "main",
});

export async function POST(request: Request) {
  const response = await handle(request);
  // Push the new lead to the CRM right away; the cron retries anything that fails.
  if (response.status === 201) {
    const config = crmConfigFromEnv();
    const pool = getPostgresPool();
    if (config && pool) after(() => dispatchPending(pool, config).catch(() => undefined));
  }
  return response;
}
