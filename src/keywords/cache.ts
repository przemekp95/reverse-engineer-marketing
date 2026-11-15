import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rename, unlink, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { GoogleKeywordError, researchSchema, type KeywordRequest, type KeywordResearchResult } from "./contract.js";
const TTL_MS = 24 * 60 * 60 * 1000;
const snapshotSchema = z.object({version:z.literal(1),requestKey:z.string(),fetchedAt:z.iso.datetime(),result:researchSchema});
function location(request: KeywordRequest) {
  // Authentication file paths and credentials never enter the saved request or result.
  const { credentialsFile: _credentials, ...publicRequest } = request;
  const key = createHash("sha256").update(JSON.stringify({version:1,request:publicRequest})).digest("hex");
  const directory = join(process.env.REM_CACHE_DIR || join(homedir(),".cache","reverse-engineer-marketing"),"google-keywords");
  return {key,directory,file:join(directory,`${key}.json`)};
}
export async function readKeywordSnapshot(request: KeywordRequest): Promise<KeywordResearchResult | undefined> {
  if (process.env.REM_NO_CACHE) return;
  try {
    const {key,file} = location(request);
    const parsed = snapshotSchema.parse(JSON.parse(await readFile(file,"utf8")));
    const age = Date.now()-Date.parse(parsed.fetchedAt);
    const result = parsed.result;
    if (parsed.requestKey !== key || result.fetchedAt !== parsed.fetchedAt || age < 0 || age >= TTL_MS || result.customerId !== request.customerId || result.languageId !== request.languageId || JSON.stringify(result.geoTargetIds) !== JSON.stringify(request.geoTargetIds) || result.keywords.length > request.limit) return;
    return {...result,cacheHit:true};
  } catch { /* Invalid/expired snapshots require a fresh request; never reuse as zero. */ }
}
export async function writeKeywordSnapshot(request: KeywordRequest, result: KeywordResearchResult): Promise<void> {
  if (process.env.REM_NO_CACHE) return;
  const {key,directory,file} = location(request);
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const snapshot = snapshotSchema.parse({version:1,requestKey:key,fetchedAt:result.fetchedAt,result});
    await mkdir(directory,{recursive:true,mode:0o700}); await chmod(directory,0o700);
    await writeFile(temporary,JSON.stringify(snapshot),{mode:0o600,flag:"wx"});
    await rename(temporary,file);
  } catch { throw new GoogleKeywordError("CACHE_WRITE_FAILED","Google keyword results could not be saved locally"); }
  finally { await unlink(temporary).catch(()=>{}); }
}
