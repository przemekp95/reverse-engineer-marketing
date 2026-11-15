import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { advertiserIdsForDomain, GOOGLE_ADS_TABLE, normalizeGoogleAdsResult, type GoogleAdsResult } from "./google-ads-data.js";

export interface GoogleAdsSnapshot {
  version: 1;
  table: typeof GOOGLE_ADS_TABLE;
  advertiserIds: string[];
  fetchedAt: string;
  asOfDate: string;
  maximumBytesBilled: string;
  result: GoogleAdsResult;
}
const envelope = z.object({ version: z.literal(1), table: z.literal(GOOGLE_ADS_TABLE), advertiserIds: z.array(z.string()), fetchedAt: z.iso.datetime(), asOfDate: z.iso.date(), maximumBytesBilled: z.string().regex(/^[1-9]\d*$/), result: z.unknown() });
export const GOOGLE_ADS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
function cachePath(ids: string[]) {
  const advertiserIds = advertiserIdsForDomain(undefined, ids).sort();
  const key = createHash("sha256").update(JSON.stringify({ version: 1, table: GOOGLE_ADS_TABLE, advertiserIds })).digest("hex");
  const directory = join(process.env.REM_CACHE_DIR || join(homedir(), ".cache", "reverse-engineer-marketing"), "google-ads");
  return { directory, file: join(directory, `${key}.json`), advertiserIds };
}
function validateSnapshot(raw: unknown, ids: string[]): GoogleAdsSnapshot {
  const parsed = envelope.parse(raw);
  const expected = cachePath(ids).advertiserIds;
  if (JSON.stringify(parsed.advertiserIds) !== JSON.stringify(expected) || parsed.asOfDate !== parsed.fetchedAt.slice(0, 10)) throw new Error("Unexpected Google BigQuery snapshot identity or date");
  return { ...parsed, result: normalizeGoogleAdsResult(parsed.result, expected) };
}
/** Invalid, stale and future snapshots are misses; errors never turn into zero ads. */
export async function readGoogleAdsSnapshot(ids: string[]): Promise<GoogleAdsSnapshot | undefined> {
  if (process.env.REM_NO_CACHE) return;
  try {
    const snapshot = validateSnapshot(JSON.parse(await readFile(cachePath(ids).file, "utf8")), ids);
    const age = Date.now() - Date.parse(snapshot.fetchedAt);
    if (age >= 0 && age < GOOGLE_ADS_CACHE_TTL_MS) return snapshot;
  } catch { /* A corrupt/old schema snapshot requires a fresh fetch. */ }
}
/** Atomic per identity-set replacement; failed writes leave earlier snapshots intact. */
export async function writeGoogleAdsSnapshot(snapshot: GoogleAdsSnapshot): Promise<void> {
  if (process.env.REM_NO_CACHE) return;
  const validated = validateSnapshot(snapshot, snapshot.advertiserIds);
  const { directory, file } = cachePath(snapshot.advertiserIds);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(validated), { mode: 0o600, flag: "wx" });
    await rename(temporary, file);
  } finally { await unlink(temporary).catch(() => {}); }
}
