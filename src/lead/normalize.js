/**
 * Turns any incoming payload (CSV row, web form, Typeform, Facebook Lead Ads...)
 * into one consistent lead shape, then validates it.
 *
 * Field names differ between sources, so each field has a list of accepted aliases.
 * Matching ignores case, spaces, dashes and underscores ("First Name" == "first_name").
 */
import { createHash } from 'node:crypto';

const FIELD_ALIASES = {
  id: ['id', 'leadid', 'externalid', 'eventid', 'submissionid'],
  firstName: ['firstname', 'fname', 'givenname'],
  lastName: ['lastname', 'lname', 'surname', 'familyname'],
  fullName: ['name', 'fullname', 'contactname'],
  email: ['email', 'emailaddress', 'workemail', 'mail'],
  phone: ['phone', 'phonenumber', 'mobile', 'tel', 'telephone'],
  company: ['company', 'companyname', 'organization', 'organisation', 'business', 'account'],
  budget: ['budget', 'budgetraw', 'budgetusd', 'estimatedbudget', 'dealsize', 'dealvalue', 'amount', 'projectbudget'],
  currency: ['currency', 'budgetcurrency'],
  source: ['source', 'leadsource', 'utmsource', 'channel'],
  message: ['message', 'notes', 'comments', 'description', 'details', 'projectdetails'],
};

const canon = (key) => String(key).toLowerCase().replace(/[\s_\-.]/g, '');

// Basic, practical email check (full RFC 5322 validation is not useful here).
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Collapse whitespace and strip control characters that break CSVs and CRM fields. */
const clean = (value, maxLength = 255) =>
  value === undefined || value === null
    ? ''
    : String(value)
        .replace(/[\u0000-\u001F\u007F]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, maxLength);

/**
 * @param {Record<string, unknown>} raw  Arbitrary key/value payload.
 * @returns {import('./types.js').Lead}
 */
export function normalizeLead(raw = {}) {
  // Index the payload by canonical key once.
  const byKey = new Map();
  for (const [key, value] of Object.entries(raw ?? {})) byKey.set(canon(key), value);

  const pick = (field, maxLength) => {
    for (const alias of FIELD_ALIASES[field]) {
      const v = clean(byKey.get(alias), maxLength);
      if (v) return v;
    }
    return '';
  };

  let firstName = pick('firstName', 80);
  let lastName = pick('lastName', 80);
  const fullName = pick('fullName', 160);
  if (!firstName && !lastName && fullName) {
    const parts = fullName.split(' ');
    firstName = parts.length > 1 ? parts.slice(0, -1).join(' ') : '';
    lastName = parts.at(-1);
  }

  const email = pick('email', 254).toLowerCase();

  const lead = {
    id: pick('id', 100),
    firstName,
    lastName,
    email,
    phone: pick('phone', 40),
    company: pick('company', 255),
    budgetRaw: pick('budget', 120),
    currency: pick('currency', 3).toUpperCase(),
    source: pick('source', 80) || 'unknown',
    message: pick('message', 2000),
  };

  // A stable ID lets webhook retries be de-duplicated even when the sender gives none.
  if (!lead.id) {
    lead.id = `lead_${createHash('sha256')
      .update(`${lead.email}|${lead.company}|${lead.budgetRaw}`)
      .digest('hex')
      .slice(0, 12)}`;
  }
  return lead;
}

/**
 * Checks a normalized lead.
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateLead(lead) {
  const errors = [];
  if (!lead.email) errors.push('missing email');
  else if (!EMAIL_RE.test(lead.email)) errors.push(`invalid email "${lead.email}"`);

  // CRMs (Salesforce in particular) need a last name and a company.
  if (!lead.lastName && !lead.company) errors.push('missing name and company');

  if (lead.currency && !/^[A-Z]{3}$/.test(lead.currency)) errors.push(`invalid currency "${lead.currency}"`);

  return { valid: errors.length === 0, errors };
}
