/**
 * Central configuration.
 *
 * Every setting comes from environment variables (loaded from .env by dotenv)
 * so the same code runs locally, in CI, and in production without edits.
 */
import 'dotenv/config';

const num = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const bool = (value, fallback = false) => {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
};

export const config = {
  routing: {
    // Leads with a budget >= this value (in USD) go to the high-budget CRM.
    highBudgetThreshold: num(process.env.HIGH_BUDGET_THRESHOLD, 10000),
    // 'salesforce' | 'zoho'
    highBudgetDestination: (process.env.HIGH_BUDGET_DESTINATION || 'salesforce').toLowerCase(),
    // 'sheets' | 'airtable'
    lowBudgetDestination: (process.env.LOW_BUDGET_DESTINATION || 'sheets').toLowerCase(),
    // When true, nothing is sent to external systems; payloads are logged instead.
    dryRun: bool(process.env.DRY_RUN, false),
  },

  gemini: {
    apiKey: process.env.GEMINI_API_KEY || '',
    model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
    // Requests per minute allowed to Gemini (free tier is ~10-15 RPM).
    rpm: num(process.env.GEMINI_RPM, 10),
    // Set to false to always use the rule-based budget parser.
    enabled: bool(process.env.GEMINI_ENABLED, true),
  },

  salesforce: {
    // e.g. https://yourcompany.my.salesforce.com
    instanceUrl: process.env.SALESFORCE_INSTANCE_URL || '',
    clientId: process.env.SALESFORCE_CLIENT_ID || '',
    clientSecret: process.env.SALESFORCE_CLIENT_SECRET || '',
    // Optional: when set, the refresh-token flow is used instead of client credentials.
    refreshToken: process.env.SALESFORCE_REFRESH_TOKEN || '',
    apiVersion: process.env.SALESFORCE_API_VERSION || 'v61.0',
  },

  zoho: {
    // Data-center specific, e.g. https://accounts.zoho.eu
    accountsUrl: process.env.ZOHO_ACCOUNTS_URL || 'https://accounts.zoho.com',
    apiDomain: process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.com',
    clientId: process.env.ZOHO_CLIENT_ID || '',
    clientSecret: process.env.ZOHO_CLIENT_SECRET || '',
    refreshToken: process.env.ZOHO_REFRESH_TOKEN || '',
  },

  sheets: {
    spreadsheetId: process.env.GOOGLE_SHEETS_SPREADSHEET_ID || '',
    range: process.env.GOOGLE_SHEETS_RANGE || 'Leads!A1',
    serviceAccountEmail: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || '',
    // Private keys in .env usually have literal "\n" sequences; turn them into real newlines.
    privateKey: (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
  },

  airtable: {
    token: process.env.AIRTABLE_TOKEN || '',
    baseId: process.env.AIRTABLE_BASE_ID || '',
    table: process.env.AIRTABLE_TABLE || 'Leads',
  },

  server: {
    port: num(process.env.PORT, 3000),
    // Shared secret for HMAC-SHA256 signature verification of incoming webhooks.
    webhookSecret: process.env.WEBHOOK_SECRET || '',
  },

  delivery: {
    // Requests per minute per destination (protects against CRM API throttling).
    destinationRpm: num(process.env.DESTINATION_RPM, 60),
    maxRetries: num(process.env.MAX_RETRIES, 3),
    // Concurrent leads in flight during CSV batch processing.
    concurrency: num(process.env.CONCURRENCY, 3),
    // Leads that fail every attempt are appended here so nothing is lost.
    deadLetterFile: process.env.DEAD_LETTER_FILE || 'output/dead_letter.jsonl',
  },
};

/** Returns true when every listed value is a non-empty string. */
export const hasAll = (...values) => values.every((v) => typeof v === 'string' && v.length > 0);
