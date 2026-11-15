import { BigQuery, type Query } from "@google-cloud/bigquery";
import { z } from "zod";
import { readConfig } from "../config.js";
import { addContent, type Ctx } from "../context.js";

export const GOOGLE_ADS_TABLE = "bigquery-public-data.google_ads_transparency_center.creative_stats";
export const GOOGLE_ADS_SCOPE = "EEA and Turkey";
const DEFAULT_MAX_BYTES = "1073741824"; // 1 GiB: fail closed, never silently raise this.
const SAMPLE_LIMIT = 20;
const REGION_LIMIT = 40;
const optionalText = z.string().nullish();
const optionalCount = z.string().regex(/^\d+$/).nullish();
const regionSchema = z.object({
  region_code: optionalText, first_shown: optionalText, last_shown: optionalText,
  times_shown_lower_bound: optionalCount, times_shown_upper_bound: optionalCount,
  times_shown_start_date: optionalText, times_shown_end_date: optionalText,
  times_shown_availability_date: optionalText,
}).refine(r => r.times_shown_lower_bound == null || r.times_shown_upper_bound == null ||
  BigInt(r.times_shown_lower_bound) <= BigInt(r.times_shown_upper_bound));
const criterion = z.enum(["CRITERIA_INCLUDED", "CRITERIA_EXCLUDED", "CRITERIA_INCLUDED_AND_EXCLUDED", "CRITERIA_UNUSED"]).nullish();
const marketContextSchema = z.object({
  regions: z.array(regionSchema).max(REGION_LIMIT).optional(),
  region_count: z.string().regex(/^\d+$/).optional(),
  audience_selection: z.object({ demographic_info: criterion, geo_location: criterion,
    contextual_signals: criterion, customer_lists: criterion, topics_of_interest: criterion }).nullish(),
}).refine(a => a.regions === undefined || a.region_count === undefined || BigInt(a.region_count) >= BigInt(a.regions.length));

/** The official table has advertiser IDs, not destination domains. Never infer ownership from a name. */
export function advertiserIdsForDomain(domain: string | undefined, explicit: string[] | undefined, mappings: Record<string, string[]> = {}): string[] {
  const ids = explicit ?? (domain ? mappings[domain.toLowerCase().replace(/^www\./, "")] : undefined) ?? [];
  if (!Array.isArray(ids) || ids.length > 20 || ids.some(id => typeof id !== "string" || !/^AR\d{20}$/.test(id))) {
    throw new Error("Google advertiser IDs must be AR followed by 20 digits (at most 20 per target)");
  }
  return [...new Set(ids)];
}

/** One aggregate row: complete scoped counts plus a bounded sample. Parameters never become SQL. */
export function googleAdsQuery(advertiserIds: string[], maximumBytesBilled: string): Query {
  if (!/^[1-9]\d*$/.test(maximumBytesBilled) || BigInt(maximumBytesBilled) > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("REM_BIGQUERY_MAX_BYTES_BILLED must be a positive safe integer byte limit");
  }
  return {
    location: "US", useLegacySql: false, maximumBytesBilled, jobTimeoutMs: 60_000,
    params: { advertiserIds },
    query: `WITH ads AS (
      SELECT advertiser_id, creative_id,
        CONCAT('https://adstransparency.google.com/advertiser/', advertiser_id, '/creative/', creative_id) AS creative_page_url,
        ad_format_type,
        advertiser_disclosed_name, advertiser_legal_name,
        (SELECT MIN(SAFE_CAST(r.first_shown AS DATE)) FROM UNNEST(region_stats) r) AS first_shown,
        (SELECT MAX(SAFE_CAST(r.last_shown AS DATE)) FROM UNNEST(region_stats) r) AS last_shown,
        -- Project one leaf before counting: ARRAY_LENGTH(region_stats) scans unused nested surface statistics too.
        CAST(ARRAY_LENGTH(ARRAY(SELECT r.region_code FROM UNNEST(region_stats) r)) AS STRING) AS region_count,
        ARRAY(SELECT AS STRUCT r.region_code, r.first_shown, r.last_shown,
          CAST(r.times_shown_lower_bound AS STRING) AS times_shown_lower_bound,
          CAST(r.times_shown_upper_bound AS STRING) AS times_shown_upper_bound,
          r.times_shown_start_date, r.times_shown_end_date, r.times_shown_availability_date
          FROM UNNEST(region_stats) r ORDER BY r.region_code LIMIT ${REGION_LIMIT}) AS regions,
        IF(audience_selection_approach_info IS NULL, NULL, STRUCT(
          audience_selection_approach_info.demographic_info AS demographic_info,
          audience_selection_approach_info.geo_location AS geo_location,
          audience_selection_approach_info.contextual_signals AS contextual_signals,
          audience_selection_approach_info.customer_lists AS customer_lists,
          audience_selection_approach_info.topics_of_interest AS topics_of_interest)) AS audience_selection
      FROM \`${GOOGLE_ADS_TABLE}\`
      WHERE advertiser_id IN UNNEST(@advertiserIds)
    )
    SELECT CAST(COUNT(*) AS STRING) AS total,
      CAST(COUNTIF(last_shown IS NOT NULL) AS STRING) AS dated,
      CAST(COUNTIF(last_shown >= DATE_SUB(CURRENT_DATE(), INTERVAL 30 DAY)) AS STRING) AS shownLast30d,
      ARRAY_AGG(STRUCT(advertiser_id, creative_id, creative_page_url, ad_format_type,
        advertiser_disclosed_name, advertiser_legal_name,
        CAST(first_shown AS STRING) AS first_shown, CAST(last_shown AS STRING) AS last_shown, regions, region_count, audience_selection)
        ORDER BY last_shown DESC, advertiser_id, creative_id LIMIT ${SAMPLE_LIMIT}) AS sample
    FROM ads`,
  };
}

/** Uncharged server-side estimate: does not execute the SELECT or raise the execution cap. */
export async function estimateGoogleAdsScan(advertiserIds: string[]): Promise<{ estimatedBytes: string; maximumBytesBilled: string }> {
  const ids = advertiserIdsForDomain(undefined, advertiserIds);
  if (!ids.length) throw new Error("Google advertiser IDs are required for a dry run");
  const projectId = process.env.REM_BIGQUERY_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT;
  if (!projectId) throw new Error("Set REM_BIGQUERY_PROJECT_ID (or GOOGLE_CLOUD_PROJECT) and configure Google Application Default Credentials for BigQuery");
  const maximumBytesBilled = process.env.REM_BIGQUERY_MAX_BYTES_BILLED ?? DEFAULT_MAX_BYTES;
  const query = googleAdsQuery(ids, maximumBytesBilled);
  const [job] = await new BigQuery({ projectId }).createQueryJob({ ...query, maximumBytesBilled: undefined, dryRun: true });
  const estimatedBytes = job.metadata.statistics?.totalBytesProcessed;
  if (typeof estimatedBytes !== "string" || !/^\d+$/.test(estimatedBytes)) throw new Error("Unexpected Google BigQuery dry-run statistics");
  return { estimatedBytes, maximumBytesBilled };
}

interface Ad {
  advertiser_id: string;
  creative_id: string;
  creative_page_url: string;
  ad_format_type?: string;
  advertiser_disclosed_name?: string;
  advertiser_legal_name?: string;
  first_shown?: string;
  last_shown?: string;
}
function count(value: unknown): value is string {
  return typeof value === "string" && /^\d+$/.test(value);
}
function ad(value: unknown, advertiserIds: string[]): value is Ad {
  if (!value || typeof value !== "object") return false;
  const a = value as Ad;
  if (!advertiserIds.includes(a.advertiser_id) || typeof a.creative_id !== "string" || !a.creative_id || typeof a.creative_page_url !== "string") return false;
  try {
    const u = new URL(a.creative_page_url);
    return u.protocol === "https:" && u.hostname === "adstransparency.google.com";
  } catch { return false; }
}

export async function collectGoogleAds(ctx: Ctx, manual: string): Promise<void> {
  try {
    const mappings = readConfig().googleAdvertisers;
    const mappedDomain = [ctx.target.domain, ...(ctx.target.aliases ?? [])].find(d => d && mappings?.[d.toLowerCase().replace(/^www\./, "")]);
    const ids = advertiserIdsForDomain(mappedDomain ?? ctx.target.domain, ctx.googleAdvertiserIds, mappings);
    if (!ids.length) throw new Error("Google advertiser identity not configured. Supply --google-advertiser AR… or save a domain → advertiser ID mapping with rem google-link. The public BigQuery table has no destination domain field.");
    const projectId = process.env.REM_BIGQUERY_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT;
    if (!projectId) throw new Error("Set REM_BIGQUERY_PROJECT_ID (or GOOGLE_CLOUD_PROJECT) and configure Google Application Default Credentials for BigQuery");
    const maximumBytesBilled = process.env.REM_BIGQUERY_MAX_BYTES_BILLED ?? DEFAULT_MAX_BYTES;
    const query = googleAdsQuery(ids, maximumBytesBilled);
    // Official SDK handles ADC, job completion and pagination; never interpret an incomplete page as zero ads.
    if (ctx.googleAdsDryRun) {
      const estimate = await estimateGoogleAdsScan(ids);
      ctx.store.unknown({ channel: "paid_google", reason: `BigQuery dry run: estimated ${estimate.estimatedBytes} scanned bytes; configured execution cap ${estimate.maximumBytesBilled} bytes. No ad query executed.`, manualCheck: manual });
      return;
    }
    const client = new BigQuery({ projectId });
    const [rows] = await client.query(query);
    const result = rows[0];
    if (rows.length !== 1 || !result || !count(result.total) || !count(result.shownLast30d) || !count(result.dated) || BigInt(result.dated) > BigInt(result.total) || BigInt(result.shownLast30d) > BigInt(result.dated)) throw new Error("Unexpected Google BigQuery aggregate response");
    const sample: unknown = result.sample ?? (result.total === "0" ? [] : undefined);
    if (!Array.isArray(sample) || sample.length > SAMPLE_LIMIT || sample.some(a => !ad(a, ids)) || (result.total !== "0" && sample.length === 0) || BigInt(sample.length) > BigInt(result.total)) throw new Error("Unexpected Google BigQuery ad sample");
    // Keep only report fields even if a future API response contains additional payloads.
    const ads = (sample as Ad[]).map(a => {
      const context = marketContextSchema.safeParse(a);
      if (!context.success) throw new Error("Unexpected Google BigQuery market-context response");
      const { advertiser_id, creative_id, creative_page_url, ad_format_type, advertiser_disclosed_name, advertiser_legal_name, first_shown, last_shown } = a;
      return { advertiser_id, creative_id, creative_page_url, ad_format_type, advertiser_disclosed_name, advertiser_legal_name, first_shown, last_shown, ...context.data };
    });
    const e = ctx.store.add({
      source: "google_ads", kind: "observation",
      title: `Google ads (official BigQuery, ${GOOGLE_ADS_SCOPE}): ${result.total} creatives for selected advertiser IDs; ${result.shownLast30d} shown in last 30d`,
      url: "https://console.cloud.google.com/marketplace/details/bigquery-public-data/google-ads-transparency-center",
      data: {
        provider: "google_bigquery", table: GOOGLE_ADS_TABLE, scope: GOOGLE_ADS_SCOPE,
        advertiserIds: ids, identityBasis: "Explicit target-specific advertiser IDs or saved domain mapping; not a verified destination-domain match",
        creativeLinkBasis: "Canonical public ad-page links derived from advertiser_id and creative_id; URL column is not scanned",
        totalInScope: result.total, shownLast30d: result.shownLast30d, withLastShownDate: result.dated,
        sampled: ads.length, sample: ads,
        contextScope: `Regional and audience context covers only the creative sample (at most ${SAMPLE_LIMIT}), with at most ${REGION_LIMIT} regions per creative; compare region_count with regions.length for truncation.`,
        maximumBytesBilled,
        limitations: ["Periodically updated; may lag the public website. Last shown does not establish that an ad is active now.", "Only selected advertiser IDs and EEA/Turkey; empty results do not establish absence of Google ads globally.", "No destination domain, copy, image/video, spend, clicks, conversions or ROAS. Advertisers may advertise several domains.", "Regional impression bounds describe their stated reporting periods, not unique reach or sales performance. Do not sum overlapping EEA aggregates and country rows. Null values mean unknown, not zero.", "Audience-selection categories indicate criteria usage only, not exact segments, keywords, ages, locations or effectiveness. First shown is clamped to 2023-03-01 for older ads."],
      },
    });
    addContent(ctx, ads.map(a => ({ id: `google:${a.advertiser_id}:${a.creative_id}`, platform: "google_ads" as const, kind: "ad" as const, url: a.creative_page_url, title: `${a.ad_format_type ?? "Ad"} by ${a.advertiser_disclosed_name ?? a.advertiser_legal_name ?? a.advertiser_id}`, author: a.advertiser_disclosed_name ?? a.advertiser_legal_name, date: a.first_shown, tags: [GOOGLE_ADS_SCOPE, a.ad_format_type].filter((s): s is string => Boolean(s)) })), e.id);
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
