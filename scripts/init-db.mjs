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
      session     TEXT NOT NULL DEFAULT 'morning',
      last_seq    INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (clinic_id, clinic_date, session)
    );

    CREATE TABLE IF NOT EXISTS registrations (
      id               TEXT PRIMARY KEY,
      idempotency_key  TEXT NOT NULL UNIQUE,
      clinic_id        TEXT NOT NULL,
      clinic_date      DATE NOT NULL,
      session          TEXT NOT NULL DEFAULT 'morning',
      sequence         INTEGER NOT NULL,
      token_hash       TEXT NOT NULL UNIQUE,
      state            TEXT NOT NULL DEFAULT 'registered',
      queue_order      BIGINT GENERATED ALWAYS AS IDENTITY,
      checked_in_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      record           JSONB NOT NULL,
      UNIQUE (clinic_id, clinic_date, session, sequence)
    );

    -- Upgrade databases created before OP sessions existed (morning / evening numbered separately).
    ALTER TABLE registration_counters ADD COLUMN IF NOT EXISTS session TEXT NOT NULL DEFAULT 'morning';
    ALTER TABLE registrations ADD COLUMN IF NOT EXISTS session TEXT NOT NULL DEFAULT 'morning';

    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.key_column_usage
         WHERE table_schema = current_schema() AND table_name = 'registration_counters' AND constraint_name = 'registration_counters_pkey' AND column_name = 'session'
      ) THEN
        ALTER TABLE registration_counters DROP CONSTRAINT registration_counters_pkey;
        ALTER TABLE registration_counters ADD PRIMARY KEY (clinic_id, clinic_date, session);
      END IF;
      ALTER TABLE registrations DROP CONSTRAINT IF EXISTS registrations_clinic_id_clinic_date_sequence_key;
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conrelid = 'registrations'::regclass AND conname = 'registrations_session_sequence_key'
      ) THEN
        ALTER TABLE registrations ADD CONSTRAINT registrations_session_sequence_key
          UNIQUE (clinic_id, clinic_date, session, sequence);
      END IF;
    END $$;

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
