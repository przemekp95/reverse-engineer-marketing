import { expect,it } from "vitest";
import {spawnSync}from"node:child_process";
const run=(args:string[])=>spawnSync(process.execPath,["--import","tsx","src/cli.ts",...args],{encoding:"utf8",env:{...process.env,REM_GOOGLE_ADS_CUSTOMER_ID:""},timeout:10000});
it("documents direct keyword research and access checks",()=>{
 const r=run(["keywords","--help"]);expect(r.status).toBe(0);expect(r.stdout).toContain("keywords-check");expect(r.stdout).toContain("--keyword");
});
it("returns structured access diagnostics without customer setup or leaking secrets",()=>{
 const r=run(["keywords-check"]);expect(r.status).toBe(1);expect(JSON.parse(r.stdout)).toMatchObject({available:false,code:expect.any(String)});expect(r.stdout).not.toMatch(/client_secret|refresh_token/);
});
