import { BigQuery, type Query } from "@google-cloud/bigquery";
import { readConfig } from "../config.js";
import { parseTarget } from "../target.js";
import { advertiserIdsForDomain, googleAdsBatchQuery, googleAdsQuery, DEFAULT_MAX_BYTES, GOOGLE_ADS_TABLE, normalizeGoogleAdsResult } from "./google-ads-data.js";
import { readGoogleAdsSnapshot, writeGoogleAdsSnapshot, type GoogleAdsSnapshot } from "./google-ads-cache.js";

function execution() {
  const projectId = process.env.REM_BIGQUERY_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT;
  if (!projectId) throw new Error("Set REM_BIGQUERY_PROJECT_ID (or GOOGLE_CLOUD_PROJECT) and configure Google Application Default Credentials for BigQuery");
  return new BigQuery({ projectId });
}
const byteCap = () => process.env.REM_BIGQUERY_MAX_BYTES_BILLED ?? DEFAULT_MAX_BYTES;
async function estimate(query: Query) {
  const [job] = await execution().createQueryJob({ ...query, maximumBytesBilled: undefined, dryRun: true });
  const estimatedBytes = job.metadata.statistics?.totalBytesProcessed;
  if (typeof estimatedBytes !== "string" || !/^\d+$/.test(estimatedBytes)) throw new Error("Unexpected Google BigQuery dry-run statistics");
  return estimatedBytes;
}
export async function estimateGoogleAdsScan(advertiserIds: string[]): Promise<{estimatedBytes:string; maximumBytesBilled:string}> {
  const ids = advertiserIdsForDomain(undefined, advertiserIds);
  if (!ids.length) throw new Error("Google advertiser IDs are required for a dry run");
  const maximumBytesBilled = byteCap();
  return { estimatedBytes: await estimate(googleAdsQuery(ids, maximumBytesBilled)), maximumBytesBilled };
}
function makeSnapshot(ids: string[], result: ReturnType<typeof normalizeGoogleAdsResult>, fetchedAt: string, maximumBytesBilled: string): GoogleAdsSnapshot {
  return {version:1,table:GOOGLE_ADS_TABLE,advertiserIds:[...ids].sort(),fetchedAt,asOfDate:fetchedAt.slice(0,10),maximumBytesBilled,result};
}
/** Standard reports share the same disk snapshots as the explicit competitor batch. */
export async function fetchGoogleAdsSnapshot(ids: string[]) {
  const advertiserIds = advertiserIdsForDomain(undefined, ids).sort();
  if (!advertiserIds.length) throw new Error("Google advertiser IDs required");
  const cached = await readGoogleAdsSnapshot(advertiserIds);
  if (cached) return { snapshot: cached, cacheHit: true };
  const fetchedAt = new Date().toISOString(), maximumBytesBilled = byteCap();
  const query = googleAdsQuery(advertiserIds, maximumBytesBilled, fetchedAt.slice(0,10));
  const [rows] = await execution().query(query);
  if (rows.length !== 1) throw new Error("Unexpected Google BigQuery aggregate response");
  const snapshot = makeSnapshot(advertiserIds, normalizeGoogleAdsResult(rows[0], advertiserIds), fetchedAt, maximumBytesBilled);
  await writeGoogleAdsSnapshot(snapshot);
  return { snapshot, cacheHit: false };
}
export interface GoogleAdsPrefetchResult {
  dryRun: boolean;
  requested: number;
  cached: number;
  fetched: number;
  estimatedBytes?: string;
  maximumBytesBilled: string;
  snapshots: Array<{domain:string;advertiserIds:string[];fetchedAt:string;asOfDate:string;cacheHit:boolean}>;
}
/** Up to 20 competitors, one scoped aggregate/sample per exact advertiser-ID set. */
export async function prefetchGoogleAds(domains: string[], options: {refresh?:boolean;dryRun?:boolean} = {}): Promise<GoogleAdsPrefetchResult> {
  if (!domains.length || domains.length > 20) throw new Error("Google batch requires 1 to 20 domains");
  const mappings = readConfig().googleAdvertisers ?? {};
  const targets = domains.map(input => {
    const target = parseTarget(input);
    const ids = advertiserIdsForDomain(target.domain, undefined, mappings).sort();
    if (target.kind !== "website" || !target.domain || !ids.length) throw new Error("Google advertiser identity mapping required for every domain; save verified IDs with rem google-link");
    return { domain: target.domain, ids, key: JSON.stringify(ids) };
  });
  const groups = [...new Map(targets.map(t => [t.key,t.ids])).entries()];
  const snapshots = new Map<string, {snapshot:GoogleAdsSnapshot;cacheHit:boolean}>();
  const missing: typeof groups = [];
  for (const [key,ids] of groups) {
    const cached = options.refresh ? undefined : await readGoogleAdsSnapshot(ids);
    if (cached) snapshots.set(key, {snapshot:cached,cacheHit:true});
    else missing.push([key,ids]);
  }
  const fetchedAt = new Date().toISOString(), maximumBytesBilled = byteCap();
  let estimatedBytes: string | undefined;
  if (missing.length) {
    const query = googleAdsBatchQuery(missing.map(([,ids])=>ids), maximumBytesBilled, fetchedAt.slice(0,10));
    if (options.dryRun) estimatedBytes = await estimate(query);
    else {
      // Official SDK waits for completion and paginates all aggregate groups.
      const [rows] = await execution().query(query);
      const results = new Map<string, unknown>();
      for (const row of rows) {
        if (typeof row?.target_key !== "string" || !/^(0|[1-9]\d*)$/.test(row.target_key) || Number(row.target_key) >= missing.length || results.has(row.target_key)) throw new Error("Unexpected Google BigQuery batch group");
        results.set(row.target_key, row);
      }
      // Validate the entire response before writing any competitor's snapshot.
      const validated = missing.map(([key,ids],i) => {
        const raw = results.get(String(i)) ?? {total:"0",dated:"0",shownLast30d:"0",sample:[]};
        return { key, snapshot: makeSnapshot(ids, normalizeGoogleAdsResult(raw,ids),fetchedAt,maximumBytesBilled) };
      });
      for (const {key,snapshot} of validated) {
        await writeGoogleAdsSnapshot(snapshot);
        snapshots.set(key,{snapshot,cacheHit:false});
      }
    }
  }
  return { dryRun: Boolean(options.dryRun), requested: targets.length,
    cached: [...snapshots.values()].filter(s=>s.cacheHit).length,
    fetched: [...snapshots.values()].filter(s=>!s.cacheHit).length,
    estimatedBytes, maximumBytesBilled,
    snapshots: targets.flatMap(t=>{
      const found=snapshots.get(t.key);
      return found ? [{domain:t.domain,advertiserIds:t.ids,fetchedAt:found.snapshot.fetchedAt,asOfDate:found.snapshot.asOfDate,cacheHit:found.cacheHit}] : [];
    }) };
}
