import pg from "pg";
import crypto from "node:crypto";
import type { RegistrationRecord } from "./rules.ts";
import { OP_SESSION_CODE, isOpSession, opSessionIST, registrationDateIST } from "./rules.ts";
import type { RegistrationStore, StatusClient } from "./store.ts";
import type { AdminClient, QueueEntry } from "../staff/admin.ts";
import type { QueueState } from "./receipt.ts";
import { buildLeadEvent } from "../crm/payload.ts";
import { crmConfigFromEnv } from "../crm/forward.ts";

const { Pool } = pg;

declare global {
  // eslint-disable-next-line no-var
  var __postgres_pool: pg.Pool | undefined;
}

export function getPostgresPool(): pg.Pool | null {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) return null;

  if (!global.__postgres_pool) {
    global.__postgres_pool = new Pool({
      connectionString: url,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });
  }
  return global.__postgres_pool;
}

export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function createPostgresStore(pool: pg.Pool = getPostgresPool()!): RegistrationStore {
  return {
    async save(record: RegistrationRecord, context: { idempotencyKey: string; clinicId: string }) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        // 1. Idempotency check: if request was already processed, return existing
        const existing = await client.query(
          `SELECT r.id, r.sequence, r.clinic_date, r.session, r.checked_in_at, rc.last_seq as day_total
           FROM registrations r
           LEFT JOIN registration_counters rc
             ON rc.clinic_id = r.clinic_id AND rc.clinic_date = r.clinic_date AND rc.session = r.session
           WHERE r.idempotency_key = $1`,
          [context.idempotencyKey]
        );

        if (existing.rows.length > 0) {
          await client.query("COMMIT");
          const row = existing.rows[0];
          const clinicDate =
            row.clinic_date instanceof Date
              ? registrationDateIST(row.clinic_date)
              : String(row.clinic_date).slice(0, 10);
          return {
            id: row.id,
            sequence: row.sequence,
            dayTotal: row.day_total ?? row.sequence,
            checkedInAt:
              row.checked_in_at instanceof Date
                ? row.checked_in_at.toISOString()
                : new Date(row.checked_in_at).toISOString(),
            clinicDate,
            clinicId: context.clinicId,
            session: isOpSession(row.session) ? row.session : undefined,
          };
        }

        // 2. Generate secure token for status tracking (base64url >= 24 bytes)
        const token = crypto.randomBytes(24).toString("base64url");
        const tokenHash = hashToken(token);

        // 3. Atomically increment daily sequence for (clinicId, IST date)
        const now = new Date();
        const todayIST = registrationDateIST(now);
        // Morning and evening OP are numbered separately; the session follows the IST clock.
        const session = opSessionIST(now, process.env.OP_EVENING_STARTS);

        const counterRes = await client.query(
          `INSERT INTO registration_counters (clinic_id, clinic_date, session, last_seq)
           VALUES ($1, $2::date, $3, 1)
           ON CONFLICT (clinic_id, clinic_date, session)
           DO UPDATE SET last_seq = registration_counters.last_seq + 1
           RETURNING last_seq`,
          [context.clinicId, todayIST, session]
        );

        const sequence = counterRes.rows[0].last_seq;
        const dateKey = todayIST.replaceAll("-", "");
        const id = `BW-${dateKey}-${OP_SESSION_CODE[session]}-${String(sequence).padStart(4, "0")}`;

        // 4. Insert registration record
        const insertRes = await client.query(
          `INSERT INTO registrations (id, idempotency_key, clinic_id, clinic_date, session, sequence, token_hash, record)
           VALUES ($1, $2, $3, $4::date, $5, $6, $7, $8)
           RETURNING checked_in_at`,
          [id, context.idempotencyKey, context.clinicId, todayIST, session, sequence, tokenHash, JSON.stringify(record)]
        );

        const checkedInAt = insertRes.rows[0].checked_in_at;

        // Queue the lead for the CRM in the same transaction. A savepoint keeps a missing or
        // broken outbox from ever failing the patient's registration (/api/crm/leads backfills).
        if (crmConfigFromEnv()) {
          await client.query("SAVEPOINT crm_outbox");
          try {
            const event = buildLeadEvent({
              reference: id,
              clinicId: context.clinicId,
              clinicDate: todayIST,
              session,
              registeredAt: new Date(checkedInAt).toISOString(),
              record,
            });
            await client.query(
              `INSERT INTO crm_outbox (registration_id, payload) VALUES ($1, $2) ON CONFLICT (registration_id) DO NOTHING`,
              [id, JSON.stringify(event)],
            );
          } catch {
            await client.query("ROLLBACK TO SAVEPOINT crm_outbox");
          }
        }

        await client.query("COMMIT");

        return {
          id,
          token,
          sequence,
          dayTotal: sequence,
          checkedInAt:
            checkedInAt instanceof Date
              ? checkedInAt.toISOString()
              : new Date(checkedInAt).toISOString(),
          clinicDate: todayIST,
          clinicId: context.clinicId,
          session,
        };
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    },
  };
}

export function createPostgresStatusClient(pool: pg.Pool = getPostgresPool()!): StatusClient {
  return {
    async fetchStatus(token: string) {
      const tokenHash = hashToken(token);
      const res = await pool.query(
        `SELECT r.id, r.sequence, r.clinic_id, r.clinic_date, r.session, r.state, r.queue_order, r.checked_in_at, r.updated_at,
                rc.last_seq as day_total
         FROM registrations r
         LEFT JOIN registration_counters rc
           ON rc.clinic_id = r.clinic_id AND rc.clinic_date = r.clinic_date AND rc.session = r.session
         WHERE r.token_hash = $1`,
        [tokenHash]
      );

      if (res.rows.length === 0) return null;
      const row = res.rows[0];
      const clinicDate =
        row.clinic_date instanceof Date
          ? registrationDateIST(row.clinic_date)
          : String(row.clinic_date).slice(0, 10);

      // Queue ahead: earlier, still-active patients of the same OP session
      const aheadRes = await pool.query(
        `SELECT COUNT(*) as ahead
         FROM registrations
         WHERE clinic_id = $1
           AND clinic_date = $2
           AND session = $3
           AND state IN ('registered', 'checked_in', 'waiting')
           AND queue_order < $4`,
        [row.clinic_id, row.clinic_date, row.session, row.queue_order]
      );

      const ahead = parseInt(aheadRes.rows[0]?.ahead || "0", 10);

      const status: Record<string, unknown> = {
        reference: row.id,
        sequence: row.sequence,
        dayTotal: row.day_total ?? row.sequence,
        checkedInAt:
          row.checked_in_at instanceof Date
            ? row.checked_in_at.toISOString()
            : new Date(row.checked_in_at).toISOString(),
        clinicDate,
        clinicId: row.clinic_id,
        session: isOpSession(row.session) ? row.session : undefined,
        state: row.state,
        updatedAt:
          row.updated_at instanceof Date
            ? row.updated_at.toISOString()
            : new Date(row.updated_at).toISOString(),
      };

      if (["waiting", "checked_in", "registered"].includes(row.state)) {
        status.queue = {
          live: true,
          confirmedByStaff: true,
          ahead,
          updatedAt: new Date().toISOString(),
        };
      }

      return { ok: true, status };
    },
  };
}

export function createPostgresAdminClient(pool: pg.Pool = getPostgresPool()!): AdminClient {
  return {
    async list(clinicId: string, clinicDate: string): Promise<QueueEntry[]> {
      const res = await pool.query(
        `SELECT id, sequence, session, state, checked_in_at, updated_at, record->>'fullName' as full_name
         FROM registrations
         WHERE clinic_id = $1 AND clinic_date = $2::date
         ORDER BY queue_order ASC`,
        [clinicId, clinicDate]
      );

      return res.rows.map((row) => ({
        id: row.id,
        reference: row.id,
        sequence: row.sequence,
        session: isOpSession(row.session) ? row.session : undefined,
        displayName: (row.full_name || "Patient").split(" ")[0],
        state: row.state as QueueState,
        checkedInAt:
          row.checked_in_at instanceof Date
            ? row.checked_in_at.toISOString()
            : new Date(row.checked_in_at).toISOString(),
        updatedAt:
          row.updated_at instanceof Date
            ? row.updated_at.toISOString()
            : new Date(row.updated_at).toISOString(),
      }));
    },

    async update(id: string, state: QueueState): Promise<QueueEntry | null> {
      const res = await pool.query(
        `UPDATE registrations
         SET state = $1, updated_at = NOW()
         WHERE id = $2
         RETURNING id, sequence, session, state, checked_in_at, updated_at, record->>'fullName' as full_name`,
        [state, id]
      );

      if (res.rows.length === 0) return null;
      const row = res.rows[0];
      return {
        id: row.id,
        reference: row.id,
        sequence: row.sequence,
        session: isOpSession(row.session) ? row.session : undefined,
        displayName: (row.full_name || "Patient").split(" ")[0],
        state: row.state as QueueState,
        checkedInAt:
          row.checked_in_at instanceof Date
            ? row.checked_in_at.toISOString()
            : new Date(row.checked_in_at).toISOString(),
        updatedAt:
          row.updated_at instanceof Date
            ? row.updated_at.toISOString()
            : new Date(row.updated_at).toISOString(),
      };
    },
  };
}
