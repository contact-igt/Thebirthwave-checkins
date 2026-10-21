/**
 * Registration rules shared by the browser flow and the server endpoint.
 *
 * Deliberately dependency-free (no imports) so the same file validates in the
 * browser, in the route handler and under `node --test`. Nothing in here logs,
 * stores or transmits anything.
 */

// ---------------------------------------------------------------------------
// Options (mirrors the paper Registration Form)
// ---------------------------------------------------------------------------

export const CONCERNS = [
  {
    id: "pregnancy",
    label: "Pregnancy",
    description: "Antenatal check-ups, pregnancy guidance, and care through each trimester.",
  },
  {
    id: "fertility",
    label: "Fertility",
    description: "Planning a pregnancy, preconception advice, or support with conception.",
  },
  {
    id: "gynaecology",
    label: "Gynaecology",
    description: "Periods, hormonal changes, pelvic health, or other women’s health concerns.",
  },
  {
    id: "paediatrics",
    label: "Paediatrics",
    description: "Newborn and child health, growth, feeding, or routine care.",
  },
  {
    id: "vbac",
    label: "VBAC",
    description: "Vaginal birth after a previous caesarean: planning and discussing your options.",
  },
  {
    id: "vaginismus",
    label: "Vaginismus",
    description: "Supportive, sensitive care for intimate health concerns, in a private and respectful setting.",
  },
  {
    id: "not_sure",
    label: "Not sure yet",
    description: "That’s perfectly fine. Our reception team will help you choose.",
  },
] as const;

export const SOURCES = [
  { id: "doctor", label: "Doctor" },
  { id: "google_maps", label: "Google Maps" },
  { id: "google_search", label: "Google Search" },
  { id: "friends_family", label: "Friends / Family" },
  { id: "chatgpt", label: "ChatGPT" },
  { id: "instagram", label: "Instagram" },
  { id: "facebook", label: "Facebook" },
  { id: "youtube", label: "YouTube" },
  { id: "other", label: "Other" },
] as const;

/** Set to true only if the clinic asks for an inclusive third option. */
export const ALLOW_PREFER_NOT_TO_SAY = false;

export const GENDERS = [
  { id: "male", label: "Male" },
  { id: "female", label: "Female" },
  ...(ALLOW_PREFER_NOT_TO_SAY ? ([{ id: "prefer_not_to_say", label: "Prefer not to say" }] as const) : []),
] as const;

export const INDIAN_STATES = [
  "Andhra Pradesh",
  "Arunachal Pradesh",
  "Assam",
  "Bihar",
  "Chhattisgarh",
  "Goa",
  "Gujarat",
  "Haryana",
  "Himachal Pradesh",
  "Jharkhand",
  "Karnataka",
  "Kerala",
  "Madhya Pradesh",
  "Maharashtra",
  "Manipur",
  "Meghalaya",
  "Mizoram",
  "Nagaland",
  "Odisha",
  "Punjab",
  "Rajasthan",
  "Sikkim",
  "Tamil Nadu",
  "Telangana",
  "Tripura",
  "Uttar Pradesh",
  "Uttarakhand",
  "West Bengal",
  "Andaman and Nicobar Islands",
  "Chandigarh",
  "Dadra and Nagar Haveli and Daman and Diu",
  "Delhi",
  "Jammu and Kashmir",
  "Ladakh",
  "Lakshadweep",
  "Puducherry",
] as const;

export type ConcernId = (typeof CONCERNS)[number]["id"];
export type SourceId = (typeof SOURCES)[number]["id"];
export type GenderId = (typeof GENDERS)[number]["id"];
export type SignatureMethod = "drawn" | "typed";
export type StepId = "name" | "birth" | "contact" | "address" | "concerns" | "sources" | "review";

/** The counted stages, in order. Progress and "Step X of Y" derive from this. */
export const STEP_ORDER: readonly StepId[] = [
  "name",
  "birth",
  "contact",
  "address",
  "concerns",
  "sources",
  "review",
];

export const MAX_SIGNATURE_CHARS = 200_000;
export const MAX_BODY_BYTES = 300_000;
const PNG_PREFIX = "data:image/png;base64,";

export interface Answers {
  fullName: string;
  dobDay: string;
  dobMonth: string;
  dobYear: string;
  gender: "" | GenderId;
  phone: string;
  altPhone: string;
  email: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  state: string;
  pin: string;
  concerns: ConcernId[];
  sources: SourceId[];
  sourceOther: string;
  consent: boolean;
  signatureMethod: SignatureMethod;
  signatureData: string;
  signatureTyped: string;
}

export const EMPTY_ANSWERS: Answers = {
  fullName: "",
  dobDay: "",
  dobMonth: "",
  dobYear: "",
  gender: "",
  phone: "",
  altPhone: "",
  email: "",
  addressLine1: "",
  addressLine2: "",
  city: "",
  state: "",
  pin: "",
  concerns: [],
  sources: [],
  sourceOther: "",
  consent: false,
  signatureMethod: "drawn",
  signatureData: "",
  signatureTyped: "",
};

export type FieldErrors = Partial<Record<string, string>>;

// ---------------------------------------------------------------------------
// Dates (clinic time zone: Asia/Kolkata)
// ---------------------------------------------------------------------------

const IST_FORMAT = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Kolkata",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** Today's date in the clinic's time zone, as YYYY-MM-DD. */
export function registrationDateIST(now: Date = new Date()): string {
  const parts = Object.fromEntries(IST_FORMAT.formatToParts(now).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** The clinic runs two OP sessions a day; each has its own registration numbering. */
export const OP_SESSIONS = ["morning", "evening"] as const;
export type OpSession = (typeof OP_SESSIONS)[number];
export const OP_SESSION_LABEL: Record<OpSession, string> = { morning: "Morning OP", evening: "Evening OP" };
export const OP_SESSION_CODE: Record<OpSession, string> = { morning: "M", evening: "E" };
export const DEFAULT_EVENING_STARTS = "14:00";

export function isOpSession(value: unknown): value is OpSession {
  return value === "morning" || value === "evening";
}

/**
 * Which OP session a registration belongs to, by the clock in IST: before the evening start
 * (default 14:00, set `OP_EVENING_STARTS=HH:MM` to move it) is morning, from then on is evening.
 */
export function opSessionIST(now: Date = new Date(), eveningStarts: string = DEFAULT_EVENING_STARTS): OpSession {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(eveningStarts.trim());
  const [h, m] = match ? [Number(match[1]), Number(match[2])] : [14, 0];
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  return Number(parts.hour) * 60 + Number(parts.minute) >= h * 60 + m ? "evening" : "morning";
}

/** YYYY-MM-DD → DD/MM/YYYY (India). */
export function formatDateIN(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function calculateAge(dobISO: string, now: Date = new Date()): number {
  const [y, m, d] = dobISO.split("-").map(Number);
  const [ty, tm, td] = registrationDateIST(now).split("-").map(Number);
  let age = ty - y;
  if (tm < m || (tm === m && td < d)) age -= 1;
  return age;
}

// ---------------------------------------------------------------------------
// Field validators — each returns an error message, or null when valid
// ---------------------------------------------------------------------------

export function collapse(value: string, max: number): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

const NAME_PATTERN = /^[\p{L}\p{M}][\p{L}\p{M}\s.'’-]*$/u;

export function validateFullName(value: string): string | null {
  const v = collapse(value, 400);
  if (!v) return "Please enter your full name.";
  if (v.length > 100) return "Please use 100 characters or fewer.";
  const letters = (v.match(/\p{L}/gu) ?? []).length;
  if (letters < 2 || !NAME_PATTERN.test(v)) return "Please enter your name using letters only.";
  return null;
}

export function normaliseIndianMobile(value: string): string | null {
  let digits = value.replace(/[\s\-().]/g, "");
  if (digits.startsWith("+")) digits = digits.slice(1);
  if (!/^\d+$/.test(digits)) return null;
  if (digits.length === 12 && digits.startsWith("91")) digits = digits.slice(2);
  else if (digits.length === 11 && digits.startsWith("0")) digits = digits.slice(1);
  return /^[6-9]\d{9}$/.test(digits) ? `+91${digits}` : null;
}

export function validateMobile(value: string, required: boolean): string | null {
  if (!value.trim()) return required ? "Please enter a mobile number." : null;
  return normaliseIndianMobile(value) ? null : "Please enter a 10-digit Indian mobile number.";
}

export function validateEmail(value: string): string | null {
  const v = value.trim();
  if (!v) return null;
  if (v.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v)) return "Please enter a valid email address.";
  return null;
}

export function validateDob(day: string, month: string, year: string, now: Date = new Date()): string | null {
  if (!day.trim() || !month.trim() || !year.trim()) return "Please enter your full date of birth.";
  if (!/^\d{1,2}$/.test(day.trim()) || !/^\d{1,2}$/.test(month.trim()) || !/^\d{4}$/.test(year.trim())) {
    return "Please enter the date as day, month and a 4-digit year.";
  }
  const d = Number(day);
  const m = Number(month);
  const y = Number(year);
  if (m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) return "That date doesn’t exist. Please check it.";
  if (y < 1900) return "Please check the year of birth.";
  const iso = `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  if (iso > registrationDateIST(now)) return "Date of birth can’t be in the future.";
  return null;
}

export function dobToISO(day: string, month: string, year: string): string {
  return `${year.trim().padStart(4, "0")}-${month.trim().padStart(2, "0")}-${day.trim().padStart(2, "0")}`;
}

export function validatePin(value: string): string | null {
  const v = value.trim();
  if (!v) return "Please enter your PIN code.";
  return /^[1-9]\d{5}$/.test(v) ? null : "Please enter a valid 6-digit PIN code.";
}

const inOrder = <T extends string>(options: ReadonlyArray<{ id: T }>, picked: readonly T[]): T[] =>
  options.map((o) => o.id).filter((id) => picked.includes(id));

/** Selections always keep the order of the options on screen, not click order. */
export function toggleConcern(current: readonly ConcernId[], id: ConcernId): ConcernId[] {
  if (current.includes(id)) return current.filter((c) => c !== id);
  if (id === "not_sure") return ["not_sure"];
  return inOrder(CONCERNS, [...current.filter((c) => c !== "not_sure"), id]);
}

export function toggleSource(current: readonly SourceId[], id: SourceId): SourceId[] {
  return inOrder(SOURCES, current.includes(id) ? current.filter((s) => s !== id) : [...current, id]);
}

function isConcern(v: unknown): v is ConcernId {
  return CONCERNS.some((c) => c.id === v);
}
function isSource(v: unknown): v is SourceId {
  return SOURCES.some((s) => s.id === v);
}
function isGender(v: unknown): v is GenderId {
  return GENDERS.some((g) => g.id === v);
}

function signatureError(a: Pick<Answers, "signatureMethod" | "signatureData" | "signatureTyped">): string | null {
  if (a.signatureMethod === "typed") {
    return validateFullName(a.signatureTyped) ? "Please type your full name as your signature." : null;
  }
  if (a.signatureMethod !== "drawn") return "Please sign to continue.";
  const data = a.signatureData;
  if (!data) return "Please sign in the box, or type your name instead.";
  if (!data.startsWith(PNG_PREFIX) || data.length > MAX_SIGNATURE_CHARS) return "That signature couldn’t be read. Please sign again.";
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data.slice(PNG_PREFIX.length))) return "That signature couldn’t be read. Please sign again.";
  return null;
}

/** Validate one displayed stage. The review stage re-checks the consent and signature. */
export function validateStep(step: StepId, a: Answers, now: Date = new Date()): FieldErrors {
  const errors: FieldErrors = {};
  const set = (key: string, message: string | null) => {
    if (message) errors[key] = message;
  };

  switch (step) {
    case "name":
      set("fullName", validateFullName(a.fullName));
      break;
    case "birth":
      set("dob", validateDob(a.dobDay, a.dobMonth, a.dobYear, now));
      if (!isGender(a.gender)) errors.gender = "Please choose one option.";
      break;
    case "contact":
      set("phone", validateMobile(a.phone, true));
      set("altPhone", validateMobile(a.altPhone, false));
      set("email", validateEmail(a.email));
      break;
    case "address": {
      const line1 = collapse(a.addressLine1, 400);
      if (!line1) errors.addressLine1 = "Please enter your address.";
      else if (line1.length > 120) errors.addressLine1 = "Please use 120 characters or fewer.";
      if (collapse(a.addressLine2, 400).length > 120) errors.addressLine2 = "Please use 120 characters or fewer.";
      const city = collapse(a.city, 400);
      if (!city) errors.city = "Please enter your city.";
      else if (city.length > 60) errors.city = "Please use 60 characters or fewer.";
      if (!(INDIAN_STATES as readonly string[]).includes(a.state)) errors.state = "Please choose your state.";
      set("pin", validatePin(a.pin));
      break;
    }
    case "concerns":
      if (a.concerns.length === 0) errors.concerns = "Please choose at least one option, or “Not sure yet”.";
      break;
    case "sources":
      if (a.sources.length === 0) errors.sources = "Please choose at least one option.";
      if (a.sources.includes("other")) {
        const other = collapse(a.sourceOther, 400);
        if (!other) errors.sourceOther = "Please tell us a little more.";
        else if (other.length > 80) errors.sourceOther = "Please use 80 characters or fewer.";
      }
      break;
    case "review":
      if (a.consent !== true) errors.consent = "Please confirm to continue.";
      set("signature", signatureError(a));
      break;
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Server-side payload validation and normalisation
// ---------------------------------------------------------------------------

export interface RegistrationRecord {
  registrationDate: string;
  fullName: string;
  dateOfBirth: string;
  gender: GenderId;
  phone: string;
  alternatePhone?: string;
  email?: string;
  address: { line1: string; line2?: string; city: string; state: string; pin: string };
  concerns: ConcernId[];
  sources: SourceId[];
  sourceOther?: string;
  consent: true;
  signature: { method: SignatureMethod; imagePng?: string; typedName?: string };
  flags: { guardianReviewRequired: boolean; typedSignaturePendingClinicApproval: boolean };
}

export type ValidationResult =
  | { ok: true; value: RegistrationRecord }
  | { ok: false; errors: FieldErrors };

const STRING_FIELDS = [
  "fullName",
  "dobDay",
  "dobMonth",
  "dobYear",
  "gender",
  "phone",
  "altPhone",
  "email",
  "addressLine1",
  "addressLine2",
  "city",
  "state",
  "pin",
  "sourceOther",
  "signatureMethod",
  "signatureData",
  "signatureTyped",
] as const;

export function validateRegistration(input: unknown, now: Date = new Date()): ValidationResult {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, errors: { body: "Invalid request." } };
  }
  const raw = input as Record<string, unknown>;
  const errors: FieldErrors = {};

  const text: Record<string, string> = {};
  for (const key of STRING_FIELDS) {
    const v = raw[key];
    if (v === undefined || v === null) text[key] = "";
    else if (typeof v === "string") text[key] = v;
    else errors[key] = "Invalid value.";
  }
  if (!Array.isArray(raw.concerns) || !raw.concerns.every(isConcern)) errors.concerns = "Invalid value.";
  if (!Array.isArray(raw.sources) || !raw.sources.every(isSource)) errors.sources = "Invalid value.";
  if (raw.consent !== true) errors.consent = "Consent is required.";
  if (Object.keys(errors).length > 0) return { ok: false, errors };

  const answers: Answers = {
    fullName: text.fullName,
    dobDay: text.dobDay,
    dobMonth: text.dobMonth,
    dobYear: text.dobYear,
    gender: text.gender as Answers["gender"],
    phone: text.phone,
    altPhone: text.altPhone,
    email: text.email,
    addressLine1: text.addressLine1,
    addressLine2: text.addressLine2,
    city: text.city,
    state: text.state,
    pin: text.pin,
    concerns: inOrder(CONCERNS, raw.concerns as ConcernId[]),
    sources: inOrder(SOURCES, raw.sources as SourceId[]),
    sourceOther: text.sourceOther,
    consent: true,
    signatureMethod: text.signatureMethod as SignatureMethod,
    signatureData: text.signatureData,
    signatureTyped: text.signatureTyped,
  };

  for (const step of STEP_ORDER) Object.assign(errors, validateStep(step, answers, now));
  if (answers.concerns.includes("not_sure") && answers.concerns.length > 1) errors.concerns = "Invalid combination.";
  if (Object.keys(errors).length > 0) return { ok: false, errors };

  const dateOfBirth = dobToISO(answers.dobDay, answers.dobMonth, answers.dobYear);
  const line2 = collapse(answers.addressLine2, 120);
  const alt = answers.altPhone.trim() ? normaliseIndianMobile(answers.altPhone) : null;
  const email = answers.email.trim().toLowerCase();
  const other = answers.sources.includes("other") ? collapse(answers.sourceOther, 80) : "";
  const typed = answers.signatureMethod === "typed";

  const value: RegistrationRecord = {
    registrationDate: registrationDateIST(now),
    fullName: collapse(answers.fullName, 100),
    dateOfBirth,
    gender: answers.gender as GenderId,
    phone: normaliseIndianMobile(answers.phone) as string,
    ...(alt ? { alternatePhone: alt } : {}),
    ...(email ? { email } : {}),
    address: {
      line1: collapse(answers.addressLine1, 120),
      ...(line2 ? { line2 } : {}),
      city: collapse(answers.city, 60),
      state: answers.state,
      pin: answers.pin.trim(),
    },
    concerns: answers.concerns,
    sources: answers.sources,
    ...(other ? { sourceOther: other } : {}),
    consent: true,
    signature: typed
      ? { method: "typed", typedName: collapse(answers.signatureTyped, 100) }
      : { method: "drawn", imagePng: answers.signatureData },
    flags: {
      guardianReviewRequired: calculateAge(dateOfBirth, now) < 18 || answers.concerns.includes("paediatrics"),
      typedSignaturePendingClinicApproval: typed,
    },
  };
  return { ok: true, value };
}
