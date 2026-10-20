import type { RegistrationRecord } from "../registration/rules.ts";

/** Label the CRM files these leads under, inside its main leads list. */
export const CRM_LEAD_SOURCE = "clinic_registration";
export const CRM_LEAD_CATEGORY = "Clinic registrations";

export interface CrmLeadEvent {
  event: "clinic_registration.created";
  /** Unique per registration: the CRM upserts on this, so retries never duplicate a lead. */
  reference: string;
  clinicId: string;
  clinicDate: string;
  registeredAt: string;
  lead: {
    source: typeof CRM_LEAD_SOURCE;
    category: typeof CRM_LEAD_CATEGORY;
    name: string;
    phone: string;
    alternatePhone?: string;
    email?: string;
    dateOfBirth: string;
    gender: string;
    address: RegistrationRecord["address"];
    concerns: string[];
    sources: string[];
    sourceOther?: string;
    guardianReviewRequired: boolean;
    consent: true;
  };
}

/** The signature image stays in this app: it is large and not needed to follow up a lead. */
export function buildLeadEvent(input: {
  reference: string;
  clinicId: string;
  clinicDate: string;
  registeredAt: string;
  record: RegistrationRecord;
}): CrmLeadEvent {
  const { record } = input;
  return {
    event: "clinic_registration.created",
    reference: input.reference,
    clinicId: input.clinicId,
    clinicDate: input.clinicDate,
    registeredAt: input.registeredAt,
    lead: {
      source: CRM_LEAD_SOURCE,
      category: CRM_LEAD_CATEGORY,
      name: record.fullName,
      phone: record.phone,
      alternatePhone: record.alternatePhone,
      email: record.email,
      dateOfBirth: record.dateOfBirth,
      gender: record.gender,
      address: record.address,
      concerns: [...record.concerns],
      sources: [...record.sources],
      sourceOther: record.sourceOther,
      guardianReviewRequired: record.flags.guardianReviewRequired,
      consent: true,
    },
  };
}
