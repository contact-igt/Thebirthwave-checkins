import { isOpSession, registrationDateIST, type OpSession } from "./rules.ts";

/**
 * Validation of what the approved backend returns after saving a registration
 * or when a patient revisits their status. This app never computes a daily
 * number, a queue position or a waiting time; it only decides whether a value
 * the backend supplied is trustworthy enough to show. Anything doubtful is
 * dropped so the patient sees the confirmed reference instead.
 */

export const QUEUE_STATES = [
  "registered",
  "checked_in",
  "waiting",
  "called",
  "in_consultation",
  "completed",
] as const;
export type QueueState = (typeof QUEUE_STATES)[number];

export interface Receipt {
  reference: string;
  token?: string;
  sequence?: number;
  dayTotal?: number;
  checkedInAt?: string;
  clinicDate?: string;
  /** Which OP session the number belongs to (each session is numbered from 001). */
  session?: OpSession;
}

export interface QueueInfo {
  ahead: number;
  estimateMinutes?: { min: number; max: number };
  updatedAt: string;
}

export interface PatientStatus {
  reference: string;
  sequence?: number;
  dayTotal?: number;
  checkedInAt?: string;
  clinicDate?: string;
  session?: OpSession;
  state: QueueState;
  updatedAt?: string;
  queue?: QueueInfo;
}

interface Context {
  clinicId: string;
  now: Date;
}

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{22,128}$/;
const MAX_SEQUENCE = 99_999;

export function isValidToken(value: unknown): value is string {
  return typeof value === "string" && TOKEN_PATTERN.test(value);
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function isoMs(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

function positiveInt(value: unknown, max: number): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= max ? value : undefined;
}

/** Day-numbering fields, kept only if they prove they belong to today at this clinic. */
function parseNumbering(raw: Record<string, unknown>, ctx: Context): Pick<Receipt, "sequence" | "dayTotal" | "checkedInAt" | "clinicDate" | "session"> {
  const out: Pick<Receipt, "sequence" | "dayTotal" | "checkedInAt" | "clinicDate" | "session"> = {};

  const checkedMs = isoMs(raw.checkedInAt);
  if (checkedMs !== null) out.checkedInAt = raw.checkedInAt as string;

  const sequence = positiveInt(raw.sequence, MAX_SEQUENCE);
  const clinicDate = typeof raw.clinicDate === "string" ? raw.clinicDate : "";
  const sameClinic = raw.clinicId === undefined || raw.clinicId === ctx.clinicId;

  const provablyToday =
    sequence !== undefined &&
    sameClinic &&
    checkedMs !== null &&
    clinicDate === registrationDateIST(new Date(checkedMs)) &&
    clinicDate === registrationDateIST(ctx.now);

  if (provablyToday) {
    out.sequence = sequence;
    out.clinicDate = clinicDate;
    if (isOpSession(raw.session)) out.session = raw.session;
    const total = positiveInt(raw.dayTotal, MAX_SEQUENCE);
    if (total !== undefined && total >= sequence) out.dayTotal = total;
  }
  return out;
}

export function parseSaveResponse(json: unknown, ctx: Context): Receipt | null {
  if (!isRecord(json) || json.ok !== true) return null;
  if (typeof json.id !== "string" || json.id.length < 1 || json.id.length > 100) return null;

  const receipt: Receipt = { reference: json.id };
  if (isValidToken(json.token)) receipt.token = json.token;
  return { ...receipt, ...parseNumbering(json, ctx) };
}

function parseQueue(raw: unknown, state: QueueState): QueueInfo | undefined {
  if (!isRecord(raw) || raw.live !== true || raw.confirmedByStaff !== true) return undefined;
  const ahead = raw.ahead;
  if (typeof ahead !== "number" || !Number.isInteger(ahead) || ahead < 0 || ahead > 500) return undefined;
  if (isoMs(raw.updatedAt) === null) return undefined;

  const queue: QueueInfo = { ahead, updatedAt: raw.updatedAt as string };
  const e = raw.estimateMinutes;
  if (
    state === "waiting" &&
    isRecord(e) &&
    typeof e.min === "number" &&
    typeof e.max === "number" &&
    Number.isInteger(e.min) &&
    Number.isInteger(e.max) &&
    e.min >= 0 &&
    e.min <= e.max &&
    e.max <= 240
  ) {
    queue.estimateMinutes = { min: e.min, max: e.max };
  }
  return queue;
}

export function parseStatusResponse(json: unknown, ctx: Context): PatientStatus | null {
  if (!isRecord(json) || json.ok !== true || !isRecord(json.status)) return null;
  const raw = json.status;
  if (typeof raw.reference !== "string" || raw.reference.length < 1 || raw.reference.length > 100) return null;
  if (!QUEUE_STATES.includes(raw.state as QueueState)) return null;
  const state = raw.state as QueueState;

  const status: PatientStatus = { reference: raw.reference, state, ...parseNumbering(raw, ctx) };
  if (isoMs(raw.updatedAt) !== null) status.updatedAt = raw.updatedAt as string;
  const queue = parseQueue(raw.queue, state);
  if (queue) status.queue = queue;
  return status;
}
