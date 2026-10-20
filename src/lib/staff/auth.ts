import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { approvedEndpoint } from "../registration/store.ts";

/**
 * Staff sign-in for the queue console. Accounts live in the deployment's
 * environment (salted scrypt hashes), sessions are HMAC-signed cookies.
 * Nothing here is reachable unless every gate in `loadStaffConfig` passes.
 */

export type StaffRole = "reception" | "clinician";

export interface StaffAccount {
  username: string;
  passwordHash: string;
  role: StaffRole;
}

export interface StaffConfig {
  secret: string;
  accounts: StaffAccount[];
  sessionSeconds: number;
}

export const SESSION_COOKIE = "__Host-bw_staff";
export const SESSION_SECONDS = 8 * 60 * 60;

type Env = Record<string, string | undefined>;

const HASH_PATTERN = /^scrypt\$\d+\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/;
const KEY_LENGTH = 32;
const COST = 16_384;

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("base64url");
  const hash = scryptSync(password, salt, KEY_LENGTH, { N: COST }).toString("base64url");
  return `scrypt$${COST}$${salt}$${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  if (!password || !HASH_PATTERN.test(stored)) return false;
  const [, cost, salt, hash] = stored.split("$");
  const n = Number(cost);
  if (!Number.isInteger(n) || n < 1024 || n > 131_072) return false;
  const expected = Buffer.from(hash, "base64url");
  const actual = scryptSync(password, salt, expected.length, { N: n, maxmem: 256 * 1024 * 1024 });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Null unless the console is explicitly enabled AND fully configured. */
export function loadStaffConfig(env: Env = process.env): StaffConfig | null {
  if (env.STAFF_CONSOLE_ENABLED !== "true") return null;
  const secret = env.STAFF_SESSION_SECRET ?? "";
  if (secret.length < 32) return null;
  if (!approvedEndpoint(env, "QUEUE_ADMIN_URL", "QUEUE_ADMIN_TOKEN")) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(env.STAFF_ACCOUNTS ?? "");
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 20) return null;

  const accounts: StaffAccount[] = [];
  for (const raw of parsed as Array<Record<string, unknown>>) {
    const { username, passwordHash, role } = raw ?? {};
    if (
      typeof username !== "string" ||
      !/^[a-z0-9._-]{3,40}$/.test(username) ||
      typeof passwordHash !== "string" ||
      !HASH_PATTERN.test(passwordHash) ||
      (role !== "reception" && role !== "clinician")
    ) {
      return null;
    }
    accounts.push({ username, passwordHash, role });
  }
  return { secret, accounts, sessionSeconds: SESSION_SECONDS };
}

const sign = (body: string, secret: string) => createHmac("sha256", secret).update(body).digest("base64url");

export function signSession(
  who: { username: string; role: StaffRole },
  secret: string,
  now: Date = new Date(),
  ttlSeconds: number = SESSION_SECONDS,
): string {
  const exp = Math.floor(now.getTime() / 1000) + ttlSeconds;
  const body = Buffer.from(JSON.stringify({ username: who.username, role: who.role, exp })).toString("base64url");
  return `${body}.${sign(body, secret)}`;
}

export function verifySession(
  cookie: string | undefined,
  secret: string,
  now: Date = new Date(),
): { username: string; role: StaffRole } | null {
  if (!cookie) return null;
  const [body, signature, extra] = cookie.split(".");
  if (!body || !signature || extra !== undefined) return null;

  const expected = Buffer.from(sign(body, secret));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;

  try {
    const data = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as {
      username?: unknown;
      role?: unknown;
      exp?: unknown;
    };
    if (typeof data.exp !== "number" || data.exp * 1000 <= now.getTime()) return null;
    if (typeof data.username !== "string" || (data.role !== "reception" && data.role !== "clinician")) return null;
    return { username: data.username, role: data.role };
  } catch {
    return null;
  }
}

export function readSessionCookie(request: Request): string | undefined {
  const header = request.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === SESSION_COOKIE) return rest.join("=");
  }
  return undefined;
}
