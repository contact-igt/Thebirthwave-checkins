"use client";

import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import Image from "next/image";
import { clinicContact } from "@/content/clinic-contact";
import { formatDateIN, registrationDateIST } from "@/lib/registration/rules";
import s from "./clinic-header.module.css";

const WEEKDAY = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", weekday: "short" });
const RECEPTION_TEL = `tel:${clinicContact.phone.replace(/[^\d+]/g, "")}`;

interface Props {
  /** Shown while answering the questionnaire. */
  progress?: { step: number; total: number; percent: number };
  /** True on the split layout, where the brand panel already shows the logo. */
  logoInPanel?: boolean;
}

/** Quiet, clinic-only header: no marketing navigation, CTAs or widgets. */
export function ClinicHeader({ progress, logoInPanel = false }: Props) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  // Date is read on the client so server HTML never carries a stale day.
  const today = useSyncExternalStore(
    () => () => undefined,
    () => {
      const now = new Date();
      return `${WEEKDAY.format(now)}, ${formatDateIN(registrationDateIST(now))}`;
    },
    () => "",
  );

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        trigger.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <header className={s.header} data-split={logoInPanel ? "true" : undefined}>
      <Image
        className={s.logo}
        src="/brand/wordmark-mauve.png"
        alt="The Birthwave"
        width={2327}
        height={1139}
        priority
      />
      <div className={s.meta}>
        <p className={s.label}>Clinic Check-in</p>
        <p className={s.line}>Your care begins here.</p>
      </div>
      <p className={s.date}>
        <span className="sr-only">Today’s date: </span>
        {today}
      </p>
      {progress ? (
        <p className={s.step} aria-hidden="true">
          Step {progress.step} of {progress.total} · {Math.round(progress.percent)}%
        </p>
      ) : null}
      <button
        ref={trigger}
        type="button"
        className={s.help}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
      >
        Need assistance?
      </button>
      {open ? (
        <div id={panelId} className={s.assist} role="region" aria-label="Reception assistance">
          <p>Our reception team is happy to help with anything at all. Please ask at the front desk, or call us:</p>
          <a href={RECEPTION_TEL}>
            <span className="sr-only">Call reception: </span>
            {clinicContact.phone}
          </a>
          <button type="button" onClick={() => setOpen(false)}>
            Close
          </button>
        </div>
      ) : null}
    </header>
  );
}
