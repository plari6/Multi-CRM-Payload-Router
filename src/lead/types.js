/**
 * Shared JSDoc types (no runtime code). Editors use these for autocomplete.
 *
 * @typedef {object} Lead
 * @property {string} id
 * @property {string} firstName
 * @property {string} lastName
 * @property {string} email
 * @property {string} phone
 * @property {string} company
 * @property {string} budgetRaw   Budget exactly as received, e.g. "$25k" or "around 50 thousand".
 * @property {string} currency    ISO code if the sender supplied one.
 * @property {string} source
 * @property {string} message
 *
 * @typedef {object} BudgetResult
 * @property {number|null} amountUsd
 * @property {'rules'|'ai'|'none'} method   How the amount was worked out.
 * @property {string} [note]
 *
 * @typedef {object} RouteResult
 * @property {string} leadId
 * @property {'routed'|'fallback'|'failed'|'skipped'|'duplicate'} status
 * @property {'high'|'low'|''} tier
 * @property {string} destination
 * @property {string} externalId
 * @property {number} attempts
 * @property {string} error
 */
export {};
