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

## Fetch competitors together and reuse local results

Save each competitor's verified advertiser mapping with `google-link`, then fetch
up to 20 domains together. Each domain may have up to 20 advertiser IDs. These are
still explicit domain-to-identity mappings, not inferred destination domains.

```sh
# These are syntax examples, not verified ownership associations.
node dist/cli.js google-link example.com AR01847332847816278017
node dist/cli.js google-link competitor.example AR00000000000000000001
node dist/cli.js google-fetch example.com competitor.example --dry-run
# After reviewing the estimate and explicitly choosing a sufficient execution cap:
node dist/cli.js google-fetch example.com competitor.example
```

`google-fetch` makes one BigQuery query for the missing/expired competitors, then
saves a separate snapshot for each exact advertiser-ID set. **Each competitor gets
its own complete scoped counts and up to 20 most recently shown creatives**, not a
shared pool of 20. All existing report fields survive: identities, names, formats,
links, dates, regional impression ranges and periods, and audience categories.
Overlapping IDs across competitors remain explicitly associated with each requested
identity set; a multi-ID competitor is aggregated before selecting its own sample.
A completed query with no rows for a requested identity set is recorded as zero in
that scope. A failed or malformed query is never recorded as zero.

The JSON command summary reports cache hits and fetched **unique identity groups**,
requested domain count, advertiser IDs,
`fetchedAt`, and the UTC `asOfDate` used for the 30-day counts. An ordinary report
then reuses the matching snapshot automatically through CLI, MCP, or the web app:

```sh
node dist/cli.js example.com --only paid --no-ai
node dist/cli.js competitor.example --only paid --no-ai
# Bypass saved results and fetch a new snapshot for these competitors:
node dist/cli.js google-fetch example.com competitor.example --refresh
```

A local hit requires the exact same sorted ID set and a valid snapshot less than
24 hours old. Changing a saved mapping cannot silently reuse another identity set.
Evidence identifies the original fetch time and reference date; reuse does not
claim a new live check. All fields are retained, but the snapshot represents the
source as fetched, and the 30-day counters remain relative to its `asOfDate`.
An expired, future-dated, incompatible or corrupt snapshot is a miss, not a reason
to accept stale data; a subsequent lookup failure remains Unknown. There is no
stale fallback when refresh fails.

Snapshots are JSON files under
`$REM_CACHE_DIR/google-ads/`, or
`~/.cache/reverse-engineer-marketing/google-ads/` by default. Filenames hash the
schema version, source table and canonical ID set. Writes use an atomic replacement,
with private directory/file permissions (0700/0600). They store report data and
provenance, never ADC credentials or API keys. A valid local hit needs no BigQuery
project or credentials; a miss/refresh still requires the normal Google setup.

`--dry-run` estimates only missing/expired groups, or all requested groups with
`--refresh`; it neither executes the SELECT nor writes snapshots. Cache-only runs
need no query. The default 1 GiB cap is unchanged and applies to the **whole batch**.
The batch is a cost-saving collection step, not a parallel series of per-competitor
scans. No recurring job, Google dataset, or cloud storage resource is created.

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
| Restored context before region-count projection fix | 117,711,646,369 | 109.63 |
| Current query: same report fields, count regions through a single projected leaf | 68,144,943,841 | 63.46 |
| Batched target groups (including overlapping IDs and a multi-ID target), same report fields | 68,144,943,841 | 63.46 |

The previous minimal query scanned **78.40% less** than the original. The current
query retains useful market context and scans **49.31% less** than the original;
this enrichment still costs more to read than dates alone. Counting regions through
`ARRAY_LENGTH(ARRAY(SELECT r.region_code FROM UNNEST(region_stats) r))` instead of
`ARRAY_LENGTH(region_stats)` avoids reading unused nested surface statistics. A
comparative live dry run reduced the estimate **42.11%** versus 109.63 GiB without
removing any report fields; `COUNT(*) FROM UNNEST(region_stats)` did not save bytes.
Projection preserves array length, including records with null region codes. It keeps counts,
advertiser identities/names, formats, dates and creative-page links, plus selected
regional and audience fields for the sampled creatives. Canonical URL construction
was checked against an actual public row via `tabledata.list` (no query scan);
evidence labels those links as derived. The current SQL passed a fresh Google
dry-run validation. No SELECT was executed to collect ad results.

The final batch query was independently accepted by a live dry run with separate
target identity groups (including overlapping advertiser IDs). It retains counts
and a separate top-20 sample per group at the same estimated scan size. This
validates SQL and estimated bytes, not live paid-query results.

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
export REM_BIGQUERY_MAX_BYTES_BILLED=85899345920
node dist/cli.js example.com --only paid --no-ai
```

The example is 80 GiB, above the measured 63.46 GiB optimized enriched scan. The collector never raises the cap automatically and
never falls back to ScrapeCreators. A cap violation, missing identity, auth failure,
or malformed response becomes Unknown, not zero ads. The SDK query uses a 60s
server job timeout (best effort). BigQuery's own per-job byte cap remains the cost
boundary; a timeout/cancellation is not a guarantee that no bytes were billed.

BigQuery offers a free tier, including a sandbox without a card. Queries beyond
available allowances can incur charges in projects with billing enabled. This
fork makes no claim about remaining free allowance in your account. Repeated scans
can exhaust it quickly. The application-level 24-hour snapshots above avoid repeated
scans for the same identity set. The SDK's standard query cache is separate and is
not guaranteed; do not assume a refresh is free. Set `REM_NO_CACHE=1` to bypass
application-level reads and writes for Google snapshots (and other REM caches).

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
Unknown/error behavior, cache-only CLI use without credentials, explicit refresh,
unchanged mappings, missing dates, null audience values, large integer impression
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

Programmatic prefetch uses the same behavior:

```ts
import { prefetchGoogleAds } from "reverse-engineer-marketing";
await prefetchGoogleAds(["example.com", "competitor.example"], { dryRun: true });
// Once the estimate and configured cap are suitable:
await prefetchGoogleAds(["example.com", "competitor.example"]);
```
