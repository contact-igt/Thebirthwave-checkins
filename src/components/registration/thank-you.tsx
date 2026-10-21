"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { CheckCircle2, RefreshCw } from "lucide-react";
import { clinicContact } from "@/content/clinic-contact";
import { startHref, tokenFromHash } from "@/lib/registration/device-mode";
import { forgetReceipt, recallReceipt } from "@/lib/registration/receipt-memory";
import type { PatientStatus } from "@/lib/registration/receipt";
import { OP_SESSION_LABEL, formatDateIN, registrationDateIST } from "@/lib/registration/rules";
import {
  APPROXIMATE_NOTE,
  CONSULTATION_NOTE,
  VARIES_NOTE,
  formatDateFromISO,
  formatSequence,
  formatTimeIST,
  guidanceFor,
  stageOf,
  waitingSummary,
} from "@/lib/registration/waiting";
import { ClinicHeader } from "./clinic-header";
import { Heartbeat } from "./heartbeat";
import { QrCode } from "./qr-code";
import s from "./thank-you.module.css";

const KIOSK_SECONDS = 45;
const POLL_MS = 30_000;

type Feed = "idle" | "live" | "unavailable" | "missing";

const subscribeHash = (notify: () => void) => {
  window.addEventListener("hashchange", notify);
  return () => window.removeEventListener("hashchange", notify);
};
const readHash = () => window.location.hash;
const noop = () => () => undefined;

const STAGES = [
  { id: "waiting", label: "Waiting for consultation" },
  { id: "called", label: "Called" },
  { id: "consultation", label: "In consultation" },
] as const;

export function ThankYou({ checkin, kiosk }: { checkin: boolean; kiosk: boolean }) {
  const mounted = useSyncExternalStore(noop, () => true, () => false);
  const hash = useSyncExternalStore(subscribeHash, readHash, () => "");
  const token = mounted ? tokenFromHash(hash) : null;
  const fresh = mounted ? recallReceipt() : null;

  const [status, setStatus] = useState<PatientStatus | null>(null);
  const [feed, setFeed] = useState<Feed>("idle");
  const [refreshing, setRefreshing] = useState(false);
  const [fetchedAt, setFetchedAt] = useState("");
  const [announce, setAnnounce] = useState("");
  const [done, setDone] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(KIOSK_SECONDS);
  const headingRef = useRef<HTMLHeadingElement>(null);

  const refresh = useCallback(async () => {
    if (!token) return;
    try {
      const response = await fetch("/api/queue/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
        referrerPolicy: "no-referrer",
        body: JSON.stringify({ token }),
        signal: AbortSignal.timeout(10_000),
      });
      if (response.status === 503) return setFeed("unavailable");
      if (response.status === 404) return setFeed("missing");
      if (!response.ok) return;
      const body = (await response.json()) as { ok?: boolean; status?: PatientStatus };
      if (body.ok && body.status) {
        setStatus((previous) => {
          if (previous && previous.state !== body.status!.state) setAnnounce(guidanceFor(body.status!.state));
          return body.status!;
        });
        setFeed("live");
        setFetchedAt(formatTimeIST(new Date().toISOString()));
      }
    } catch {
      // Keep showing the last known details; the next refresh will retry.
    }
  }, [token]);

  const refreshNow = () => {
    setRefreshing(true);
    void refresh().finally(() => setRefreshing(false));
  };

  // Personal phones follow their status while the page is visible.
  useEffect(() => {
    if (!token || kiosk || feed === "unavailable" || feed === "missing") return;
    const first = window.setTimeout(() => void refresh(), 0);
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, POLL_MS);
    const onVisible = () => document.visibilityState === "visible" && void refresh();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
    // `feed` is intentionally read once per token: unavailable/missing end polling on the next render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, kiosk, refresh]);

  // Shared tablet: show the card for a readable moment, then wipe the screen for the next patient.
  const leave = useCallback(() => {
    forgetReceipt();
    window.location.replace(startHref(checkin, true));
  }, [checkin]);

  useEffect(() => {
    if (!kiosk || !mounted) return;
    const endsAt = Date.now() + KIOSK_SECONDS * 1000;
    const timer = window.setInterval(() => {
      const left = Math.ceil((endsAt - Date.now()) / 1000);
      if (left <= 0) {
        window.clearInterval(timer);
        leave();
      } else {
        setSecondsLeft(left);
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, [kiosk, mounted, leave]);

  useEffect(() => {
    if (mounted) headingRef.current?.focus({ preventScroll: true });
  }, [mounted]);

  const closePage = () => {
    forgetReceipt();
    window.history.replaceState(null, "", window.location.pathname);
    setStatus(null);
    setDone(true);
  };

  const view = {
    reference: status?.reference ?? fresh?.reference,
    sequence: status?.sequence ?? fresh?.sequence,
    dayTotal: status?.dayTotal ?? fresh?.dayTotal,
    checkedInAt: status?.checkedInAt ?? fresh?.checkedInAt,
    clinicDate: status?.clinicDate ?? fresh?.clinicDate,
    session: status?.session ?? fresh?.session,
  };
  const state = status?.state;
  const summary = waitingSummary(status?.queue);
  const stage = stageOf(state);
  const phoneHref = `tel:${clinicContact.phone.replace(/[^\d+]/g, "")}`;

  if (!mounted) {
    return (
      <div className={s.page}>
        <main id="main-content" className={s.wrap} />
      </div>
    );
  }

  if (done) {
    return (
      <div className={s.page}>
        <main id="main-content" className={s.wrap}>
          <ClinicHeader />
          <section className={s.closing} aria-labelledby="ty-title">
            <Heartbeat />
            <h1 id="ty-title" ref={headingRef} tabIndex={-1} className={s.title}>
              Thank you for <em className={s.accent}>visiting</em>
            </h1>
            <p className={s.lead}>You can now close this page. Take care, and we’ll see you soon.</p>
            <Link className={s.secondary} href={startHref(checkin, false)}>
              Start a new registration
            </Link>
          </section>
        </main>
      </div>
    );
  }

  // Nothing confirmed to show (refreshed shared screen, expired link, or no status service).
  if (!view.reference) {
    const waiting = Boolean(token) && feed === "idle";
    return (
      <div className={s.page}>
        <main id="main-content" className={s.wrap}>
          <ClinicHeader />
          <section className={s.closing} aria-labelledby="ty-title">
            <Heartbeat />
            <h1 id="ty-title" ref={headingRef} tabIndex={-1} className={s.title}>
              {waiting ? (
                <>Finding your <em className={s.accent}>registration</em></>
              ) : (
                <>We can’t show this <em className={s.accent}>receipt</em></>
              )}
            </h1>
            <p className={s.lead} role={waiting ? "status" : undefined}>
              {waiting
                ? "One moment, please."
                : "For your privacy this page doesn’t keep your details. If you’ve just registered, our reception team can confirm your check-in."}
            </p>
            {!waiting ? (
              <>
                <a className={s.primary} href={phoneHref}>
                  Call reception: {clinicContact.phone}
                </a>
                <Link className={s.secondary} href={startHref(checkin, kiosk)}>
                  Start a new registration
                </Link>
              </>
            ) : null}
          </section>
        </main>
      </div>
    );
  }

  const date = view.checkedInAt ? formatDateFromISO(view.checkedInAt) : formatDateIN(registrationDateIST());
  const qrUrl = token ? `${window.location.origin}/thank-you#t=${token}` : "";

  return (
    <div className={s.page}>
      <div className={s.wash} aria-hidden="true" />
      <main id="main-content" className={s.wrap}>
        <ClinicHeader />

        <section className={s.hero} aria-labelledby="ty-title">
          <Heartbeat />
          <p className={s.eyebrow}>The Birthwave</p>
          <h1 id="ty-title" ref={headingRef} tabIndex={-1} className={s.title}>
            You’re <em className={s.accent}>all checked in.</em>
          </h1>
          <p className={s.lead}>
            Thank you for sharing your details with us. Please make yourself comfortable. Our team will guide you
            through the next step.
          </p>
        </section>

        {kiosk ? (
          <section className={s.kiosk} aria-labelledby="kiosk-title">
            {qrUrl ? (
              <div className={s.qr}>
                <QrCode value={qrUrl} label="QR code to open your private waiting page on your own phone" />
              </div>
            ) : null}
            <div>
              <h2 id="kiosk-title" className={s.cardTitle}>
                {qrUrl ? "Continue on your phone" : "All done here"}
              </h2>
              <p>
                {qrUrl
                  ? "Scan this code to follow your waiting status privately on your own phone."
                  : "Your details have been cleared from this screen."}
              </p>
              <p className={s.fine}>This screen clears for the next patient in {secondsLeft} seconds.</p>
              <button type="button" className={s.primary} onClick={leave}>
                Done — clear this screen
              </button>
            </div>
          </section>
        ) : null}

        <div className={s.grid}>
          <section className={s.card} aria-labelledby="card-title">
            <p className={s.badge}>
              <CheckCircle2 size={18} strokeWidth={2} aria-hidden="true" /> Registration confirmed
            </p>
            <h2 id="card-title" className="sr-only">
              Your digital registration card
            </h2>

            {view.sequence !== undefined ? (
              <div className={s.number}>
                <p className={s.numberLabel}>{view.session ? `Your registration · ${OP_SESSION_LABEL[view.session]}` : "Your registration today"}</p>
                <p className={s.numberValue} data-testid="registration-number">
                  <span className={s.numberNo}>No.</span> {formatSequence(view.sequence)}
                </p>
                <p className={s.numberNote}>Successfully registered at The Birthwave.</p>
              </div>
            ) : (
              <div className={s.number}>
                <p className={s.numberLabel}>Your registration reference</p>
                <p className={s.numberValue} data-testid="registration-reference">
                  {view.reference}
                </p>
                <p className={s.numberNote}>Successfully registered at The Birthwave.</p>
              </div>
            )}

            <dl className={s.facts}>
              {view.sequence !== undefined ? (
                <div>
                  <dt>Reference</dt>
                  <dd>{view.reference}</dd>
                </div>
              ) : null}
              <div>
                <dt>Date</dt>
                <dd>{date}</dd>
              </div>
              {view.checkedInAt ? (
                <div>
                  <dt>Checked in at</dt>
                  <dd>{formatTimeIST(view.checkedInAt)}</dd>
                </div>
              ) : null}
            </dl>

            {view.dayTotal !== undefined ? (
              <p className={s.total}>
                {view.dayTotal} {view.dayTotal === 1 ? "registration" : "registrations"} completed{" "}
                {view.session ? `in ${OP_SESSION_LABEL[view.session]}` : "today"}.
              </p>
            ) : null}
          </section>

          <section className={s.card} aria-labelledby="wait-title">
            <h2 id="wait-title" className={s.cardTitle}>
              Your waiting status
            </h2>

            <ol className={s.stages}>
              <li className={s.stageDone}>
                <span className={s.stageDot} aria-hidden="true" />
                Registration confirmed
              </li>
              {STAGES.map((item) => {
                const index = STAGES.findIndex((x) => x.id === item.id);
                const current = STAGES.findIndex((x) => x.id === stage);
                const complete = stage === "done" || index < current;
                const active = stage !== "done" && index === current;
                return (
                  <li key={item.id} className={complete ? s.stageDone : active ? s.stageActive : s.stagePending} aria-current={active ? "step" : undefined}>
                    <span className={s.stageDot} aria-hidden="true" />
                    {item.label}
                  </li>
                );
              })}
            </ol>

            <p className={s.guidance}>{guidanceFor(state)}</p>

            <div className={s.waitBox}>
              {summary.aheadText ? <p className={s.ahead}>{summary.aheadText}</p> : null}
              <p className={summary.approximate ? s.waitEstimate : s.waitFallback}>{summary.waitText}</p>
              {summary.approximate ? <p className={s.fine}>{APPROXIMATE_NOTE}</p> : null}
            </div>

            <p className={s.consult}>{CONSULTATION_NOTE}</p>
            <p className={s.fine}>{VARIES_NOTE}</p>

            {feed === "live" && !kiosk ? (
              <div className={s.updated}>
                <span className={s.pulse} aria-hidden="true" />
                <span>
                  Last updated {status?.updatedAt ? formatTimeIST(status.updatedAt) : fetchedAt}
                </span>
                <button type="button" className={s.refresh} onClick={refreshNow} disabled={refreshing} aria-label="Refresh my status">
                  <RefreshCw size={16} aria-hidden="true" />
                  {refreshing ? "Updating…" : "Refresh"}
                </button>
              </div>
            ) : null}
            <p className="sr-only" role="status" aria-live="polite">
              {announce}
            </p>
          </section>
        </div>

        <section className={s.while} aria-labelledby="while-title">
          <h2 id="while-title" className={s.cardTitle}>
            While you’re here
          </h2>
          <p>Please make yourself comfortable. Our team will call you when it’s time.</p>
          <p>Need anything while you wait? Our reception team is here to help.</p>
          <a className={s.secondary} href={phoneHref}>
            <span className="sr-only">Call reception: </span>
            {clinicContact.phone}
          </a>
          <h3 className={s.nextTitle}>What happens next</h3>
          <ol className={s.next}>
            <li>Our team will call you when it’s ready for you.</li>
            <li>You’ll meet your doctor and share what’s on your mind.</li>
            <li>Reception will be happy to help with anything afterwards.</li>
          </ol>
        </section>

        {!kiosk ? (
          <div className={s.doneRow}>
            <button type="button" className={s.primary} onClick={closePage}>
              Done
            </button>
          </div>
        ) : null}
      </main>
    </div>
  );
}
