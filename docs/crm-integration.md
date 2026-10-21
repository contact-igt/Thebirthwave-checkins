# CRM integration

Every clinic registration becomes **one lead** in the main CRM leads list, under the label **Clinic registrations**.
The same phone number registering on another day is a **new lead**: the CRM upserts on `reference`, never on phone.

## OP sessions

Morning and evening OP are numbered separately, each from 001. A registration before 14:00 IST is `morning`,
from 14:00 it is `evening` (set `OP_EVENING_STARTS=HH:MM` in Vercel to move the cutoff). References look like
`BW-20261021-M-0003` / `BW-20261021-E-0003`, and every lead carries `session`. The `reference` stays unique across sessions.

## How a lead reaches the CRM

1. The patient submits the form. The registration and a `crm_outbox` row are saved in one transaction.
2. Right after the response, and then every minute from a Vercel Cron (`/api/crm/dispatch`), the app POSTs
   unsent rows to the CRM. A failed send is retried with backoff (30 s, 1 min, 2 min ... capped at 1 h, 12 attempts).
3. A CRM outage never blocks a patient. If the outbox ever misses a lead, the pull API below backfills it.

## What the CRM must implement: `POST <CRM_INTAKE_URL>` (HTTPS)

Headers:

| Header | Meaning |
|---|---|
| `Idempotency-Key` | The registration `reference`, e.g. `BW-20261020-0007` |
| `X-Birthwave-Timestamp` | Unix seconds. Reject if more than 5 minutes old |
| `X-Birthwave-Signature` | `sha256=` + hex HMAC-SHA256 of `<timestamp>.<raw body>` with `CRM_SHARED_SECRET`. Compare in constant time |

Body (the signature image is deliberately not sent):

```json
{
  "event": "clinic_registration.created",
  "reference": "BW-20261020-0007",
  "clinicId": "main",
  "clinicDate": "2026-10-20",
  "session": "morning",
  "registeredAt": "2026-10-20T08:00:00.000Z",
  "lead": {
    "source": "clinic_registration",
    "category": "Clinic registrations",
    "name": "…", "phone": "+919876543210", "alternatePhone": "+91…", "email": "…",
    "dateOfBirth": "1995-03-07", "gender": "female",
    "address": { "line1": "…", "line2": "…", "city": "…", "state": "…", "pin": "600034" },
    "concerns": ["pregnancy"], "sources": ["google_search"], "sourceOther": "…",
    "guardianReviewRequired": false,
    "consent": true
  }
}
```

Responses: `2xx` = stored. `409` = already have this `reference` (also treated as success). Anything else is retried.
Create the lead on first sight of a `reference`; ignore repeats.

## Pull API (backfill / reconciliation), `Authorization: Bearer <CRM_SHARED_SECRET>`

- `GET /api/crm/leads?since=<cursor>&limit=50` returns `{ ok, leads: [<same body as above>], nextCursor }`. Start with `since=0`.
- `GET /api/crm/leads/count?date=YYYY-MM-DD` returns `{ ok, date, count, bySession: { morning, evening } }` (clinic day, IST; default today).

## Environment variables (registration app, Vercel)

| Variable | Value |
|---|---|
| `CRM_INTAKE_URL` | HTTPS URL of the CRM intake endpoint |
| `CRM_SHARED_SECRET` | 32+ random characters, same value on both sides |
| `CRON_SECRET` | 16+ random characters. Vercel sends it to the cron route as a bearer token |

Without `CRM_INTAKE_URL` and `CRM_SHARED_SECRET` nothing is queued or sent.
Run `node scripts/init-db.mjs` once so the `crm_outbox` table exists.
