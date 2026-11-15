# Direct Google keyword research in this fork

The keyword module calls Google's `KeywordPlanIdeaService.GenerateKeywordIdeas`
directly through Google Ads API v25. It uses the official `google-auth-library`
for authentication. It does not use Semrush, Similarweb, SpyFu, ScrapeCreators or
another paid data intermediary, and does not create or modify campaigns.

This is separate from [Google Ads Transparency collection](google-bigquery.md).
A BigQuery project, access to public ad-library data or a saved `AR…` advertiser
mapping does not grant Keyword Planner access. This module needs a numeric Google
Ads **customer ID** and credentials with access to that account.

## Verified access status

On **2026-11-15**, the configured project `pp-solutions-marketing-reports` could
list accessible Google Ads accounts and read account metadata. A direct v25
`generateKeywordIdeas` probe against both accessible production accounts returned
HTTP 403 with authorization error **`DEVELOPER_TOKEN_NOT_APPROVED`**. One account
was a client account and the other was its manager; both used PLN.

Therefore **production keyword-planning access is not confirmed and the tested
requests are blocked**. Successful account reporting does not prove planning
permission. The error is recorded using Google's returned code; it is not a claim
that the project's named access level was inspected. No access-upgrade application
was submitted and no campaign or billing setting was changed during this task.

Current Google documentation assigns API access to the Cloud project. Explorer
access excludes `KeywordPlanIdeaService`; planning requires Basic or Standard
access. Applying for Basic also requires project brand verification. Check the
[Google Ads API Overview](https://console.cloud.google.com/google/ads-apis/overview?project=pp-solutions-marketing-reports)
and [current access requirements](https://developers.google.com/google-ads/api/docs/api-policy/access-levels).
Google retired developer tokens on 2026-09-09; the legacy wording in the returned
error does not make copying a token into REM a solution.

## Configure authentication

Build this fork with `npm ci` and `npm run build`, then configure the process:

```sh
export REM_GOOGLE_ADS_CUSTOMER_ID=1234567890
export REM_GOOGLE_ADS_PROJECT_ID=your-approved-google-cloud-project
# Optional, when the account is accessed through a manager:
export REM_GOOGLE_ADS_LOGIN_CUSTOMER_ID=9876543210
# Optional, to use an existing Google Ads-authorized credential file:
export REM_GOOGLE_ADS_CREDENTIALS=/absolute/path/outside/repository/credentials.json
```

These IDs are syntax examples. Do not copy them as real account associations.
Hyphens in customer IDs are normalized. If no keyword-specific credential file is
provided, the official library uses Application Default Credentials. Credentials
must have the `https://www.googleapis.com/auth/adwords` authorization and the
necessary Google Ads account access; an ordinary Cloud login is not proof of this.
The project is used for the `x-goog-user-project` header, and the optional manager
ID for `login-customer-id`.

Keep credential files outside the repository. Never commit OAuth refresh tokens,
client secrets or service-account keys. `REM_GOOGLE_ADS_CREDENTIALS` only selects
credentials for this module; it does not replace the BigQuery configuration.

## Check actual planning access

```sh
node dist/cli.js keywords-check
node dist/cli.js keywords-check --customer 1234567890
```

The check makes a small, uncached keyword-ideas request with page size 1 and returns
safe JSON containing `available`, `code`, `checkedAt` and the selected customer ID.
A refusal returns a nonzero CLI exit status. It does not create a plan, activate
ads or change a budget. Only an accepted planning request establishes access;
account listing and reporting alone are insufficient. A successful check does not
assert the name of the project's administrative access level.

## Research keywords

```sh
node dist/cli.js keywords "oprogramowanie CRM" "automatyzacja marketingu"
node dist/cli.js keywords --url https://example.com/product
node dist/cli.js keywords "CRM" --url https://example.com/product --limit 100 --refresh
node dist/cli.js keywords "CRM" --customer 1234567890 --language 1030 --geo 2616
```

Defaults are **Polish** (`languageConstants/1030`), **Poland**
(`geoTargetConstants/2616`) and **Google Search**, with at most 100 returned ideas.
The language and country constants were checked through Google Ads during this
task. Choose the actual language/location for the planned campaign rather than
assuming every campaign targets Poland. The result limit may be set up to 1,000.
A keyword seed may contain 1–20 phrases, each at most 80 characters and 10 words;
a public URL can be used alone or combined with keywords. The programmatic API
accepts up to 10 geographic targets.

Requests follow pagination within a bounded number of pages. `truncated` explicitly
marks a result when the limit/page bound leaves more data available. A short page
does not mean the response is complete while Google supplies a next-page token.
An API refusal or malformed response is an error, not an empty keyword market.

The response retains:

- Canonical keyword text and close variants.
- Average monthly searches and the available monthly search history.
- Advertiser competition and its index when available.
- Low/high top-of-page bid bounds and average CPC when Google provides them.
- Customer-account currency, location/language/network, fetch time and cache status.

INT64 values, including monetary amounts in **micros**, remain decimal strings.
One currency unit is 1,000,000 micros. Missing metrics remain `null`, not zero.
Currency is read from the account; an unavailable currency remains unknown rather
than being assumed to be PLN.

## Include research in a report

Keyword research is opt-in. Ordinary reports retain their existing behavior:

```sh
node dist/cli.js example.com --no-ai --keyword "CRM" --keyword "automatyzacja marketingu" --keyword-limit 100
```

The report's target URL is used alongside the supplied keywords. Research becomes
separate `keyword_research` evidence with source/provenance and limitations. A
blocked lookup becomes Unknown. It does not establish that the target bids on
those phrases, and does not increase the target's observed Google Ads activity.

The programmatic pipeline accepts `RunOptions.keywordResearch`. Standalone research
is available through `researchKeywords`, and access checks through
`checkKeywordAccess`. MCP clients can use `research_keywords` and
`check_keyword_access`.

## Local results and costs

Validated results are saved under `$REM_CACHE_DIR/google-keywords/`, or
`~/.cache/reverse-engineer-marketing/google-keywords/` by default. The cache key
includes schema version and the full normalized request/account/project/locale,
so another customer, market, seed or result limit cannot silently reuse a different
query. Cached results remain valid for 24 hours; provenance retains the original
fetch time. A valid hit does not authenticate or call Google again. `REM_NO_CACHE` disables
keyword-cache reads and writes. `--refresh`
requests new data; an error does not silently substitute an old result.

Writes use private directory/file permissions (0700/0600) and atomic replacement.
Credentials are never stored in keyword results. Corrupt, incompatible, future or
expired snapshots are cache misses. The bounded requests and cache reduce quota
use; they do not grant API permission. No subscription or paid intermediary is
required by this module. Existing report engines and BigQuery collection retain
their separate cost rules; running real ad campaigns still incurs advertising spend.

## Dependency choice

`google-auth-library` 11.3.4 is pinned as a direct dependency. The official Google
library already existed transitively under BigQuery; declaring it directly avoids
relying on another package's private dependency graph. Its Apache-2.0 license and
Node >=22 requirement fit this MIT/Node >=22 application. The keyword adapter uses
the library for credential handling and calls Google's documented read-only REST
methods, without adopting a separate third-party keyword platform.

## Meaning and verification boundary

These are keyword **ideas and market metrics**. A website seed generates ideas from
public site content; it is not an export of a competitor's configured keywords.
Bid ranges and average CPC are not the actual price a named competitor paid.
Neither this module nor its cache reveals a competitor's real budget, CPL,
conversions or ROAS. Those remain Unknown unless independently evidenced.

Tests use controlled responses to verify parsing, pagination, cache isolation and
failure behavior. Run `./.codex/verify` for typecheck, tests, recorded report eval
and build. A live probe demonstrated the access refusal described above; it did
not demonstrate successful live keyword collection. Do not interpret passing
local tests as Google's approval of the project.

Official references:

- [Keyword planning overview](https://developers.google.com/google-ads/api/docs/keyword-planning/overview)
- [Generate keyword ideas](https://developers.google.com/google-ads/api/docs/keyword-planning/generate-keyword-ideas)
- [Access levels and permissible use](https://developers.google.com/google-ads/api/docs/api-policy/access-levels)
- [Google authentication library](https://github.com/googleapis/google-auth-library-nodejs)
