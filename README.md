# Multi-CRM Payload Router

Routes inbound leads to the right system based on budget:

| Lead budget | Destination |
| --- | --- |
| **≥ threshold** (default $10,000) | **Salesforce** or **Zoho CRM** (OAuth2) |
| **< threshold** or unknown | **Google Sheets** or **Airtable** |

Leads arrive two ways:

- **Webhooks:** an Express server receives leads from web forms, Typeform, Zapier, Facebook Lead Ads and similar sources.
- **CSV batch:** a CLI routes a whole export and writes a results CSV.

Budgets written as text ("mid five figures", "fifty grand", or a budget mentioned only in the message) are read by **Google Gemini**. Clear formats ("$25k", "€15,000", "10-20k") are parsed locally for free.

```
             ┌──────────────┐   ┌────────────┐   ┌──────────────────┐   ┌─────────────────────────┐
 Webhook ───►│  normalize   │──►│  validate  │──►│  resolve budget  │──►│ ≥ threshold → SF / Zoho │
 CSV row ───►│ (any fields) │   │ (skip bad) │   │ rules → Gemini   │   │ <  threshold → Sheets/AT│
             └──────────────┘   └────────────┘   └──────────────────┘   └───────────┬─────────────┘
                                                                                     │ on failure
                                                              retry w/ backoff ──► fallback sink ──► dead-letter file
```

## Features

- **Field mapping:** accepts `first_name`, `First Name`, `fname`, `name`, `Work Email`, `Deal Size` and other variants.
- **Budget parsing:** handles `$`, `€`, `£`, ISO codes, `k`/`M` suffixes and ranges (midpoint), with conversion to USD.
- **Gemini fallback:** runs only when the rules can't read the budget. It returns structured JSON, and low-confidence answers are ignored.
- **Rate limiting:** each destination and Gemini get their own limiter, so one throttled API doesn't slow the others.
- **Retries:** network errors, 429 and 5xx responses are retried with exponential backoff, and `Retry-After` is honoured.
- **OAuth2 tokens** are cached, refreshed before they expire, and refreshed once more after a 401.
- **No lost leads:** if Salesforce or Zoho fails, the lead goes to the low-budget sink (`status=fallback`). If that also fails, it is written to `output/dead_letter.jsonl` so you can replay it later.
- **AI circuit breaker:** after 3 Gemini failures in a row, AI is turned off for the run and leads keep flowing on rules.
- **Validation:** invalid emails, rows with no name or company, malformed CSV rows and duplicates are reported, never sent.
- **Security:** webhooks are signed with HMAC-SHA256. Google Sheets writes use `RAW` mode and output CSV cells are escaped, both to block formula injection.
- **Dry-run mode:** test everything with no credentials. Payloads are written to `output/dry_run_*.jsonl`.
- **Live progress bar**, end-of-run summary, and graceful Ctrl+C (leads already in progress finish, and the output file is still written).

## Requirements

- Node.js **18.17+** (uses built-in `fetch`)
- Accounts and credentials for the destinations you use (see below)
- Optional: a Gemini API key from [Google AI Studio](https://aistudio.google.com/apikey)

## Setup

```bash
npm install
cp .env.example .env      # Windows PowerShell: Copy-Item .env.example .env
```

Fill in `.env`, then try it without touching any CRM:

```bash
npm run route:dry
```

## Environment variables

### Routing

| Variable | Default | Description |
| --- | --- | --- |
| `HIGH_BUDGET_THRESHOLD` | `10000` | USD amount at or above which a lead is high-budget |
| `HIGH_BUDGET_DESTINATION` | `salesforce` | `salesforce` or `zoho` |
| `LOW_BUDGET_DESTINATION` | `sheets` | `sheets` or `airtable` |
| `DRY_RUN` | `false` | `true` = never call external APIs |

### Gemini

| Variable | Default | Description |
| --- | --- | --- |
| `GEMINI_API_KEY` | – | Enables AI budget extraction. Without it, rules only. |
| `GEMINI_MODEL` | `gemini-2.5-flash` | Any Gemini model that supports JSON output |
| `GEMINI_RPM` | `10` | Max Gemini requests per minute |
| `GEMINI_ENABLED` | `true` | `false` to turn AI off without removing the key |

### Salesforce (OAuth2)

1. In Setup, create an **External Client App** (or Connected App) with OAuth scopes `api` and `refresh_token`.
2. Either enable the **Client Credentials Flow** and assign a "Run As" user, or generate a refresh token once through the web-server flow.

| Variable | Description |
| --- | --- |
| `SALESFORCE_INSTANCE_URL` | e.g. `https://yourcompany.my.salesforce.com` |
| `SALESFORCE_CLIENT_ID` / `SALESFORCE_CLIENT_SECRET` | Consumer key and secret |
| `SALESFORCE_REFRESH_TOKEN` | Optional. If set, the refresh-token flow is used instead of client credentials. |
| `SALESFORCE_API_VERSION` | Default `v61.0` |
| `SALESFORCE_BUDGET_FIELD` | Optional custom number field for the USD budget, e.g. `Budget__c` |

### Zoho CRM (OAuth2)

1. At [api-console.zoho.com](https://api-console.zoho.com), create a **Self Client**.
2. Generate a grant code with scope `ZohoCRM.modules.leads.CREATE`, then exchange it once for a refresh token.

| Variable | Description |
| --- | --- |
| `ZOHO_CLIENT_ID` / `ZOHO_CLIENT_SECRET` / `ZOHO_REFRESH_TOKEN` | Self Client credentials |
| `ZOHO_ACCOUNTS_URL` / `ZOHO_API_DOMAIN` | Change these for EU, IN or AU data centers, e.g. `https://accounts.zoho.eu` |
| `ZOHO_BUDGET_FIELD` | Optional custom field API name |

### Google Sheets

1. In Google Cloud, enable the **Sheets API** and create a **service account** with a JSON key.
2. Share the spreadsheet with the service account email as **Editor**.
3. Add a `Leads` tab with these headers in row 1: `Received At, Lead ID, First Name, Last Name, Email, Phone, Company, Budget (raw), Budget USD, Source, Message`.

| Variable | Description |
| --- | --- |
| `GOOGLE_SHEETS_SPREADSHEET_ID` | The ID from the sheet URL |
| `GOOGLE_SHEETS_RANGE` | Default `Leads!A1` |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | `client_email` from the JSON key |
| `GOOGLE_PRIVATE_KEY` | `private_key` from the JSON key, in quotes, with `\n` kept as-is |

### Airtable

Create a Personal Access Token with scope `data.records:write` for the base. Your table needs these fields: `Lead ID, First Name, Last Name, Email, Phone, Company, Budget (raw), Budget USD (number), Source, Message`.

| Variable | Description |
| --- | --- |
| `AIRTABLE_TOKEN` | Personal Access Token |
| `AIRTABLE_BASE_ID` | Starts with `app...` |
| `AIRTABLE_TABLE` | Default `Leads` |

### Server and delivery

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `3000` | Webhook server port |
| `WEBHOOK_SECRET` | – | HMAC secret. **Set this in production.** |
| `DESTINATION_RPM` | `60` | Max requests per minute per destination (Airtable is capped at 300) |
| `MAX_RETRIES` | `3` | Retries for 429, 5xx and network errors |
| `CONCURRENCY` | `3` | Leads in flight during CSV runs |
| `DEAD_LETTER_FILE` | `output/dead_letter.jsonl` | Where undeliverable leads are saved |
| `BUDGET_FX_RATES` | built-in | JSON to override currency rates, e.g. `{"EUR":1.1}` |

## Usage

### Route a CSV file

```bash
node index.js route --input data/sample_leads.csv --output output/routed_leads.csv
node index.js route -i leads.csv --dry-run                         # no external calls
node index.js route -i leads.csv --threshold 25000 --high zoho --low airtable
node index.js route -i leads.csv --no-ai --concurrency 5
```

The input CSV needs at least an email and a name or company. Column names are flexible. See [data/sample_leads.csv](data/sample_leads.csv), which also includes bad rows on purpose to show validation.

**Output columns:** `row, lead_id, email, company, budget_raw, budget_usd, budget_method (rules|ai|none), tier (high|low), destination, status, external_id, attempts, error, duration_ms, processed_at`

| `status` | Meaning |
| --- | --- |
| `routed` | Delivered to its primary destination |
| `fallback` | High-budget CRM failed, so it was delivered to the low-budget sink instead |
| `failed` | Every destination failed; saved to the dead-letter file |
| `skipped` | Invalid or malformed row; not sent |
| `duplicate` | Same lead ID already processed in this run |

The exit code is `0` on success, `1` for a configuration or input error, and `2` if any lead failed.

### Run the webhook server

```bash
npm start                    # or: node index.js serve --port 8080 [--dry-run]
```

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/webhooks/lead` | One lead object or an array (max 100). Returns **202** with `lead_id` and `status_url`. Add `?sync=true` to wait for the routing result. |
| `GET` | `/leads/:id` | Routing result for a lead |
| `GET` | `/health` | Status, routing settings, which destinations are configured |
| `GET` | `/stats` | Counters since start |

When `WEBHOOK_SECRET` is set, requests must include `X-Signature: sha256=<hex HMAC-SHA256 of the raw body>`:

```bash
BODY='{"name":"Grace Hopper","email":"grace@navy.mil","company":"US Navy","budget":"$80k"}'
curl -X POST "http://localhost:3000/webhooks/lead?sync=true" \
  -H "Content-Type: application/json" \
  -H "X-Signature: $(node index.js sign "$BODY")" \
  -d "$BODY"
```

### Replay failed leads

```bash
node index.js replay                    # re-sends output/dead_letter.jsonl
```

The old file is renamed to `*.replayed-<timestamp>.jsonl`. Leads that fail again go into a fresh dead-letter file.

## Tests

```bash
npm test
```

Covers budget parsing, field mapping and validation, tier routing, duplicates, fallback, the dead-letter file, when AI is used, webhook signatures, and CSV escaping. Tests use fake destinations, so no network is needed.

## Project structure

```
index.js                         CLI (route | serve | replay | sign)
src/
  config.js                      All settings from .env
  router.js                      Core: validate → budget → tier → deliver → fallback
  server.js                      Express webhook server
  lead/normalize.js              Field mapping + validation
  lead/budget.js                 Rule-based budget parser + currency conversion
  ai/geminiBudgetExtractor.js    Gemini structured extraction + circuit breaker
  adapters/                      salesforce, zoho, googleSheets, airtable, dryRun
  auth/tokenCache.js             OAuth2 token caching / refresh
  pipeline/csvProcessor.js       Streaming CSV batch runner
  utils/                         rate limiter, retry/backoff, CSV writer, logger
data/sample_leads.csv            Example input
test/                            node:test unit tests
```

## Notes

- Currency rates in `src/lead/budget.js` are approximate. They are used only to pick a tier. Override them with `BUDGET_FX_RATES`.
- Duplicate detection and `/leads/:id` results are kept in memory. If you run several server instances, put Redis or a database behind them.
- Leads without a readable budget go to the low-budget sink with `budget_method=none` so a person can qualify them.
