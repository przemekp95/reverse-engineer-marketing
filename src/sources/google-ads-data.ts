import type { Query } from "@google-cloud/bigquery";
import { z } from "zod";

export const GOOGLE_ADS_TABLE = "bigquery-public-data.google_ads_transparency_center.creative_stats";
export const GOOGLE_ADS_SCOPE = "EEA and Turkey";
export const DEFAULT_MAX_BYTES = "1073741824"; // 1 GiB: fail closed, never silently raise this.
export const SAMPLE_LIMIT = 20;
export const REGION_LIMIT = 40;
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
export function googleAdsQuery(advertiserIds: string[], maximumBytesBilled: string, asOfDate = new Date().toISOString().slice(0, 10)): Query {
  if (!/^[1-9]\d*$/.test(maximumBytesBilled) || BigInt(maximumBytesBilled) > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("REM_BIGQUERY_MAX_BYTES_BILLED must be a positive safe integer byte limit");
  }
  return {
    location: "US", useLegacySql: false, maximumBytesBilled, jobTimeoutMs: 60_000,
    params: { advertiserIds, asOfDate },
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
      CAST(COUNTIF(last_shown >= DATE_SUB(DATE(@asOfDate), INTERVAL 30 DAY)) AS STRING) AS shownLast30d,
      ARRAY_AGG(STRUCT(advertiser_id, creative_id, creative_page_url, ad_format_type,
        advertiser_disclosed_name, advertiser_legal_name,
        CAST(first_shown AS STRING) AS first_shown, CAST(last_shown AS STRING) AS last_shown, regions, region_count, audience_selection)
        ORDER BY last_shown DESC, advertiser_id, creative_id LIMIT ${SAMPLE_LIMIT}) AS sample
    FROM ads`,
  };
}


const adSchema = z.object({
  advertiser_id: z.string(), creative_id: z.string().min(1),
  creative_page_url: z.string().url().refine(value => { const u = new URL(value); return u.protocol === "https:" && u.hostname === "adstransparency.google.com"; }),
  ad_format_type: optionalText, advertiser_disclosed_name: optionalText, advertiser_legal_name: optionalText,
  first_shown: optionalText, last_shown: optionalText,
});
const decimal = z.string().regex(/^\d+$/);
const aggregateSchema = z.object({ total: decimal, dated: decimal, shownLast30d: decimal, sample: z.array(z.unknown()).max(SAMPLE_LIMIT).nullable() });
export function normalizeGoogleAdsResult(raw: unknown, advertiserIds: string[]) {
  const parsed = aggregateSchema.safeParse(raw);
  if (!parsed.success) throw new Error("Unexpected Google BigQuery aggregate response");
  const {total, dated, shownLast30d} = parsed.data;
  const sample = parsed.data.sample ?? (total === "0" ? [] : undefined);
  if (!sample || BigInt(dated) > BigInt(total) || BigInt(shownLast30d) > BigInt(dated) || BigInt(sample.length) > BigInt(total) || (total !== "0" && !sample.length)) throw new Error("Unexpected Google BigQuery ad sample");
  const seen = new Set<string>();
  const ads = sample.map(rawAd => {
    const a = adSchema.safeParse(rawAd), context = marketContextSchema.safeParse(rawAd);
    if (!a.success || !context.success || !advertiserIds.includes(a.data.advertiser_id)) throw new Error("Unexpected Google BigQuery market-context response");
    const key = `${a.data.advertiser_id}:${a.data.creative_id}`;
    if (seen.has(key)) throw new Error("Unexpected Google BigQuery duplicate creative");
    seen.add(key);
    const { advertiser_id, creative_id, creative_page_url, ad_format_type, advertiser_disclosed_name, advertiser_legal_name, first_shown, last_shown } = a.data;
    return { advertiser_id, creative_id, creative_page_url, ad_format_type, advertiser_disclosed_name, advertiser_legal_name, first_shown, last_shown, ...context.data };
  });
  return { total, dated, shownLast30d, sample: ads };
}
export type GoogleAdsResult = ReturnType<typeof normalizeGoogleAdsResult>;

/** Group by target identity set, not by advertiser: one company may use multiple IDs. */
export function googleAdsBatchQuery(groups: string[][], maximumBytesBilled: string, asOfDate: string): Query {
  if (!groups.length || groups.length > 20) throw new Error("Google batch requires 1 to 20 identity groups");
  const normalized = groups.map(ids => advertiserIdsForDomain(undefined, ids).sort());
  if (normalized.some(ids => !ids.length)) throw new Error("Google advertiser IDs required for every batch target");
  const advertiserIds = [...new Set(normalized.flat())].sort();
  const targetKeys = normalized.flatMap((ids, i) => ids.map(() => String(i)));
  const targetAdvertiserIds = normalized.flat();
  const query = googleAdsQuery(advertiserIds, maximumBytesBilled, asOfDate);
  return { ...query, params: { ...query.params, targetKeys, targetAdvertiserIds },
    query: query.query!.replace("WITH ads AS (", `WITH targets AS (
      SELECT target_key, targetAdvertiserIds[OFFSET(i)] AS advertiser_id
      FROM UNNEST(@targetKeys) AS target_key WITH OFFSET i
      CROSS JOIN (SELECT @targetAdvertiserIds AS targetAdvertiserIds)
    ), ads AS (`)
      .replace("SELECT CAST(COUNT(*) AS STRING) AS total,", "SELECT target_key, CAST(COUNT(*) AS STRING) AS total,")
      .replace("    FROM ads", "    FROM ads JOIN targets USING (advertiser_id) GROUP BY target_key") };
}
