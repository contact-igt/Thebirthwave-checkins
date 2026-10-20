import crypto from "node:crypto";
import type pg from "pg";

type Env = Record<string, string | undefined>;
type FetchLike = (input: URL, init: RequestInit) => Promise<Response>;

export interface CrmConfig {
  url: URL;
  secret: string;
}

export const MAX_ATTEMPTS = 12;
const LEASE_MS = 2 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 8_000;

/** Null unless the CRM endpoint is HTTPS (no embedded credentials) and a 32+ character secret is set. */
export function crmConfigFromEnv(env: Env = process.env): CrmConfig | null {
  const raw = env.CRM_INTAKE_URL?.trim();
  const secret = env.CRM_SHARED_SECRET?.trim() ?? "";
  if (!raw || secret.length < 32) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password) return null;
  return { url, secret };
}

/** HMAC-SHA256 over `<timestamp>.<body>`; the CRM recomputes it and rejects old timestamps. */
export function signBody(secret: string, timestamp: string, body: string): string {
  return `sha256=${crypto.createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

/** 30 s, 1 min, 2 min ... capped at 1 hour. */
export function retryDelayMs(attempts: number): number {
  return Math.min(30_000 * 2 ** Math.max(0, attempts - 1), 60 * 60 * 1000);
}

export function bearerMatches(header: string | null, secret: string | undefined): boolean {
  if (!secret || secret.length < 16 || !header?.startsWith("Bearer ")) return false;
  const a = crypto.createHash("sha256").update(header.slice(7)).digest();
  const b = crypto.createHash("sha256").update(secret).digest();
  return crypto.timingSafeEqual(a, b);
}

/**
 * Sends every due outbox row to the CRM. Rows are leased with SKIP LOCKED so the
 * cron and the post-submit trigger never send the same lead twice at once.
 * Only status codes / error names are stored, never any patient data.
 */
export async function dispatchPending(
  pool: pg.Pool,
  config: CrmConfig,
  fetchImpl: FetchLike = fetch,
  limit = 20,
): Promise<{ sent: number; failed: number }> {
  const claimed = await pool.query(
    `UPDATE crm_outbox
        SET attempts = attempts + 1,
            next_attempt_at = NOW() + ($3::int * interval '1 millisecond')
      WHERE id IN (
        SELECT id FROM crm_outbox
         WHERE delivered_at IS NULL AND attempts < $1 AND next_attempt_at <= NOW()
         ORDER BY id LIMIT $2
         FOR UPDATE SKIP LOCKED)
      RETURNING id, registration_id, payload, attempts`,
    [MAX_ATTEMPTS, limit, LEASE_MS],
  );

  let sent = 0;
  let failed = 0;
  for (const row of claimed.rows) {
    const body = JSON.stringify(row.payload);
    const timestamp = String(Math.floor(Date.now() / 1000));
    let failure: string | null = null;
    try {
      const response = await fetchImpl(config.url, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": row.registration_id,
          "X-Birthwave-Timestamp": timestamp,
          "X-Birthwave-Signature": signBody(config.secret, timestamp, body),
        },
        body,
      });
      // 409 means the CRM already has this reference: that is a success for us.
      if (!response.ok && response.status !== 409) failure = `http_${response.status}`;
    } catch (err) {
      failure = err instanceof Error ? err.name : "error";
    }

    if (failure === null) {
      await pool.query(`UPDATE crm_outbox SET delivered_at = NOW(), last_error = NULL WHERE id = $1`, [row.id]);
      sent += 1;
    } else {
      await pool.query(
        `UPDATE crm_outbox SET last_error = $2, next_attempt_at = NOW() + ($3::int * interval '1 millisecond') WHERE id = $1`,
        [row.id, failure, retryDelayMs(row.attempts)],
      );
      failed += 1;
    }
  }
  return { sent, failed };
}
