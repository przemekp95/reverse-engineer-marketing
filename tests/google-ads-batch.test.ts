import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectGoogleAds } from "../src/sources/google-ads.js";
import { EvidenceStore } from "../src/evidence.js";
import type { Ctx } from "../src/context.js";
import { prefetchGoogleAds } from "../src/sources/google-ads-fetch.js";
const mocks = vi.hoisted(() => ({ query: vi.fn(), estimate: vi.fn(), config: {} as any }));
vi.mock("@google-cloud/bigquery", () => ({ BigQuery: class { query = mocks.query; createQueryJob = mocks.estimate; } }));
vi.mock("../src/config.js", () => ({ readConfig: () => mocks.config }));
const A = "AR00000000000000000001", B = "AR00000000000000000002";
let dir: string;
const creative = (id: string, n: number) => ({ advertiser_id: id, creative_id: `CR${n}`, creative_page_url: `https://adstransparency.google.com/advertiser/${id}/creative/CR${n}`, ad_format_type: "TEXT", first_shown: "2024-01-01", last_shown: "2026-11-14", regions: [{ region_code: "PL", times_shown_lower_bound: "9007199254740993", times_shown_upper_bound: "9007199254740999", times_shown_start_date: "2024-01-01", times_shown_end_date: "2026-11-14" }], region_count: "1", audience_selection: { geo_location: "CRITERIA_INCLUDED" } });
beforeEach(async () => {
  vi.unstubAllEnvs(); dir = await mkdtemp(join(tmpdir(), "rem-google-batch-"));
  vi.stubEnv("REM_CACHE_DIR", dir); vi.stubEnv("REM_BIGQUERY_PROJECT_ID", "test-project");
  mocks.query.mockReset(); mocks.estimate.mockReset();
  mocks.config = { googleAdvertisers: { "a.example": [A], "b.example": [B] } };
});
afterEach(async () => { await rm(dir, {recursive:true,force:true}); vi.useRealTimers(); });
it("fetches both competitors once, preserves separate full counts and 20 rich creatives each, then reuses disk offline", async () => {
  mocks.query.mockResolvedValue([[{ target_key: "0", total:"100", dated:"90", shownLast30d:"70", sample:Array.from({length:20},(_,n)=>creative(A,n)) }, { target_key:"1", total:"80", dated:"70", shownLast30d:"60", sample:Array.from({length:20},(_,n)=>creative(B,n)) }]]);
  const result = await prefetchGoogleAds(["a.example", "b.example"]);
  expect(result).toMatchObject({requested:2,cached:0,fetched:2,dryRun:false});
  expect(mocks.query).toHaveBeenCalledTimes(1);
  expect(mocks.query).toHaveBeenCalledWith(expect.objectContaining({maximumBytesBilled:"1073741824",params:expect.objectContaining({advertiserIds:[A,B]})}));
  const files = await readdir(join(dir,"google-ads")); expect(files).toHaveLength(2);
  for (const file of files) {
    const p=join(dir,"google-ads",file), snapshot=JSON.parse(await readFile(p,"utf8"));
    expect(snapshot.result.sample).toHaveLength(20);
    expect(snapshot.result.sample.every((ad:any)=>snapshot.advertiserIds.includes(ad.advertiser_id))).toBe(true);
    expect(snapshot.result.sample[0].regions[0].times_shown_lower_bound).toBe("9007199254740993");
    expect(snapshot.result.sample[0].audience_selection.geo_location).toBe("CRITERIA_INCLUDED");
    expect((await stat(p)).mode & 0o777).toBe(0o600);
  }
  vi.stubEnv("REM_BIGQUERY_PROJECT_ID", ""); vi.stubEnv("GOOGLE_CLOUD_PROJECT", "");
  expect(await prefetchGoogleAds(["b.example","a.example"])).toMatchObject({cached:2,fetched:0});
  const ctx: Ctx = {target:{kind:"website",input:"b.example",domain:"b.example",url:"https://b.example"},store:new EvidenceStore(),sc:null,content:[],found:{socials:{},people:[],appStoreIds:[],playIds:[],logos:[],founderHints:[]},log:()=>{}};
  await collectGoogleAds(ctx,"https://adstransparency.google.com/");
  expect(ctx.store.bySource("google_ads")[0]).toMatchObject({data:{totalInScope:"80",withLastShownDate:"70",shownLast30d:"60",sample:Array.from({length:20},(_,n)=>creative(B,n)),snapshot:{cacheHit:true}}});
  expect(ctx.content).toHaveLength(20);
  expect(mocks.query).toHaveBeenCalledTimes(1);
});
it("records a complete-query missing group as checked zero, not a missing response error",async()=>{
  mocks.query.mockResolvedValue([[]]);
  await prefetchGoogleAds(["a.example","b.example"]);
  const files=await readdir(join(dir,"google-ads"));
  expect(files).toHaveLength(2);
  expect(JSON.parse(await readFile(join(dir,"google-ads",files[0]!),"utf8")).result).toEqual({total:"0",dated:"0",shownLast30d:"0",sample:[]});
});
it("deduplicates exact identity sets but preserves multi-ID target samples instead of mixing competitors",async()=>{
  mocks.config.googleAdvertisers["alias.example"]=[A];
  mocks.config.googleAdvertisers["b.example"]=[A,B];
  mocks.query.mockResolvedValue([[{target_key:"0",total:"1",dated:"1",shownLast30d:"1",sample:[creative(A,1)]},{target_key:"1",total:"2",dated:"2",shownLast30d:"2",sample:[creative(B,2),creative(A,1)]}]]);
  expect(await prefetchGoogleAds(["a.example","alias.example","b.example"])).toMatchObject({requested:3,fetched:2});
  const q=mocks.query.mock.calls[0]![0];
  expect(q.params.targetKeys).toEqual(["0","1","1"]);
  expect(q.params.targetAdvertiserIds).toEqual([A,A,B]);
  expect(await readdir(join(dir,"google-ads"))).toHaveLength(2);
});
it("dry-runs the batch without executing or writing snapshots", async()=>{
  mocks.estimate.mockResolvedValue([{metadata:{statistics:{totalBytesProcessed:"68144943841"}}}]);
  expect(await prefetchGoogleAds(["a.example","b.example"],{dryRun:true})).toMatchObject({dryRun:true,estimatedBytes:"68144943841",fetched:0});
  expect(mocks.query).not.toHaveBeenCalled();
  expect(mocks.estimate).toHaveBeenCalledWith(expect.objectContaining({dryRun:true,maximumBytesBilled:undefined}));
  expect(await readdir(dir)).toEqual([]);
});
it("rejects cross-target or duplicate groups before persisting any results",async()=>{
  for(const rows of [[{target_key:"0",total:"1",dated:"1",shownLast30d:"1",sample:[creative(B,1)]}],[{target_key:"0",total:"0",dated:"0",shownLast30d:"0",sample:[]},{target_key:"0",total:"0",dated:"0",shownLast30d:"0",sample:[]}]]){
    mocks.query.mockResolvedValue([rows]);
    await expect(prefetchGoogleAds(["a.example","b.example"])).rejects.toThrow();
    expect(await readdir(dir)).toEqual([]);
  }
});
it("requires identity mappings for all inputs before making a query",async()=>{
  await expect(prefetchGoogleAds(["a.example","unknown.example"])).rejects.toThrow(/identity|mapping/i);
  expect(mocks.query).not.toHaveBeenCalled();
});

it("refresh bypasses the cache; a failed refresh preserves the earlier saved result",async()=>{
  mocks.query.mockResolvedValue([[{target_key:"0",total:"1",dated:"1",shownLast30d:"1",sample:[creative(A,1)]}]]);
  await prefetchGoogleAds(["a.example"]);
  const file=(await readdir(join(dir,"google-ads")))[0]!;
  mocks.query.mockResolvedValue([[{target_key:"0",total:"2",dated:"2",shownLast30d:"2",sample:[creative(A,1),creative(A,2)]}]]);
  expect(await prefetchGoogleAds(["a.example"],{refresh:true})).toMatchObject({cached:0,fetched:1});
  const before=await readFile(join(dir,"google-ads",file),"utf8");
  expect(JSON.parse(before).result.total).toBe("2");
  mocks.query.mockRejectedValue(new Error("permission failure"));
  await expect(prefetchGoogleAds(["a.example"],{refresh:true})).rejects.toThrow();
  expect(await readFile(join(dir,"google-ads",file),"utf8")).toBe(before);
  expect(mocks.query).toHaveBeenCalledTimes(3);
});
it("treats stale, future, malformed and wrong-identity snapshots as misses",async()=>{
  mocks.query.mockResolvedValue([[]]);
  await prefetchGoogleAds(["a.example"]);
  const file=join(dir,"google-ads",(await readdir(join(dir,"google-ads")))[0]!);
  const original=JSON.parse(await readFile(file,"utf8"));
  for(const patch of [
    {fetchedAt:"2020-01-01T00:00:00.000Z",asOfDate:"2020-01-01"},
    {fetchedAt:"2099-01-01T00:00:00.000Z",asOfDate:"2099-01-01"},
    {advertiserIds:[B]}, {version:0},
    {result:{total:"NaN",dated:"0",shownLast30d:"0",sample:[]}},
  ]) {
    await writeFile(file,JSON.stringify({...original,...patch}));
    expect(await prefetchGoogleAds(["a.example"])).toMatchObject({fetched:1,cached:0});
  }
  expect(mocks.query).toHaveBeenCalledTimes(6);
});
it("queries only cache misses and never combines another competitor's evidence into that snapshot",async()=>{
  mocks.query.mockResolvedValue([[]]);
  await prefetchGoogleAds(["a.example"]);
  mocks.query.mockClear();
  const result=await prefetchGoogleAds(["a.example","b.example"]);
  expect(result).toMatchObject({cached:1,fetched:1});
  expect(mocks.query.mock.calls[0]![0].params.advertiserIds).toEqual([B]);
});
