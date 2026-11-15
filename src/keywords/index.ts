import { z } from "zod";
import { GoogleKeywordError, KEYWORD_LIMITATIONS, normalizeIdea, normalizeOptions, pageSchema, type KeywordRequest, type KeywordResearchOptions, type KeywordResearchResult } from "./contract.js";
import { keywordTransport, safeKeywordError } from "./transport.js";
import { readKeywordSnapshot, writeKeywordSnapshot } from "./cache.js";
export { GoogleKeywordError } from "./contract.js";
export type { KeywordResearchOptions, KeywordResearchResult, KeywordIdea } from "./contract.js";

function body(request: KeywordRequest, pageSize: number, pageToken?: string) {
  const seed = request.url
    ? request.keywords.length ? {keywordAndUrlSeed:{keywords:request.keywords,url:request.url}} : {urlSeed:{url:request.url}}
    : {keywordSeed:{keywords:request.keywords}};
  return {language:`languageConstants/${request.languageId}`,geoTargetConstants:request.geoTargetIds.map(id=>`geoTargetConstants/${id}`),keywordPlanNetwork:"GOOGLE_SEARCH",includeAdultKeywords:false,historicalMetricsOptions:{includeAverageCpc:true},pageSize,...(pageToken ? {pageToken} : {}),...seed};
}
const currencySchema = z.object({results:z.array(z.object({customer:z.object({currencyCode:z.string().regex(/^[A-Z]{3}$/)})})).optional()});
/** Direct Google keyword planning; no campaign, ad group, ad or paid intermediary is created. */
export async function researchKeywords(options: KeywordResearchOptions): Promise<KeywordResearchResult> {
  try {
    const request = normalizeOptions(options);
    if (!options.refresh) {
      const cached = await readKeywordSnapshot(request);
      if (cached) return cached;
    }
    const transport = await keywordTransport(request);
    const keywords: KeywordResearchResult["keywords"] = [];
    const seenTokens = new Set<string>();
    let pageToken: string | undefined, truncated = false;
    for (let pageNumber=0;pageNumber<10;pageNumber++) {
      const parsed = pageSchema.safeParse(await transport("generateKeywordIdeas",body(request,Math.min(100,request.limit),pageToken)));
      if (!parsed.success) throw new GoogleKeywordError("INVALID_RESPONSE","Invalid Google keyword response");
      const page = parsed.data;
      const available = request.limit-keywords.length;
      const results = page.results ?? [];
      keywords.push(...results.slice(0,available).map(normalizeIdea));
      pageToken = page.nextPageToken || undefined;
      if (pageToken && seenTokens.has(pageToken)) throw new GoogleKeywordError("INVALID_RESPONSE","Invalid Google keyword pagination response");
      if (pageToken) seenTokens.add(pageToken);
      if (keywords.length >= request.limit || !pageToken || pageNumber===9) {
        truncated = results.length > available || Boolean(pageToken);
        break;
      }
    }
    let currencyCode: string | null = null;
    const limitations = [...KEYWORD_LIMITATIONS];
    try {
      const currency = currencySchema.safeParse(await transport("search",{query:"SELECT customer.currency_code FROM customer LIMIT 1"}));
      if (currency.success) currencyCode = currency.data.results?.[0]?.customer.currencyCode ?? null;
    } catch { /* Valid ideas remain useful with an explicitly unknown currency. */ }
    if (!currencyCode) limitations.push("Customer currency was not available; retain micros as unknown-currency values and do not assume PLN or USD.");
    const result: KeywordResearchResult = {provider:"google_ads_api",customerId:request.customerId,currencyCode,languageId:request.languageId,geoTargetIds:request.geoTargetIds,network:"GOOGLE_SEARCH",fetchedAt:new Date().toISOString(),cacheHit:false,keywords,truncated,limitations};
    await writeKeywordSnapshot(request,result);
    return result;
  } catch (error) { throw safeKeywordError(error); }
}
export interface KeywordAccessResult { available:boolean;code:string;checkedAt:string;customerId:string|null; }
/** One tiny uncached call checks this capability, not merely generic reporting access. */
export async function checkKeywordAccess(options: KeywordResearchOptions = {}): Promise<KeywordAccessResult> {
  const checkedAt = new Date().toISOString();
  let customerId: string | null = null;
  try {
    const request = normalizeOptions({...options,keywords:["marketing"],url:undefined,limit:1}); customerId=request.customerId;
    const transport = await keywordTransport(request);
    const parsed = pageSchema.safeParse(await transport("generateKeywordIdeas",body(request,1)));
    if (!parsed.success) throw new GoogleKeywordError("INVALID_RESPONSE","Invalid Google keyword response");
    return {available:true,code:"AVAILABLE",checkedAt,customerId};
  } catch (error) { return {available:false,code:safeKeywordError(error).code,checkedAt,customerId}; }
}
