import { z } from "zod";
import { assertPublicUrl } from "../http.js";

export interface KeywordResearchOptions {
  keywords?: string[];
  url?: string;
  customerId?: string;
  loginCustomerId?: string;
  projectId?: string;
  credentialsFile?: string;
  languageId?: string;
  geoTargetIds?: string[];
  limit?: number;
  refresh?: boolean;
}
export interface KeywordRequest {
  customerId: string;
  loginCustomerId?: string;
  projectId?: string;
  credentialsFile?: string;
  keywords: string[];
  url?: string;
  languageId: string;
  geoTargetIds: string[];
  limit: number;
}
export class GoogleKeywordError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "GoogleKeywordError"; }
}
const invalid = () => new GoogleKeywordError("INVALID_INPUT", "Invalid Google keyword research input");
export function normalizeOptions(options: KeywordResearchOptions = {}): KeywordRequest {
  const customerId = (options.customerId ?? process.env.REM_GOOGLE_ADS_CUSTOMER_ID ?? "").replace(/-/g, "");
  if (!customerId) throw new GoogleKeywordError("NOT_CONFIGURED", "Set REM_GOOGLE_ADS_CUSTOMER_ID or supply customerId for Google keyword research");
  const loginCustomerId = (options.loginCustomerId ?? process.env.REM_GOOGLE_ADS_LOGIN_CUSTOMER_ID)?.replace(/-/g, "") || undefined;
  const projectId = options.projectId ?? process.env.REM_GOOGLE_ADS_PROJECT_ID;
  const credentialsFile = options.credentialsFile ?? process.env.REM_GOOGLE_ADS_CREDENTIALS;
  const languageId = options.languageId ?? "1030";
  const geoTargetIds = [...new Set(options.geoTargetIds ?? ["2616"])].sort();
  const keywords = [...new Set((options.keywords ?? []).map(s => s.trim()).filter(Boolean))];
  const limit = options.limit ?? 100;
  if (!/^\d{10}$/.test(customerId) || (loginCustomerId && !/^\d{10}$/.test(loginCustomerId)) || !/^\d+$/.test(languageId) || geoTargetIds.length > 10 || geoTargetIds.some(id => !/^\d+$/.test(id)) || keywords.length > 20 || keywords.some(k => k.length > 80 || k.split(/\s+/).length > 10) || !Number.isInteger(limit) || limit < 1 || limit > 1000 || (projectId && !/^[a-z0-9][a-z0-9-]{4,62}$/.test(projectId))) throw invalid();
  let url: string | undefined;
  if (options.url) {
    try {
      const parsed = assertPublicUrl(options.url);
      if (parsed.username || parsed.password) throw invalid();
      url = parsed.toString();
    } catch { throw invalid(); }
  }
  if (!keywords.length && !url) throw invalid();
  return { customerId, loginCustomerId, projectId, credentialsFile, keywords, url, languageId, geoTargetIds, limit };
}
const decimal = z.string().regex(/^\d+$/);
const optionalDecimal = decimal.nullish().transform(value => value ?? null);
const monthSchema = z.object({ year: decimal.refine(value => BigInt(value) > 0n), month: z.enum(["JANUARY","FEBRUARY","MARCH","APRIL","MAY","JUNE","JULY","AUGUST","SEPTEMBER","OCTOBER","NOVEMBER","DECEMBER"]), monthlySearches: optionalDecimal });
const metricsSchema = z.object({
  avgMonthlySearches: optionalDecimal,
  competition: z.enum(["UNSPECIFIED","UNKNOWN","LOW","MEDIUM","HIGH"]).nullish().transform(value => value ?? null),
  competitionIndex: decimal.refine(value => BigInt(value) <= 100n).nullish().transform(value => value ?? null),
  lowTopOfPageBidMicros: optionalDecimal, highTopOfPageBidMicros: optionalDecimal, averageCpcMicros: optionalDecimal,
  monthlySearchVolumes: z.array(monthSchema).max(240).nullish().transform(value => value ?? []),
});
const rawIdeaSchema = z.object({ text: z.string().min(1).max(1000), closeVariants: z.array(z.string()).max(1000).optional(), keywordIdeaMetrics: metricsSchema.nullish() });
export const pageSchema = z.object({ results: z.array(rawIdeaSchema).max(10000).optional(), nextPageToken: z.string().max(10000).optional() });
export function normalizeIdea(raw: z.infer<typeof rawIdeaSchema>) {
  return { text: raw.text, closeVariants: raw.closeVariants ?? [], ...metricsSchema.parse(raw.keywordIdeaMetrics ?? {}) };
}
export const ideaSchema = z.object({text:z.string().min(1).max(1000),closeVariants:z.array(z.string()).max(1000)}).extend(metricsSchema.shape);
export type KeywordIdea = z.infer<typeof ideaSchema>;
export const researchSchema = z.object({
  provider:z.literal("google_ads_api"), customerId:z.string().regex(/^\d{10}$/), currencyCode:z.string().regex(/^[A-Z]{3}$/).nullable(),
  languageId:z.string().regex(/^\d+$/),geoTargetIds:z.array(z.string().regex(/^\d+$/)).max(10),network:z.literal("GOOGLE_SEARCH"),
  fetchedAt:z.iso.datetime(),cacheHit:z.boolean(),keywords:z.array(ideaSchema).max(1000),truncated:z.boolean(),limitations:z.array(z.string()),
});
export type KeywordResearchResult = z.infer<typeof researchSchema>;
export const KEYWORD_LIMITATIONS = [
  "Keyword ideas and market metrics are not a competitor's actual campaign keyword list or search-term report.",
  "Bid ranges and average CPC are market estimates in the customer account currency, not a competitor's actual CPC, budget or CPL.",
  "Missing metrics remain unknown. Historical metrics may be rounded, grouped or unavailable and do not guarantee future results.",
];
