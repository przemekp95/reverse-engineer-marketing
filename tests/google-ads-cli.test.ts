import { afterEach, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
const directories: string[] = [];
afterEach(() => directories.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })));
it("saves a normalized target-specific mapping and preserves other settings", () => {
  const dir = mkdtempSync(join(tmpdir(), "rem-google-")); directories.push(dir);
  writeFileSync(join(dir, "config.json"), JSON.stringify({ scrapecreatorsKey: "existing-test-key", googleAdvertisers: { "other.example": ["AR00000000000000000001"] } }));
  const output = execFileSync(process.execPath, ["--import", "tsx", "src/cli.ts", "google-link", "https://www.example.com/pricing", "AR01847332847816278017"], { encoding: "utf8", env: { ...process.env, REM_CONFIG_DIR: dir }, timeout: 10000 });
  expect(output).toContain("example.com");
  expect(JSON.parse(readFileSync(join(dir, "config.json"), "utf8"))).toEqual({ scrapecreatorsKey: "existing-test-key", googleAdvertisers: { "other.example": ["AR00000000000000000001"], "example.com": ["AR01847332847816278017"] } });
  expect(output).not.toContain("existing-test-key");
  expect(() => execFileSync(process.execPath, ["--import", "tsx", "src/cli.ts", "google-link", "example.com", "invalid"], { env: { ...process.env, REM_CONFIG_DIR: dir }, stdio: "pipe", timeout: 10000 })).toThrow();
  expect(JSON.parse(readFileSync(join(dir, "config.json"), "utf8")).googleAdvertisers["example.com"]).toEqual(["AR01847332847816278017"]);
});

it("documents joint Google fetching, dry runs and explicit refresh", () => {
  const output = execFileSync(process.execPath, ["--import", "tsx", "src/cli.ts", "google-fetch", "--help"], { encoding: "utf8", timeout: 10000 });
  expect(output).toContain("google-fetch <domain> [domain…]");
  expect(output).toContain("--refresh");
  expect(output).toContain("google-fetch: estimate");
});

it("rejects an empty Google fetch command with actionable usage", () => {
  const result = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", "google-fetch"], { encoding: "utf8", timeout: 10000 });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("usage: rem google-fetch <domain> [domain…]");
});
it("uses a locally saved Google snapshot without credentials and leaves mappings unchanged", () => {
  const dir = mkdtempSync(join(tmpdir(), "rem-google-fetch-")); directories.push(dir);
  const advertiserIds = ["AR01847332847816278017"];
  const config = { googleAdvertisers: { "example.com": advertiserIds } };
  writeFileSync(join(dir, "config.json"), JSON.stringify(config));
  const table = "bigquery-public-data.google_ads_transparency_center.creative_stats";
  const fetchedAt = new Date().toISOString();
  const asOfDate = fetchedAt.slice(0, 10);
  const snapshot = { version: 1, table, advertiserIds, fetchedAt, asOfDate, maximumBytesBilled: "1073741824", result: { total: "1", dated: "1", shownLast30d: "1", sample: [{ advertiser_id: advertiserIds[0], creative_id: "CR1", creative_page_url: `https://adstransparency.google.com/advertiser/${advertiserIds[0]}/creative/CR1`, ad_format_type: "TEXT", first_shown: asOfDate, last_shown: asOfDate, regions: [{ region_code: "PL", first_shown: asOfDate, last_shown: asOfDate, times_shown_lower_bound: "100", times_shown_upper_bound: "200", times_shown_start_date: asOfDate, times_shown_end_date: asOfDate, times_shown_availability_date: null }], region_count: "1", audience_selection: null }] } };
  const key = createHash("sha256").update(JSON.stringify({ version: 1, table, advertiserIds })).digest("hex");
  mkdirSync(join(dir, "google-ads"));
  writeFileSync(join(dir, "google-ads", `${key}.json`), JSON.stringify(snapshot));
  const env = { ...process.env, REM_CONFIG_DIR: dir, REM_CACHE_DIR: dir, REM_NO_CACHE: "", REM_BIGQUERY_PROJECT_ID: "", GOOGLE_CLOUD_PROJECT: "", GOOGLE_APPLICATION_CREDENTIALS: join(dir, "no-credentials.json") };
  const output = execFileSync(process.execPath, ["--import", "tsx", "src/cli.ts", "google-fetch", "https://www.example.com/pricing"], { encoding: "utf8", env, timeout: 10000 });
  expect(JSON.parse(output)).toMatchObject({ dryRun: false, requested: 1, cached: 1, fetched: 0, snapshots: [{ domain: "example.com", advertiserIds, fetchedAt, asOfDate, cacheHit: true }] });
  expect(JSON.parse(readFileSync(join(dir, "config.json"), "utf8"))).toEqual(config);
  const dryRun = execFileSync(process.execPath, ["--import", "tsx", "src/cli.ts", "google-fetch", "example.com", "--dry-run"], { encoding: "utf8", env, timeout: 10000 });
  expect(JSON.parse(dryRun)).toMatchObject({ dryRun: true, cached: 1, fetched: 0 });
  const refresh = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", "google-fetch", "example.com", "--refresh"], { encoding: "utf8", env, timeout: 10000 });
  expect(refresh.status).toBe(1);
  expect(refresh.stderr).toContain("Google BigQuery fetch failed");
  expect(refresh.stderr).not.toContain("no-credentials.json");
  expect(JSON.parse(readFileSync(join(dir, "google-ads", `${key}.json`), "utf8"))).toEqual(snapshot);
});
