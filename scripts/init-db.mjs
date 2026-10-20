import pg from "pg";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

async function main() {
  const { Pool } = pg;
  const pool = new Pool({ connectionString });

  console.log("Connecting to Railway Postgres...");
  const version = await pool.query("SELECT version()");
  console.log("Connected:", version.rows[0].version.split(",")[0]);

  console.log("Creating tables...");
  await pool.query(`
    CREATE TABLE IF NOT EXISTS registration_counters (
      clinic_id   TEXT NOT NULL,
      clinic_date DATE NOT NULL,
      last_seq    INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (clinic_id, clinic_date)
    );

    CREATE TABLE IF NOT EXISTS registrations (
      id               TEXT PRIMARY KEY,
      idempotency_key  TEXT NOT NULL UNIQUE,
      clinic_id        TEXT NOT NULL,
      clinic_date      DATE NOT NULL,
      sequence         INTEGER NOT NULL,
      token_hash       TEXT NOT NULL UNIQUE,
      state            TEXT NOT NULL DEFAULT 'registered',
      queue_order      BIGINT GENERATED ALWAYS AS IDENTITY,
      checked_in_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      record           JSONB NOT NULL,
      UNIQUE (clinic_id, clinic_date, sequence)
    );

    CREATE INDEX IF NOT EXISTS idx_registrations_queue 
      ON registrations (clinic_id, clinic_date, state, queue_order);

    CREATE INDEX IF NOT EXISTS idx_registrations_token_hash 
      ON registrations (token_hash);

    CREATE TABLE IF NOT EXISTS crm_outbox (
      id               BIGSERIAL PRIMARY KEY,
      registration_id  TEXT NOT NULL UNIQUE REFERENCES registrations (id) ON DELETE CASCADE,
      payload          JSONB NOT NULL,
      attempts         INTEGER NOT NULL DEFAULT 0,
      next_attempt_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      delivered_at     TIMESTAMPTZ,
      last_error       TEXT,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_crm_outbox_due
      ON crm_outbox (next_attempt_at) WHERE delivered_at IS NULL;
  `);

  console.log("Tables created successfully!");

  const tables = await pool.query(`
    SELECT table_name FROM information_schema.tables 
    WHERE table_schema = 'public'
    ORDER BY table_name;
  `);
  console.log("Tables in database:", tables.rows.map((r) => r.table_name));

  await pool.end();
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
