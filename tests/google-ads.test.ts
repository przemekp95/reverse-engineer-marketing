import { beforeEach, describe, expect, it, vi } from "vitest";
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
beforeEach(() => {
  vi.unstubAllEnvs();
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
    expect(mocks.query).toHaveBeenCalledWith(expect.objectContaining({ location: "US", useLegacySql: false, maximumBytesBilled: "1073741824", params: { advertiserIds: [advertiserId] } }));
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
    expect(mocks.query).toHaveBeenCalledWith(expect.objectContaining({ params: { advertiserIds: [advertiserId] } }));
  });
  it("uses the original-domain mapping after a website redirect, but never another domain's IDs", async () => {
    mocks.config = { googleAdvertisers: { "example.com": [advertiserId] } };
    mocks.query.mockResolvedValue([[{ total: "0", shownLast30d: "0", dated: "0", sample: null }]]);
    const ctx = context(); ctx.target.domain = "example.org"; ctx.target.aliases = ["example.com"];
    await collectPaid(ctx);
    expect(mocks.query).toHaveBeenCalledWith(expect.objectContaining({ params: { advertiserIds: [advertiserId] } }));
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

});
