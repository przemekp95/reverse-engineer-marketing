# Official Google Ads Transparency data in this fork

Google Ads collection uses `bigquery-public-data.google_ads_transparency_center.creative_stats`
through the official `@google-cloud/bigquery` SDK. It never calls ScrapeCreators for
Google ads, even when that key is present. Other REM sources still use their
existing integrations.

## Install this fork

The published upstream npm package does not contain these changes. Use this checkout:

```sh
git clone https://github.com/przemekp95/reverse-engineer-marketing.git
cd reverse-engineer-marketing
npm ci
npm run build
node dist/cli.js --help
```

The existing npm lockfile and npm workflow are retained. Node >=22 is required;
CI uses Node 24. No separate Google access application or ScrapeCreators subscription
is required for the public dataset. Google terms and Ads Transparency Center
additional terms apply. This uses BigQuery API, not the Google Ads account-management API.

## Authentication and project

Configure Google Application Default Credentials (ADC). For local use, the usual
Google Cloud CLI setup is:

```sh
gcloud auth application-default login
export REM_BIGQUERY_PROJECT_ID=your-project-id
```

`GOOGLE_CLOUD_PROJECT` is also accepted. Workload Identity / an attached service
account and `GOOGLE_APPLICATION_CREDENTIALS` are supported by the SDK. Keep credential
files outside the checkout; never paste tokens into reports or commit credentials.
`gcloud auth login` alone is not ADC. Enable BigQuery API in the execution project
if necessary. The executing identity needs `bigquery.jobs.create` there (for example
BigQuery Job User); organizational policies can also restrict access to public data.
No access to the target company's private Google Ads account is needed or used.

## Choose advertiser identities, once per domain

The public schema has **no destination domain field**. Name matching is not a
reliable identity check. In the [public Google library](https://adstransparency.google.com/),
search the target's domain, verify the advertiser, and take its `AR` ID from
`/advertiser/AR…`. Check agencies/resellers separately. This step is outside BigQuery;
the fork does not scrape the public site's undocumented endpoints.

You may save verified IDs locally, without embedding them in the repository:

```sh
node dist/cli.js google-link example.com AR01847332847816278017
# Multiple IDs for the same target are supported (at most 20).
```

The ID above is a syntax example, not a verified association with example.com.
Mappings live in `~/.config/reverse-engineer-marketing/config.json`:

```json
{"googleAdvertisers":{"example.com":["AR01847332847816278017"]}}
```

Existing config entries are preserved. `REM_CONFIG_DIR` can select a separate
configuration directory. The exact domain and known redirect aliases are checked;
we do not reuse another company's mapping or inherit arbitrary parent-domain IDs.
An explicit per-run list takes precedence, including an empty list to disable a
saved mapping. To remove a saved mapping, delete its domain entry from the config.

A run can override the mapping without saving it:

```sh
node dist/cli.js example.com --only paid --no-ai --google-advertiser AR01847332847816278017
```

Repeat `--google-advertiser` for multiple IDs. The standard website discovery step
still runs. Without a ScrapeCreators key the other paid channels remain Unknown;
Google BigQuery collection still runs independently.

MCP tool `reverse_engineer_marketing` accepts `google_advertiser_ids: ["AR…"]`.
The programmatic API accepts `googleAdvertiserIds: ["AR…"]` in RunOptions. The web
form has an optional advertiser-ID field and otherwise uses the saved domain mapping.
To use this fork through MCP, run `node /absolute/path/to/checkout/dist/cli.js mcp`
with project/ADC configuration available to that process. Do not use upstream `npx`
commands if you expect this fork's behavior.

## Estimate first; cap every execution

```sh
node dist/cli.js google-estimate AR01847332847816278017
```

This performs an uncharged BigQuery dry run, returning `estimatedBytes` and the
configured `maximumBytesBilled`. It does not execute the SELECT. ADC/project IAM
is still required. Comparative live dry runs on 2026-11-15 used the same advertiser
ID (`AR01847332847816278017`) and public table:

| Query | Estimated bytes | GiB |
| --- | ---: | ---: |
| Original (main at `01055aa`): full region/audience JSON and stored URL | 134,434,256,383 | 125.20 |
| Only report fields; still reading the stored URL | 45,762,661,609 | 42.62 |
| Previous lean query with canonical links derived from IDs | 29,040,051,595 | 27.05 |
| Current query: selected regional ranges, reporting periods and audience categories restored | 117,711,646,369 | 109.63 |

The previous minimal query scanned **78.40% less** than the original. The current
query restores useful market context and scans **12.44% less** than the original;
this enrichment costs substantially more to read than dates alone. It keeps counts,
advertiser identities/names, formats, dates and creative-page links, plus selected
regional and audience fields for the sampled creatives. Canonical URL construction
was checked against an actual public row via `tabledata.list` (no query scan);
evidence labels those links as derived. The current SQL passed a fresh Google
dry-run validation. No SELECT was executed to collect ad results.

These are observations, not fixed sizes or price promises; repeat the estimate
with current data. Explicit regional leaf columns are selected, without full raw
JSON or the nested per-surface serving breakdown. Audience metadata includes only
the five documented criterion-usage categories. Limiting the returned sample does
not limit the bytes read for those columns.

The table was unpartitioned and unclustered when checked. Filtering to one
advertiser or limiting output to 20 creatives does **not** make the scan small.
The default hard execution cap is **1 GiB** (`1073741824` bytes), so this dataset
will ordinarily be blocked until you explicitly choose a suitable cap:

```sh
# Example only: review the current estimate and your BigQuery billing/free-tier
# usage before choosing a value. This is not a monthly spending cap.
export REM_BIGQUERY_MAX_BYTES_BILLED=137438953472
node dist/cli.js example.com --only paid --no-ai
```

The example is 128 GiB, above the measured 109.63 GiB enriched scan. The collector never raises the cap automatically and
never falls back to ScrapeCreators. A cap violation, missing identity, auth failure,
or malformed response becomes Unknown, not zero ads. The SDK query uses a 60s
server job timeout (best effort). BigQuery's own per-job byte cap remains the cost
boundary; a timeout/cancellation is not a guarantee that no bytes were billed.

BigQuery offers a free tier, including a sandbox without a card. Queries beyond
available allowances can incur charges in projects with billing enabled. This
fork makes no claim about remaining free allowance in your account. Repeated scans
can exhaust it quickly; the SDK's standard query cache may help identical repeated
queries, but is not guaranteed. No extra application-level data cache is introduced.

## Evidence semantics and limitations

- Counts cover only selected advertiser IDs in **EEA and Turkey**, not global
  activity and not all advertisers linking to a domain. An advertiser may market
  several domains. Identity mapping is user-supplied, not independent proof.
- The query returns scoped total/recent counts plus up to 20 most recently shown
  creatives, deterministically ordered. Counts are decimal strings to preserve INT64.
- The latest regional last-shown date determines recency; null/invalid dates stay
  unknown. Recently seen is `likely`, not `active now`; zero rows never means global
  absence. If some dates are missing and none is recent, status remains Unknown.
- Market context covers **only the sample of at most 20 creatives**, not the full
  advertiser footprint. Each contains at most 40 region records, ordered by region
  code; compare `region_count` with `regions.length` to detect truncation.
- Regional records retain region code, first/last dates, impression lower/upper
  bounds, reporting start/end dates and availability date. Bounds are decimal strings
  to preserve INT64; null means unknown, never zero. Dates must be considered when
  comparing ranges. Do not sum overlapping EEA aggregates and individual countries.
  Impressions are not unique reach, clicks, spend or conversion performance.
- Audience metadata preserves demographic, geographic, contextual, customer-list
  and interest category usage (`CRITERIA_INCLUDED`, `CRITERIA_EXCLUDED`,
  `CRITERIA_INCLUDED_AND_EXCLUDED`, `CRITERIA_UNUSED`). Missing values stay unknown.
  These do not reveal exact segments, keywords, ages, locations or effectiveness,
  and are not enough to reproduce a competitor's campaign settings.
- Data is periodically refreshed and may lag the website. First-shown dates before
  2023-03-01 are clamped by the source.
- No ad copy, destination URLs, image/video URLs, spend, CPC, conversions or ROAS
  are provided by this integration. Content cards link to public ad pages without
  invented thumbnails or active/inactive flags. Removed-ads data is not collected.

## Verification and dependency choice

Run `./.codex/verify`: typecheck, Vitest tests, recorded report eval, and build.
The repository Stop hook calls that entry point, as does GitHub Actions. Hooks load
only in trusted project configuration; direct invocation is not proof of automatic
hook activation. Branch protection is not changed by this feature.

Tests cover collection without ScrapeCreators, official query parameters and cap,
Unknown/error behavior, missing dates, null audience values, large integer impression
ranges, malformed/reversed bounds, dry-run non-execution, target-specific ID
forwarding through the public API/MCP/local HTTP (including the origin guard), redirect mappings, and CLI mapping persistence.
Offline responses exercise behavior; a live metadata read and dry run verify schema,
US location and SQL acceptance. They do not prove that a charged query completed or
that every target identity is correct. Full paid-query execution was not performed.

The official SDK was chosen over custom OAuth/job polling. Version 9.6.1 is pinned,
maintained by Google (registry modified 2026-11-09), Apache-2.0 licensed and compatible
with this MIT application/Node requirement. The lockfile makes its transitive graph
reproducible; it can be replaced behind the single collector module. No advisories
were reported for its new dependency graph in the task audit. `npm audit` did report
four existing vulnerable transitive packages under the upstream MCP SDK: hono,
@hono/node-server, body-parser and fast-uri. They remain outside this integration's
scope; no assertion of a clean repository-wide security audit is made.

Official sources:

- [Dataset and schema README](https://storage.googleapis.com/ads-transparency-center/api-data/README.txt)
- [Marketplace dataset](https://console.cloud.google.com/marketplace/details/bigquery-public-data/google-ads-transparency-center)
- [BigQuery public-data access](https://docs.cloud.google.com/bigquery/public-data)
- [ADC local setup](https://docs.cloud.google.com/docs/authentication/set-up-adc-local-dev-environment)
- [BigQuery cost controls](https://docs.cloud.google.com/bigquery/docs/best-practices-costs)
- [Sandbox/free tier](https://docs.cloud.google.com/bigquery/docs/sandbox)
