import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, readdir, readFile, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { researchKeywords, checkKeywordAccess } from "../src/keywords/index.js";
const mocks = vi.hoisted(() => ({ request: vi.fn(), auth: vi.fn() }));
vi.mock("google-auth-library", () => ({ GoogleAuth: class { constructor(o:any) { mocks.auth(o); } async getClient() { return { request: mocks.request }; } } }));
let dir:string;
const seed = { customerId:"123-456-7890", projectId:"keyword-project", keywords:["marketing"],languageId:"1030",geoTargetIds:["2616"],limit:2 };
const idea = (text:string) => ({text,closeVariants:[`${text}s`],keywordIdeaMetrics:{avgMonthlySearches:"9007199254740993",competition:"HIGH",competitionIndex:"91",lowTopOfPageBidMicros:"1000000",highTopOfPageBidMicros:"9007199254740999",averageCpcMicros:"2345678",monthlySearchVolumes:[{year:"2026",month:"OCTOBER",monthlySearches:"100"}]}});
beforeEach(async()=>{
  vi.unstubAllEnvs(); mocks.request.mockReset(); mocks.auth.mockClear();
  dir=await mkdtemp(join(tmpdir(),"rem-keywords-"));vi.stubEnv("REM_CACHE_DIR",dir);
  mocks.request.mockImplementation(async(o:any)=>({data:o.url.endsWith(":search")?{results:[{customer:{currencyCode:"PLN"}}]}:{results:[idea("marketing")]}}));
});
afterEach(async()=>{await rm(dir,{recursive:true,force:true});});
it("uses the official read-only endpoint and preserves nulls, currency and INT64 metrics",async()=>{
  const result=await researchKeywords(seed);
  expect(result).toMatchObject({provider:"google_ads_api",customerId:"1234567890",currencyCode:"PLN",network:"GOOGLE_SEARCH",languageId:"1030",geoTargetIds:["2616"],cacheHit:false,truncated:false});
  expect(result.keywords[0]).toMatchObject({text:"marketing",avgMonthlySearches:"9007199254740993",lowTopOfPageBidMicros:"1000000",highTopOfPageBidMicros:"9007199254740999",averageCpcMicros:"2345678",monthlySearchVolumes:[{year:"2026",month:"OCTOBER",monthlySearches:"100"}]});
  expect(mocks.request).toHaveBeenCalledWith(expect.objectContaining({url:"https://googleads.googleapis.com/v25/customers/1234567890:generateKeywordIdeas",data:expect.objectContaining({language:"languageConstants/1030",geoTargetConstants:["geoTargetConstants/2616"],historicalMetricsOptions:{includeAverageCpc:true},keywordPlanNetwork:"GOOGLE_SEARCH",keywordSeed:{keywords:["marketing"]}}),headers:expect.objectContaining({"x-goog-user-project":"keyword-project"})}));
  expect(mocks.request.mock.calls.every(([o]:any[])=>!o.url.includes(":mutate"))).toBe(true);
});
it("reuses a validated full-request snapshot without authenticating again",async()=>{
  const first=await researchKeywords(seed);mocks.request.mockClear();mocks.auth.mockClear();
  const second=await researchKeywords(seed);
  expect(second).toEqual({...first,cacheHit:true});expect(mocks.request).not.toHaveBeenCalled();expect(mocks.auth).not.toHaveBeenCalled();
  const files=await readdir(join(dir,"google-keywords"));expect(files).toHaveLength(1);
  expect((await stat(join(dir,"google-keywords",files[0]!))).mode&0o777).toBe(0o600);
});
it("isolates cached customers, locations, languages, limits and seeds",async()=>{
  for(const patch of [{},{customerId:"2222222222"},{geoTargetIds:["2840"]},{languageId:"1000"},{limit:1},{keywords:["seo"]},{projectId:"other-project"}]) await researchKeywords({...seed,...patch});
  expect((await readdir(join(dir,"google-keywords"))).length).toBe(7);
});
it("paginates short pages and explicitly marks a bounded result as truncated",async()=>{
  mocks.request.mockImplementation(async(o:any)=>({data:o.url.endsWith(":search")?{results:[]} : o.data.pageToken ? {results:[idea("seo"),idea("extra")]}:{results:[idea("marketing")],nextPageToken:"page2"}}));
  const result=await researchKeywords(seed);
  expect(result.keywords.map((x:any)=>x.text)).toEqual(["marketing","seo"]);expect(result.truncated).toBe(true);
});
it("retains unknown metrics and rejects malformed counts or looping page tokens",async()=>{
  mocks.request.mockImplementation(async(o:any)=>({data:o.url.endsWith(":search")?{results:[]}:{results:[{text:"marketing"}]}}));
  expect((await researchKeywords(seed)).keywords[0]).toMatchObject({avgMonthlySearches:null,averageCpcMicros:null,lowTopOfPageBidMicros:null,highTopOfPageBidMicros:null});
  mocks.request.mockImplementation(async(o:any)=>({data:o.url.endsWith(":search")?{results:[]}:{results:[{text:"bad",keywordIdeaMetrics:{avgMonthlySearches:"NaN"}}]}}));
  await expect(researchKeywords({...seed,refresh:true})).rejects.toThrow(/invalid|response/i);
  mocks.request.mockImplementation(async(o:any)=>({data:o.url.endsWith(":search")?{results:[]}:{results:[],nextPageToken:"repeat"}}));
  await expect(researchKeywords({...seed,refresh:true})).rejects.toThrow(/pagination|response/i);
});
it("validates inputs before authentication and accepts a public URL seed",async()=>{
  for(const options of [{...seed,keywords:[]},{...seed,customerId:"bad"},{...seed,limit:1001},{...seed,url:"http://127.0.0.1"},{...seed,keywords:["x".repeat(81)]}]) await expect(researchKeywords(options)).rejects.toThrow();
  expect(mocks.auth).not.toHaveBeenCalled();
  await researchKeywords({...seed,url:"https://example.com/product"});
  expect(mocks.request).toHaveBeenCalledWith(expect.objectContaining({data:expect.objectContaining({keywordAndUrlSeed:{keywords:["marketing"],url:"https://example.com/product"}})}));
});
it("checks actual planning access with a tiny uncached request and never exposes raw errors",async()=>{
  const success=await checkKeywordAccess({customerId:seed.customerId,projectId:seed.projectId});
  expect(success).toMatchObject({available:true,code:"AVAILABLE",customerId:"1234567890"});
  expect(mocks.request).toHaveBeenCalledWith(expect.objectContaining({data:expect.objectContaining({pageSize:1})}));
  expect(await readdir(dir)).toEqual([]);
  mocks.request.mockRejectedValue({response:{status:403,data:{error:{message:"SECRET /private/credentials.json",details:[{errors:[{errorCode:{authorizationError:"DEVELOPER_TOKEN_NOT_APPROVED"}}]}]}}}});
  const denied=await checkKeywordAccess({customerId:seed.customerId});
  expect(denied.available).toBe(false);expect(JSON.stringify(denied)).not.toMatch(/SECRET|private|credentials/);
  expect(denied.code).toMatch(/DEVELOPER_TOKEN_NOT_APPROVED|ACCESS/);
});
it("expired, future or corrupt cache entries are misses and failed refresh preserves previous data",async()=>{
  await researchKeywords(seed);
  const file=join(dir,"google-keywords",(await readdir(join(dir,"google-keywords")))[0]!);
  const original=JSON.parse(await readFile(file,"utf8"));
  for(const patch of [{fetchedAt:"2020-01-01T00:00:00.000Z"},{fetchedAt:"2099-01-01T00:00:00.000Z"},{version:0}]) {
    await writeFile(file,JSON.stringify({...original,...patch}));
    expect((await researchKeywords(seed)).cacheHit).toBe(false);
  }
  const before=await readFile(file,"utf8");mocks.request.mockRejectedValue(new Error("secret authentication problem"));
  await expect(researchKeywords({...seed,refresh:true})).rejects.toThrow();expect(await readFile(file,"utf8")).toBe(before);
});

it("sanitizes malformed upstream error details without throwing raw transport data",async()=>{
  mocks.request.mockRejectedValue({response:{status:403,data:{error:{details:[null,{errors:"SECRET"}]}}}});
  expect(await checkKeywordAccess(seed)).toMatchObject({available:false,code:"ACCESS_DENIED"});
});

it("uses dedicated Ads configuration and sanitizes credential loading failures",async()=>{
  vi.stubEnv("REM_GOOGLE_ADS_CUSTOMER_ID","123-456-7890");
  vi.stubEnv("REM_GOOGLE_ADS_LOGIN_CUSTOMER_ID","222-333-4444");
  vi.stubEnv("REM_GOOGLE_ADS_PROJECT_ID","keyword-project");
  vi.stubEnv("REM_GOOGLE_ADS_CREDENTIALS","/private/ads-credentials.json");
  await researchKeywords({keywords:["marketing"]});
  expect(mocks.auth).toHaveBeenCalledWith({scopes:["https://www.googleapis.com/auth/adwords"],keyFilename:"/private/ads-credentials.json"});
  expect(mocks.request).toHaveBeenCalledWith(expect.objectContaining({retry:false,headers:{"x-goog-user-project":"keyword-project","login-customer-id":"2223334444"}}));
  const file=join(dir,"google-keywords",(await readdir(join(dir,"google-keywords")))[0]!);
  expect(await readFile(file,"utf8")).not.toContain("private");
  mocks.auth.mockImplementationOnce(()=>{throw new Error("secret /private/ads-credentials.json");});
  const failed=await checkKeywordAccess();
  expect(failed).toMatchObject({available:false,code:"GOOGLE_REQUEST_FAILED"});
  expect(JSON.stringify(failed)).not.toMatch(/secret|private|credentials/);
});
it("bounds pagination at ten pages and retains explicit unknown currency",async()=>{
  let pages=0;
  mocks.request.mockImplementation(async(o:any)=>{
    if(o.url.endsWith(":search"))throw new Error("currency unavailable");
    pages++;return {data:{results:[{text:`idea ${pages}`}],nextPageToken:`page${pages}`}};
  });
  const result=await researchKeywords({...seed,limit:1000});
  expect(pages).toBe(10);expect(result.keywords).toHaveLength(10);expect(result.truncated).toBe(true);
  expect(result.currencyCode).toBeNull();expect(result.limitations.join(" ")).toContain("do not assume PLN");
});
