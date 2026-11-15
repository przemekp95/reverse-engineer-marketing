import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EvidenceStore } from "../src/evidence.js";
import { scorecard } from "../src/analyze/scorecard.js";
import { collectPaid } from "../src/sources/paid.js";
import { reverseEngineer } from "../src/index.js";
import type { Ctx } from "../src/context.js";

const mocks = vi.hoisted(() => ({ query: vi.fn(), createQueryJob: vi.fn(), config: {} as { googleAdvertisers?: Record<string, string[]> } }));
vi.mock("@google-cloud/bigquery", () => ({ BigQuery: class { query = mocks.query; createQueryJob = mocks.createQueryJob; } }));
vi.mock("../src/config.js", () => ({ readConfig: () => mocks.config }));
vi.mock("../src/sources/website.js", () => ({ collectWebsite: async () => {} }));
vi.mock("../src/sources/scrapecreators.js", () => ({ scrapeCreatorsFromEnv: () => null }));
const advertiserId = "AR01847332847816278017";
function context(): Ctx {
  return { target: { kind: "website", input: "example.com", url: "https://example.com", domain: "example.com" }, store: new EvidenceStore(), sc: null, content: [], found: { socials: {}, people: [], appStoreIds: [], playIds: [], logos: [], founderHints: [] }, log: () => {} };
}
let cacheDir: string;
afterEach(() => rmSync(cacheDir, { recursive: true, force: true }));
beforeEach(() => {
  vi.unstubAllEnvs();
  cacheDir = mkdtempSync(join(tmpdir(), "rem-google-cache-"));
  vi.stubEnv("REM_CACHE_DIR", cacheDir);
  vi.stubEnv("REM_NO_CACHE", "1");
  vi.stubEnv("REM_BIGQUERY_PROJECT_ID", "test-project");
  vi.stubEnv("REM_CONFIG_DIR", "/nonexistent/rem-test-config");
  mocks.query.mockReset();
  mocks.createQueryJob.mockReset();
  mocks.config = {};
});
describe("official Google ads collection", () => {
  it("collects scoped advertiser evidence without a ScrapeCreators key", async () => {
    const ctx = context();
    Object.assign(ctx, { googleAdvertiserIds: [advertiserId] });
    mocks.query.mockResolvedValue([[{ total: "150", shownLast30d: "120", dated: "150", sample: [{ advertiser_id: advertiserId, creative_id: "CR1", advertiser_disclosed_name: "Example", ad_format_type: "TEXT", creative_page_url: `https://adstransparency.google.com/advertiser/${advertiserId}/creative/CR1`, first_shown: "2024-01-01", last_shown: "2026-11-14", regions_json: "[]", audience_json: "null" }] }]]);
    await collectPaid(ctx);
    expect(ctx.store.bySource("google_ads")[0]).toMatchObject({ data: { provider: "google_bigquery", scope: "EEA and Turkey", totalInScope: "150", shownLast30d: "120", advertiserIds: [advertiserId] } });
    expect(mocks.query).toHaveBeenCalledWith(expect.objectContaining({ location: "US", useLegacySql: false, maximumBytesBilled: "1073741824", params: expect.objectContaining({ advertiserIds: [advertiserId], asOfDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) }) }));
    expect(ctx.content).toHaveLength(1);
    expect(ctx.content[0]?.status).toBeUndefined();
    expect(ctx.content[0]?.thumb).toBeUndefined();
    expect(scorecard(ctx.store).find(c => c.channel === "paid_google")).toMatchObject({ status: "likely", signal: expect.stringContaining("EEA and Turkey") });
  });
  it("does not guess an advertiser from domain or use ScrapeCreators Google endpoints", async () => {
    const ctx = context();
    ctx.sc = { get: vi.fn().mockResolvedValue({}), can: () => false } as any;
    await collectPaid(ctx);
    expect(mocks.query).not.toHaveBeenCalled();
    expect(ctx.store.unknowns).toContainEqual(expect.objectContaining({ channel: "paid_google", reason: expect.stringContaining("advertiser") }));
    expect((ctx.sc!.get as any).mock.calls.every(([path]: [string]) => !path.startsWith("/v1/google/"))).toBe(true);
  });
  it("treats a checked empty regional dataset as globally unknown", async () => {
    const ctx = context(); Object.assign(ctx, { googleAdvertiserIds: [advertiserId] });
    mocks.query.mockResolvedValue([[{ total: "0", shownLast30d: "0", dated: "0", sample: null }]]);
    await collectPaid(ctx);
    expect(ctx.store.bySource("google_ads")[0]).toMatchObject({ data: { totalInScope: "0" } });
    expect(scorecard(ctx.store).find(c => c.channel === "paid_google")?.status).toBe("unknown");
  });
  it("turns permission, billing-cap and malformed-response errors into unknowns", async () => {
    for (const response of [new Error("Access Denied"), new Error("maximum bytes billed exceeded"), [[{ unexpected: true }]]]) {
      const ctx = context(); Object.assign(ctx, { googleAdvertiserIds: [advertiserId] });
      if (response instanceof Error) mocks.query.mockRejectedValue(response); else mocks.query.mockResolvedValue(response);
      await collectPaid(ctx);
      expect(ctx.store.bySource("google_ads")).toHaveLength(0);
      expect(ctx.store.unknowns.some(u => u.channel === "paid_google")).toBe(true);
    }
  });
  it("rejects invalid advertiser IDs and cost limits before making a query", async () => {
    for (const [ids, cap] of [[["not-an-id"], "1073741824"], [[advertiserId], "0"], [[advertiserId], "NaN"]] as [string[], string][]) {
      const ctx = context(); Object.assign(ctx, { googleAdvertiserIds: ids }); vi.stubEnv("REM_BIGQUERY_MAX_BYTES_BILLED", cap);
      await collectPaid(ctx);
      expect(ctx.store.bySource("google_ads")).toHaveLength(0);
      expect(ctx.store.unknowns.some(u => u.channel === "paid_google")).toBe(true);
    }
    expect(mocks.query).not.toHaveBeenCalled();
  });
  it("passes target-specific IDs through the public pipeline", async () => {
    mocks.query.mockResolvedValue([[{ total: "0", shownLast30d: "0", dated: "0", sample: null }]]);
    const result = await reverseEngineer("example.com", { only: ["paid"], googleAdvertiserIds: [advertiserId] });
    expect(result.evidence.find(e => e.source === "google_ads")).toBeDefined();
    expect(mocks.query).toHaveBeenCalledWith(expect.objectContaining({ params: expect.objectContaining({ advertiserIds: [advertiserId], asOfDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) }) }));
  });
  it("uses the original-domain mapping after a website redirect, but never another domain's IDs", async () => {
    mocks.config = { googleAdvertisers: { "example.com": [advertiserId] } };
    mocks.query.mockResolvedValue([[{ total: "0", shownLast30d: "0", dated: "0", sample: null }]]);
    const ctx = context(); ctx.target.domain = "example.org"; ctx.target.aliases = ["example.com"];
    await collectPaid(ctx);
    expect(mocks.query).toHaveBeenCalledWith(expect.objectContaining({ params: expect.objectContaining({ advertiserIds: [advertiserId], asOfDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) }) }));
    mocks.query.mockClear(); ctx.target.aliases = []; await collectPaid(ctx);
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("estimates a scan without executing the ad query or enforcing an execution cap on the estimate", async () => {
    const ctx = context(); Object.assign(ctx, { googleAdvertiserIds: [advertiserId], googleAdsDryRun: true });
    mocks.createQueryJob.mockResolvedValue([{ metadata: { statistics: { totalBytesProcessed: "134528045498" } } }]);
    await collectPaid(ctx);
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.createQueryJob).toHaveBeenCalledWith(expect.objectContaining({ dryRun: true, maximumBytesBilled: undefined, location: "US" }));
    expect(ctx.store.bySource("google_ads")).toHaveLength(0);
    expect(ctx.store.unknowns).toContainEqual(expect.objectContaining({ channel: "paid_google", reason: expect.stringContaining("134528045498") }));
  });

  it("does not call an advertiser dormant when the dataset supplies no usable dates", async () => {
    const ctx = context(); Object.assign(ctx, { googleAdvertiserIds: [advertiserId] });
    mocks.query.mockResolvedValue([[{ total: "1", shownLast30d: "0", dated: "0", sample: [{ advertiser_id: advertiserId, creative_id: "CR1", creative_page_url: `https://adstransparency.google.com/advertiser/${advertiserId}/creative/CR1` }] }]]);
    await collectPaid(ctx);
    expect(scorecard(ctx.store).find(c => c.channel === "paid_google")?.status).toBe("unknown");
  });

  it("keeps report facts and excludes bulky regional and audience payloads from evidence", async () => {
    const ctx = context(); Object.assign(ctx, { googleAdvertiserIds: [advertiserId] });
    const facts = { advertiser_id: advertiserId, creative_id: "CR1", advertiser_disclosed_name: "Example", advertiser_legal_name: "Example Ltd", ad_format_type: "TEXT", creative_page_url: `https://adstransparency.google.com/advertiser/${advertiserId}/creative/CR1`, first_shown: "2024-01-01", last_shown: "2024-02-01" };
    mocks.query.mockResolvedValue([[{ total: "1", shownLast30d: "0", dated: "1", sample: [{ ...facts, regions_json: "large regional payload", audience_json: "large audience payload", extra_field: "not needed by the report" }] }]]);
    await collectPaid(ctx);
    expect(ctx.store.bySource("google_ads")[0]).toMatchObject({ data: { totalInScope: "1", withLastShownDate: "1", sample: [facts] } });
    const data = ctx.store.bySource("google_ads")[0]!.data as { sample: Record<string, unknown>[] };
    expect(data.sample[0]).toEqual(facts);
    expect(ctx.content[0]).toMatchObject({ url: facts.creative_page_url, author: "Example", date: "2024-01-01", tags: ["EEA and Turkey", "TEXT"] });
  });

  it("preserves useful regional ranges, reporting periods and categorical audience context without inventing totals", async () => {
    const ctx = context(); Object.assign(ctx, { googleAdvertiserIds: [advertiserId] });
    const regions = [
      { region_code: "EEA", first_shown: "2024-01-01", last_shown: "2024-02-01", times_shown_lower_bound: "9007199254740993", times_shown_upper_bound: "9007199254740999", times_shown_start_date: "2024-01-01", times_shown_end_date: "2024-02-01", times_shown_availability_date: null },
      { region_code: "PL", times_shown_lower_bound: null, times_shown_upper_bound: null, times_shown_start_date: null, times_shown_end_date: null, times_shown_availability_date: "2024-03-01" },
    ];
    const audience = { demographic_info: "CRITERIA_UNUSED", geo_location: "CRITERIA_INCLUDED", contextual_signals: null, customer_lists: "CRITERIA_EXCLUDED", topics_of_interest: "CRITERIA_INCLUDED_AND_EXCLUDED" };
    mocks.query.mockResolvedValue([[{ total: "100", shownLast30d: "0", dated: "100", sample: [{ advertiser_id: advertiserId, creative_id: "CR1", creative_page_url: `https://adstransparency.google.com/advertiser/${advertiserId}/creative/CR1`, regions, region_count: "2", audience_selection: audience }] }]]);
    await collectPaid(ctx);
    const data = ctx.store.bySource("google_ads")[0]!.data as any;
    expect(data.sample[0]).toMatchObject({ regions, region_count: "2", audience_selection: audience });
    expect(data.contextScope).toContain("sample");
    expect(data.limitations.join(" ")).toContain("Do not sum");
    expect(data.sample[0].totalImpressions).toBeUndefined();
    expect(data.sample[0].regions[1].times_shown_lower_bound).toBeNull();
  });
  it("retains null audience data and rejects invalid or reversed impression ranges", async () => {
    for (const region of [null, { region_code: "PL", times_shown_lower_bound: "not-a-count" }, { region_code: "PL", times_shown_lower_bound: "100", times_shown_upper_bound: "10" }]) {
      const ctx = context(); Object.assign(ctx, { googleAdvertiserIds: [advertiserId] });
      mocks.query.mockResolvedValue([[{ total: "1", shownLast30d: "0", dated: "1", sample: [{ advertiser_id: advertiserId, creative_id: "CR1", creative_page_url: `https://adstransparency.google.com/advertiser/${advertiserId}/creative/CR1`, regions: region ? [region] : [], region_count: region ? "1" : "0", audience_selection: null }] }]]);
      await collectPaid(ctx);
      if (region) {
        expect(ctx.store.bySource("google_ads")).toHaveLength(0);
        expect(ctx.store.unknowns.some(u => u.channel === "paid_google")).toBe(true);
      } else {
        expect(ctx.store.bySource("google_ads")[0]).toMatchObject({ data: { sample: [{ audience_selection: null, regions: [] }] } });
      }
    }
  });

  it("reuses a locally persisted snapshot without a second query or ADC project", async () => {
    vi.stubEnv("REM_NO_CACHE", "");
    const make = () => Object.assign(context(), { googleAdvertiserIds: [advertiserId] });
    mocks.query.mockResolvedValue([[{ total: "1", dated: "1", shownLast30d: "1", sample: [{ advertiser_id: advertiserId, creative_id: "CR1", creative_page_url: `https://adstransparency.google.com/advertiser/${advertiserId}/creative/CR1` }] }]]);
    const first = make(); await collectPaid(first);
    vi.stubEnv("REM_BIGQUERY_PROJECT_ID", ""); vi.stubEnv("GOOGLE_CLOUD_PROJECT", "");
    const second = make(); await collectPaid(second);
    expect(mocks.query).toHaveBeenCalledTimes(1);
    expect(second.store.bySource("google_ads")[0]).toMatchObject({ data: { totalInScope: "1", snapshot: { cacheHit: true, asOfDate: expect.any(String), fetchedAt: expect.any(String) } } });
    expect(second.content).toEqual(first.content);
    expect(scorecard(second.store).find(c => c.channel === "paid_google")?.signal).toContain(`as of ${new Date().toISOString().slice(0,10)}`);
  });

});
