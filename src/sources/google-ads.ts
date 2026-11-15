import { readConfig } from "../config.js";
import { addContent, type Ctx } from "../context.js";
import { advertiserIdsForDomain, GOOGLE_ADS_TABLE, GOOGLE_ADS_SCOPE, SAMPLE_LIMIT, REGION_LIMIT, DEFAULT_MAX_BYTES } from "./google-ads-data.js";
import { estimateGoogleAdsScan, fetchGoogleAdsSnapshot } from "./google-ads-fetch.js";
export { advertiserIdsForDomain, googleAdsQuery, GOOGLE_ADS_TABLE, GOOGLE_ADS_SCOPE } from "./google-ads-data.js";
export { estimateGoogleAdsScan } from "./google-ads-fetch.js";

export async function collectGoogleAds(ctx: Ctx, manual: string): Promise<void> {
  try {
    const mappings = readConfig().googleAdvertisers;
    const mappedDomain = [ctx.target.domain, ...(ctx.target.aliases ?? [])].find(d => d && mappings?.[d.toLowerCase().replace(/^www\./, "")]);
    const ids = advertiserIdsForDomain(mappedDomain ?? ctx.target.domain, ctx.googleAdvertiserIds, mappings);
    if (!ids.length) throw new Error("Google advertiser identity not configured. Supply --google-advertiser AR… or save a domain → advertiser ID mapping with rem google-link. The public BigQuery table has no destination domain field.");
    // Dry runs always reach Google's estimator and never populate the local cache.
    if (ctx.googleAdsDryRun) {
      const estimate = await estimateGoogleAdsScan(ids);
      ctx.store.unknown({ channel: "paid_google", reason: `BigQuery dry run: estimated ${estimate.estimatedBytes} scanned bytes; configured execution cap ${estimate.maximumBytesBilled} bytes. No ad query executed.`, manualCheck: manual });
      return;
    }
    const { snapshot, cacheHit } = await fetchGoogleAdsSnapshot(ids);
    const { result, maximumBytesBilled } = snapshot;
    const ads = result.sample;
    const e = ctx.store.add({
      source: "google_ads", kind: "observation",
      title: `Google ads (official BigQuery, ${GOOGLE_ADS_SCOPE}): ${result.total} creatives for selected advertiser IDs; ${result.shownLast30d} shown in last 30d as of ${snapshot.asOfDate}`,
      url: "https://console.cloud.google.com/marketplace/details/bigquery-public-data/google-ads-transparency-center",
      data: {
        provider: "google_bigquery", table: GOOGLE_ADS_TABLE, scope: GOOGLE_ADS_SCOPE,
        advertiserIds: ids, identityBasis: "Explicit target-specific advertiser IDs or saved domain mapping; not a verified destination-domain match",
        creativeLinkBasis: "Canonical public ad-page links derived from advertiser_id and creative_id; URL column is not scanned",
        totalInScope: result.total, shownLast30d: result.shownLast30d, withLastShownDate: result.dated,
        sampled: ads.length, sample: ads,
        contextScope: `Regional and audience context covers only the creative sample (at most ${SAMPLE_LIMIT}), with at most ${REGION_LIMIT} regions per creative; compare region_count with regions.length for truncation.`,
        maximumBytesBilled,
        snapshot: { fetchedAt: snapshot.fetchedAt, asOfDate: snapshot.asOfDate, cacheHit, maximumAgeHours: 24 },
        limitations: ["Periodically updated; may lag the public website. Last shown does not establish that an ad is active now.", "Only selected advertiser IDs and EEA/Turkey; empty results do not establish absence of Google ads globally.", "No destination domain, copy, image/video, spend, clicks, conversions or ROAS. Advertisers may advertise several domains.", "Regional impression bounds describe their stated reporting periods, not unique reach or sales performance. Do not sum overlapping EEA aggregates and country rows. Null values mean unknown, not zero.", "Audience-selection categories indicate criteria usage only, not exact segments, keywords, ages, locations or effectiveness. First shown is clamped to 2023-03-01 for older ads."],
      },
    });
    addContent(ctx, ads.map(a => ({ id: `google:${a.advertiser_id}:${a.creative_id}`, platform: "google_ads" as const, kind: "ad" as const, url: a.creative_page_url, title: `${a.ad_format_type ?? "Ad"} by ${a.advertiser_disclosed_name ?? a.advertiser_legal_name ?? a.advertiser_id}`, author: a.advertiser_disclosed_name ?? a.advertiser_legal_name ?? undefined, date: a.first_shown ?? undefined, tags: [GOOGLE_ADS_SCOPE, a.ad_format_type].filter((s): s is string => Boolean(s)) })), e.id);
    ctx.store.unknown({ channel: "paid_google", reason: "Google ads outside EEA/Turkey, destination-domain attribution and current activation are not established by this dataset", manualCheck: manual });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Do not expose raw SDK errors: they can contain credential paths or request details.
    let reason = "Official BigQuery lookup failed. Check ADC credentials, BigQuery API, project IAM and the configured byte cap; no ScrapeCreators fallback was used.";
    if (/^(Google advertiser|Google advertiser identity|Set REM_BIGQUERY|REM_BIGQUERY_MAX|Unexpected Google)/.test(message)) reason = message;
    else if (/maximum.*bytes|bytes.*billed|billingTierLimitExceeded/i.test(message)) reason = `BigQuery scan exceeds REM_BIGQUERY_MAX_BYTES_BILLED (${process.env.REM_BIGQUERY_MAX_BYTES_BILLED ?? DEFAULT_MAX_BYTES} bytes). Estimate with a dry run before explicitly raising the cap; LIMIT does not reduce scanned bytes.`;
    ctx.store.unknown({ channel: "paid_google", reason, manualCheck: manual });
  }
}
