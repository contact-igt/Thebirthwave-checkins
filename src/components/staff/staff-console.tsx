"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import Image from "next/image";
import { QUEUE_STATES, type QueueState } from "@/lib/registration/receipt";
import { OP_SESSION_CODE, type OpSession } from "@/lib/registration/rules";
import { formatSequence, formatTimeIST } from "@/lib/registration/waiting";
import s from "./staff-console.module.css";

interface Entry {
  id: string;
  reference: string;
  sequence?: number;
  session?: OpSession;
  displayName: string;
  state: QueueState;
  checkedInAt?: string;
}

const LABEL: Record<QueueState, string> = {
  registered: "Registered",
  checked_in: "Checked in",
  waiting: "Waiting",
  called: "Called",
  in_consultation: "In consultation",
  completed: "Completed",
};
const NEXT: Partial<Record<QueueState, QueueState>> = {
  registered: "checked_in",
  checked_in: "waiting",
  waiting: "called",
  called: "in_consultation",
  in_consultation: "completed",
};
const CLINICIAN_STATES: readonly QueueState[] = ["called", "in_consultation", "completed"];

type Phase = "loading" | "login" | "board";

/** Reception/clinician queue board. Every call is authenticated server-side; this UI holds no secrets. */
export function StaffConsole({ enabled }: { enabled: boolean }) {
  const [phase, setPhase] = useState<Phase>("loading");
  const [role, setRole] = useState<"reception" | "clinician">("reception");
  const [date, setDate] = useState("");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/staff/queue", { cache: "no-store", credentials: "same-origin" });
      if (response.status === 401) return setPhase("login");
      const body = (await response.json()) as { ok?: boolean; entries?: Entry[]; role?: "reception" | "clinician"; clinicDate?: string; error?: string };
      if (!response.ok || !body.ok) {
        setError(body.error ?? "The queue couldn’t be loaded.");
        return setPhase("board");
      }
      setEntries(body.entries ?? []);
      setRole(body.role ?? "reception");
      setDate(body.clinicDate ?? "");
      setError("");
      setPhase("board");
    } catch {
      setError("The queue couldn’t be loaded. Please check the connection.");
      setPhase((current) => (current === "loading" ? "login" : current));
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const first = window.setTimeout(() => void load(), 0);
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, 20_000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, [enabled, load]);

  if (!enabled) {
    return (
      <main id="main-content" className={s.page}>
        <div className={s.card}>
          <h1 className={s.title}>Reception queue</h1>
          <p className={s.sub}>The staff console isn’t switched on for this deployment.</p>
        </div>
      </main>
    );
  }

  const signIn = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy("login");
    setError("");
    try {
      const response = await fetch("/api/staff/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ username: form.get("username"), password: form.get("password") }),
      });
      if (!response.ok) {
        const body = (await response.json()) as { error?: string };
        setError(body.error ?? "Sign-in failed.");
      } else {
        await load();
      }
    } catch {
      setError("Sign-in failed. Please check the connection.");
    } finally {
      setBusy("");
    }
  };

  const signOut = async () => {
    await fetch("/api/staff/logout", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    setEntries([]);
    setPhase("login");
  };

  const move = async (entry: Entry, state: QueueState) => {
    setBusy(entry.id);
    setError("");
    try {
      const response = await fetch("/api/staff/queue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ id: entry.id, state }),
      });
      if (response.status === 401) return setPhase("login");
      if (!response.ok) setError(((await response.json()) as { error?: string }).error ?? "The update didn’t save.");
      await load();
    } finally {
      setBusy("");
    }
  };

  const allowed = role === "clinician" ? CLINICIAN_STATES : QUEUE_STATES;
  const counts = QUEUE_STATES.map((state) => [state, entries.filter((e) => e.state === state).length] as const).filter(([, n]) => n > 0);

  return (
    <main id="main-content" className={s.page}>
      <div className={s.wrap}>
        <div className={s.top}>
          <Image className={s.logo} src="/brand/wordmark-mauve.png" alt="The Birthwave" width={2327} height={1139} priority />
          {phase === "board" ? (
            <div className={s.actions}>
              <button type="button" className={s.ghost} onClick={() => void load()}>
                Refresh
              </button>
              <button type="button" className={s.ghost} onClick={() => void signOut()}>
                Sign out
              </button>
            </div>
          ) : null}
        </div>

        {phase === "loading" ? <p role="status">Loading…</p> : null}

        {phase === "login" ? (
          <form className={s.card} onSubmit={signIn}>
            <h1 className={s.title}>Reception sign-in</h1>
            <p className={s.sub}>Authorised clinic staff only.</p>
            <div className={s.field}>
              <label htmlFor="staff-username">Username</label>
              <input id="staff-username" name="username" autoComplete="username" autoCapitalize="none" spellCheck={false} required />
            </div>
            <div className={s.field}>
              <label htmlFor="staff-password">Password</label>
              <input id="staff-password" name="password" type="password" autoComplete="current-password" required />
            </div>
            {error ? (
              <p role="alert" className={s.error}>
                {error}
              </p>
            ) : null}
            <button type="submit" className={s.btn} disabled={busy === "login"}>
              {busy === "login" ? "Signing in…" : "Sign in"}
            </button>
          </form>
        ) : null}

        {phase === "board" ? (
          <>
            <h1 className={s.title}>Today’s queue</h1>
            <p className={s.sub}>
              {date.split("-").reverse().join("/")} · signed in as {role}. Patient names are visible to signed-in staff only.
            </p>
            {error ? (
              <p role="alert" className={s.error}>
                {error}
              </p>
            ) : null}
            <ul className={s.counts} aria-label="Counts by status">
              {counts.map(([state, n]) => (
                <li key={state}>
                  {LABEL[state]}: {n}
                </li>
              ))}
            </ul>
            {entries.length === 0 ? (
              <p className={s.empty}>No registrations yet today.</p>
            ) : (
              <ul className={s.list}>
                {entries.map((entry) => {
                  const next = NEXT[entry.state];
                  return (
                    <li key={entry.id} className={s.row}>
                      <span className={s.seq}>
                        {entry.session ? `${OP_SESSION_CODE[entry.session]}·` : ""}
                        {entry.sequence ? formatSequence(entry.sequence) : "—"}
                      </span>
                      <span>
                        <span className={s.who}>{entry.displayName}</span>
                        <span className={s.meta}>
                          {" "}
                          · {entry.reference}
                          {entry.checkedInAt ? ` · in at ${formatTimeIST(entry.checkedInAt)}` : ""}
                        </span>
                      </span>
                      <span className={s.controls}>
                        <span className={s.state}>{LABEL[entry.state]}</span>
                        {next && allowed.includes(next) ? (
                          <button type="button" className={s.btn} disabled={busy === entry.id} onClick={() => void move(entry, next)}>
                            {LABEL[next]}
                          </button>
                        ) : null}
                        <select
                          className={s.select}
                          aria-label={`Set status for ${entry.displayName}, ${entry.reference}`}
                          value=""
                          disabled={busy === entry.id}
                          onChange={(event) => event.target.value && void move(entry, event.target.value as QueueState)}
                        >
                          <option value="">Change…</option>
                          {allowed
                            .filter((state) => state !== entry.state)
                            .map((state) => (
                              <option key={state} value={state}>
                                {LABEL[state]}
                              </option>
                            ))}
                        </select>
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </>
        ) : null}
      </div>
    </main>
  );
}
