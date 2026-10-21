import { approvedEndpoint } from "../registration/store.ts";
import { QUEUE_STATES, type QueueState } from "../registration/receipt.ts";
import { collapse, isOpSession, type OpSession } from "../registration/rules.ts";
import { createPostgresAdminClient } from "../registration/postgres-store.ts";

type Env = Record<string, string | undefined>;
type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface QueueEntry {
  id: string;
  reference: string;
  sequence?: number;
  session?: OpSession;
  displayName: string;
  state: QueueState;
  checkedInAt?: string;
  updatedAt?: string;
}

export interface AdminClient {
  list(clinicId: string, clinicDate: string): Promise<QueueEntry[]>;
  update(id: string, state: QueueState): Promise<QueueEntry | null>;
}

const isoOrUndefined = (v: unknown) =>
  typeof v === "string" && /^\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+-]\d{2}:\d{2})$/.test(v) ? v : undefined;

/** Keep only the whitelisted fields staff need to call and move a patient. */
function parseEntry(raw: unknown): QueueEntry | null {
  if (typeof raw !== "object" || raw === null) return null;
  const e = raw as Record<string, unknown>;
  if (typeof e.id !== "string" || !e.id || e.id.length > 100) return null;
  if (!QUEUE_STATES.includes(e.state as QueueState)) return null;
  const entry: QueueEntry = {
    id: e.id,
    reference: typeof e.reference === "string" && e.reference ? e.reference.slice(0, 100) : e.id,
    displayName: typeof e.displayName === "string" ? collapse(e.displayName, 60) || "Patient" : "Patient",
    state: e.state as QueueState,
  };
  if (typeof e.sequence === "number" && Number.isInteger(e.sequence) && e.sequence >= 1 && e.sequence <= 99_999) entry.sequence = e.sequence;
  if (isOpSession(e.session)) entry.session = e.session;
  const checkedInAt = isoOrUndefined(e.checkedInAt);
  const updatedAt = isoOrUndefined(e.updatedAt);
  if (checkedInAt) entry.checkedInAt = checkedInAt;
  if (updatedAt) entry.updatedAt = updatedAt;
  return entry;
}

/** Talks to Postgres if DATABASE_URL is set, or the approved queue-admin endpoint. */
export function createAdminClient(env: Env = process.env, fetchImpl: FetchLike = fetch): AdminClient | null {
  if (env.DATABASE_URL?.trim()) {
    return createPostgresAdminClient();
  }

  const approved = approvedEndpoint(env, "QUEUE_ADMIN_URL", "QUEUE_ADMIN_TOKEN");
  if (!approved) return null;
  const { endpoint, token } = approved;

  const call = async (body: Record<string, unknown>) => {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 404) return null;
    if (response.status !== 200) throw new Error("admin_rejected");
    return (await response.json()) as { ok?: unknown; entries?: unknown; entry?: unknown };
  };

  return {
    async list(clinicId, clinicDate) {
      const result = await call({ action: "list", clinicId, clinicDate });
      if (!result || result.ok !== true || !Array.isArray(result.entries)) throw new Error("admin_unreadable");
      return result.entries.map(parseEntry).filter((e): e is QueueEntry => e !== null);
    },
    async update(id, state) {
      const result = await call({ action: "update", id, state });
      if (!result || result.ok !== true) return null;
      return parseEntry(result.entry);
    },
  };
}
