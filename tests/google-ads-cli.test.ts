import { afterEach, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
