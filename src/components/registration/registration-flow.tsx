"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type FormEvent, type KeyboardEvent } from "react";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, ArrowRight } from "lucide-react";
import {
  EMPTY_ANSWERS,
  STEP_ORDER,
  calculateAge,
  dobToISO,
  formatDateIN,
  registrationDateIST,
  validateStep,
  type Answers,
  type FieldErrors,
  type StepId,
} from "@/lib/registration/rules";
import { thankYouHref } from "@/lib/registration/device-mode";
import { rememberReceipt } from "@/lib/registration/receipt-memory";
import { ClinicHeader } from "./clinic-header";
import { STEP_COPY } from "./registration-content";
import { AddressStep, BirthStep, ConcernsStep, ContactStep, NameStep, ReviewStep, SourcesStep } from "./steps";
import type { Stroke } from "./signature-pad";
import s from "./registration.module.css";

type Stage = "welcome" | StepId;

/** Shared-tablet privacy: wipe an abandoned form. Personal phones are never wiped on a timer. */
const IDLE_WARN_AFTER_MS = 3 * 60 * 1000;
const IDLE_RESET_AFTER_WARN_MS = 60 * 1000;
const SUBMIT_TIMEOUT_MS = 20_000;

const STAGE_ORDER: Stage[] = ["welcome", ...STEP_ORDER];

const SUBMIT_MESSAGES = {
  offline: "You seem to be offline. Your answers are safe on this screen. Please reconnect and try again.",
  timeout: "This is taking longer than expected. Your answers are safe — please try again.",
  unavailable: "Online registration isn’t available right now. Please check in with our reception team.",
  busy: "That was a lot of attempts in a short time. Please wait a moment and try again.",
  rejected: "We couldn’t accept some of your details. Please review them and try again.",
  generic: "We couldn’t save your registration. Your answers are still here, so please try again.",
} as const;

export function progressPercent(stage: Stage): number {
  if (stage === "welcome") return 0;
  return ((STEP_ORDER.indexOf(stage) + 1) / (STEP_ORDER.length + 1)) * 100;
}

function focusField(key: string) {
  const target = document.getElementById(`field-${key}`);
  if (!target) return;
  const focusable = target.matches("input, select, textarea, button")
    ? target
    : target.querySelector<HTMLElement>("input, select, textarea, button, canvas");
  (focusable ?? target).focus();
}

const FIRST_FIELD: Record<string, string> = { gender: "gender-first", concerns: "concern-first", sources: "source-first" };

export function RegistrationFlow({ kiosk = false }: { kiosk?: boolean; checkin?: boolean }) {
  const router = useRouter();
  const [view, setView] = useState<{ stage: Stage; direction: "forward" | "back" }>({ stage: "welcome", direction: "forward" });
  const { stage, direction } = view;
  const setStage = useCallback((next: Stage) => {
    setView((current) => ({
      stage: next,
      direction: STAGE_ORDER.indexOf(next) >= STAGE_ORDER.indexOf(current.stage) ? "forward" : "back",
    }));
  }, []);
  const [answers, setAnswers] = useState<Answers>(EMPTY_ANSWERS);
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [attempted, setAttempted] = useState<Partial<Record<StepId, boolean>>>({});
  const [editing, setEditing] = useState(false);
  const [sending, setSending] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [idleWarning, setIdleWarning] = useState(false);

  const headingRef = useRef<HTMLHeadingElement>(null);
  const firstRender = useRef(true);
  const sendingRef = useRef(false);
  const submittedRef = useRef(false);
  const attempt = useRef<{ key: string; fingerprint: string } | null>(null);

  const reset = useCallback(() => {
    setView({ stage: "welcome", direction: "back" });
    setAnswers(EMPTY_ANSWERS);
    setStrokes([]);
    setAttempted({});
    setEditing(false);
    setSending(false);
    setSubmitError("");
    setIdleWarning(false);
    attempt.current = null;
    sendingRef.current = false;
    submittedRef.current = false;
  }, []);

  // ---- derived ------------------------------------------------------------
  const stepIndex = stage === "welcome" ? -1 : STEP_ORDER.indexOf(stage);
  const errors: FieldErrors = useMemo(
    () => (stepIndex >= 0 && attempted[stage as StepId] ? validateStep(stage as StepId, answers) : {}),
    [stage, stepIndex, attempted, answers],
  );
  // Server render has no date; the client reads the clinic-time date on every render.
  const registrationDate = useSyncExternalStore(
    () => () => undefined,
    () => formatDateIN(registrationDateIST()),
    () => "",
  );
  const guardianReview = useMemo(() => {
    const dobFine = !validateStep("birth", answers).dob;
    return (dobFine && calculateAge(dobToISO(answers.dobDay, answers.dobMonth, answers.dobYear)) < 18) || answers.concerns.includes("paediatrics");
  }, [answers]);
  const dirty = JSON.stringify(answers) !== JSON.stringify(EMPTY_ANSWERS);

  // ---- effects ------------------------------------------------------------
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior });
    headingRef.current?.focus({ preventScroll: true });
  }, [stage]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      if (submittedRef.current) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  useEffect(() => {
    if (!kiosk || stage === "welcome") return;
    let warnTimer: number;
    let resetTimer: number;
    const arm = () => {
      window.clearTimeout(warnTimer);
      window.clearTimeout(resetTimer);
      setIdleWarning(false);
      warnTimer = window.setTimeout(() => {
        setIdleWarning(true);
        resetTimer = window.setTimeout(reset, IDLE_RESET_AFTER_WARN_MS);
      }, IDLE_WARN_AFTER_MS);
    };
    const events = ["pointerdown", "keydown", "touchstart"] as const;
    arm();
    for (const name of events) window.addEventListener(name, arm, { passive: true });
    return () => {
      window.clearTimeout(warnTimer);
      window.clearTimeout(resetTimer);
      for (const name of events) window.removeEventListener(name, arm);
    };
  }, [kiosk, stage, reset]);

  // ---- actions ------------------------------------------------------------
  const update = useCallback((patch: Partial<Answers>) => {
    setAnswers((current) => ({ ...current, ...patch }));
    setSubmitError("");
  }, []);

  const failFocus = (found: FieldErrors) => {
    const first = Object.keys(found)[0];
    if (!first) return;
    const id = FIRST_FIELD[first] ?? first;
    window.requestAnimationFrame(() => (FIRST_FIELD[first] ? document.getElementById(id)?.focus() : focusField(id)));
  };

  const submit = async () => {
    if (sendingRef.current) return;

    for (const step of STEP_ORDER) {
      const found = validateStep(step, answers);
      if (Object.keys(found).length > 0) {
        setAttempted((current) => ({ ...current, [step]: true }));
        if (step !== stage) setStage(step);
        failFocus(found);
        return;
      }
    }

    const fingerprint = JSON.stringify(answers);
    if (!attempt.current || attempt.current.fingerprint !== fingerprint) {
      attempt.current = { key: crypto.randomUUID(), fingerprint };
    }

    sendingRef.current = true;
    setSending(true);
    setSubmitError("");

    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      setSubmitError(SUBMIT_MESSAGES.offline);
      sendingRef.current = false;
      setSending(false);
      return;
    }

    try {
      const response = await fetch("/api/registrations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
        credentials: "same-origin",
        referrerPolicy: "no-referrer",
        signal: AbortSignal.timeout(SUBMIT_TIMEOUT_MS),
        body: JSON.stringify({ ...answers, idempotencyKey: attempt.current.key, website: "" }),
      });

      let result: {
        ok?: boolean;
        id?: string;
        token?: string;
        sequence?: number;
        dayTotal?: number;
        checkedInAt?: string;
        clinicDate?: string;
      } = {};
      try {
        result = (await response.json()) as typeof result;
      } catch {
        // Treated as a failure below.
      }

      if (response.status === 201 && result.ok === true && typeof result.id === "string") {
        // Only a confirmed save reaches this branch. Hand the receipt over in memory,
        // drop every answer, and replace this history entry with the thank-you page.
        const { ok: _ok, id, ...rest } = result;
        void _ok;
        rememberReceipt({ reference: id, ...rest });
        setAnswers(EMPTY_ANSWERS);
        setStrokes([]);
        setAttempted({});
        setEditing(false);
        attempt.current = null;
        const target = thankYouHref(rest.token, kiosk);
        if (typeof window !== "undefined") {
          submittedRef.current = true;
          window.location.replace(target);
        } else {
          router.replace(target);
        }
      } else if (response.status === 503) {
        setSubmitError(SUBMIT_MESSAGES.unavailable);
      } else if (response.status === 429) {
        setSubmitError(SUBMIT_MESSAGES.busy);
      } else if (response.status === 400) {
        setSubmitError(SUBMIT_MESSAGES.rejected);
      } else {
        setSubmitError(SUBMIT_MESSAGES.generic);
      }
    } catch (error) {
      const timedOut = error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError");
      setSubmitError(timedOut ? SUBMIT_MESSAGES.timeout : typeof navigator !== "undefined" && navigator.onLine === false ? SUBMIT_MESSAGES.offline : SUBMIT_MESSAGES.generic);
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  };

  const next = () => {
    if (stage === "welcome") return setStage("name");
    if (stage === "review") return void submit();

    const found = validateStep(stage, answers);
    if (Object.keys(found).length > 0) {
      setAttempted((current) => ({ ...current, [stage]: true }));
      failFocus(found);
      return;
    }
    if (editing) {
      setEditing(false);
      return setStage("review");
    }
    setStage(STEP_ORDER[stepIndex + 1]);
  };

  const back = () => {
    if (stage === "name") return setStage("welcome");
    if (stepIndex < 0) return;
    if (editing) {
      setEditing(false);
      return setStage("review");
    }
    setStage(STEP_ORDER[stepIndex - 1]);
  };

  const edit = (step: StepId) => {
    setEditing(true);
    setStage(step);
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    next();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    const target = event.target as HTMLElement;
    const isChoice = target instanceof HTMLInputElement && (target.type === "checkbox" || target.type === "radio");
    if (event.key === "Enter" && isChoice) {
      event.preventDefault();
      next();
    }
  };

  // ---- render -------------------------------------------------------------
  const copy = stepIndex >= 0 ? STEP_COPY[stage as StepId] : null;
  const percent = progressPercent(stage);

  return (
    <div className={s.shell}>
      <aside className={s.brand} aria-label="The Birthwave">
        <Image className={s.logoCream} src="/brand/wordmark-cream.png" alt="" width={2327} height={1139} />
        <Image
          className={s.brandPhoto}
          src="/images/clinic/consultation2.webp"
          alt=""
          fill
          sizes="(min-width: 1024px) 42vw, 1px"
        />
        <div className={s.brandVeil} aria-hidden="true" />
        <svg className={s.brandWave} viewBox="0 0 600 160" preserveAspectRatio="none" aria-hidden="true" focusable="false">
          <path d="M0 110 C 80 60, 160 160, 240 110 S 400 60, 480 110 S 560 140, 600 100" />
          <path d="M0 130 C 90 90, 170 170, 260 130 S 420 90, 500 135 S 570 150, 600 125" />
          <path d="M0 90 C 70 40, 150 140, 230 92 S 390 40, 470 90 S 555 120, 600 80" />
        </svg>
        <p className={s.brandLine}>
          A little about you, so we can <em>care for you better.</em>
        </p>
      </aside>

      <main id="main-content" className={s.panel}>
        <div className={s.panelInner}>
          <ClinicHeader
            logoInPanel
            progress={stepIndex >= 0 ? { step: stepIndex + 1, total: STEP_ORDER.length, percent } : undefined}
          />
          {stepIndex >= 0 ? (
            <div className={s.progress}>
              <div className={s.progressMeta}>
                <span>
                  Step {stepIndex + 1} of {STEP_ORDER.length}
                </span>
                <span>{copy?.short}</span>
              </div>
              <div
                className={s.progressTrack}
                role="progressbar"
                aria-label="Registration progress"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(percent)}
                aria-valuetext={`Step ${stepIndex + 1} of ${STEP_ORDER.length}: ${copy?.short}`}
              >
                <div className={s.progressFill} style={{ width: `${percent}%` }} />
              </div>
            </div>
          ) : null}

          <div className="sr-only" role="status" aria-live="polite">
            {stepIndex >= 0 ? `Step ${stepIndex + 1} of ${STEP_ORDER.length}: ${copy?.short}` : ""}
          </div>

          <div key={stage} className={s.stage} data-dir={direction}>
            {stage === "welcome" ? (
              <section className={s.welcome} aria-labelledby="stage-title">
                <p className={s.eyebrow}>Patient registration</p>
                <h1 id="stage-title" ref={headingRef} tabIndex={-1} className={s.title}>
                  Welcome to <em className={s.accent}>The Birthwave</em>
                </h1>
                <p className={s.welcomeLead}>Let’s get you checked in</p>
                <p className={s.lead}>This will take just a few minutes.</p>
                <button type="button" className={s.primary} onClick={() => setStage("name")}>
                  Start registration <ArrowRight size={20} aria-hidden="true" />
                </button>
                <p className={s.finePrint}>
                  Your details are kept confidential.{" "}
                  <Link href="/privacy" target="_blank" rel="noopener noreferrer">
                    Privacy Notice<span className="sr-only"> (opens in a new tab)</span>
                  </Link>
                </p>
              </section>
            ) : null}

            {copy ? (
              <form noValidate onSubmit={onSubmit} onKeyDown={onKeyDown} aria-labelledby="stage-title">
                <h1 id="stage-title" ref={headingRef} tabIndex={-1} className={s.title}>
                  {copy.title}
                </h1>
                {copy.lead ? <p className={s.lead}>{copy.lead}</p> : null}

                {submitError ? (
                  <p role="alert" className={s.alert}>
                    {submitError}
                  </p>
                ) : null}

                <div className={s.fields}>
                  {stage === "name" ? <NameStep answers={answers} update={update} errors={errors} /> : null}
                  {stage === "birth" ? <BirthStep answers={answers} update={update} errors={errors} /> : null}
                  {stage === "contact" ? <ContactStep answers={answers} update={update} errors={errors} /> : null}
                  {stage === "address" ? <AddressStep answers={answers} update={update} errors={errors} /> : null}
                  {stage === "concerns" ? <ConcernsStep answers={answers} update={update} errors={errors} /> : null}
                  {stage === "sources" ? <SourcesStep answers={answers} update={update} errors={errors} /> : null}
                  {stage === "review" ? (
                    <ReviewStep
                      answers={answers}
                      update={update}
                      errors={errors}
                      registrationDate={registrationDate}
                      strokes={strokes}
                      guardianReview={guardianReview}
                      onEdit={edit}
                      onStrokes={(next, signatureData) => {
                        setStrokes(next);
                        update({ signatureData });
                      }}
                    />
                  ) : null}
                </div>

                <div className={s.nav}>
                  <button type="button" className={s.secondary} onClick={back} disabled={sending}>
                    <ArrowLeft size={18} aria-hidden="true" /> Back
                  </button>
                  <button type="submit" className={s.primary} disabled={sending} aria-busy={sending || undefined}>
                    {stage === "review" ? (sending ? "Sending…" : submitError ? "Try again" : "Submit registration") : "Continue"}
                    {stage === "review" ? null : <ArrowRight size={20} aria-hidden="true" />}
                  </button>
                </div>
              </form>
            ) : null}

          </div>
        </div>
      </main>

      {idleWarning ? (
        <div className={s.idle} role="alert">
          <p>Are you still there? For your privacy, this form will clear in a minute.</p>
          <button type="button" className={s.primary} autoFocus onClick={() => setIdleWarning(false)}>
            I’m still here
          </button>
        </div>
      ) : null}
    </div>
  );
}
