#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { synthesize } from "./analyze/synthesize.js";
import { applyConfig, readConfig, writeConfig } from "./config.js";
import { advertiserIdsForDomain, estimateGoogleAdsScan } from "./sources/google-ads.js";
import { parseTarget } from "./target.js";
import { AREAS, reverseEngineer, VERSION, type Area } from "./index.js";
import { renderMarkdown } from "./report/markdown.js";
import { validateReport } from "./report/validate.js";

try {
  process.loadEnvFile(".env");
} catch {
  // no .env in cwd
}
applyConfig();

const HELP = `reverse-engineer-marketing v${VERSION}

Reverse engineer any company's marketing from one link.

Usage
  rem <url>                 website, App Store or Google Play link
  rem web                   open the local web app (uses your Claude Code / Codex plan)
  rem mcp                   run the MCP server (stdio) for Claude Code, Codex, Cursor…
  rem google-estimate <AR…> [AR…]  estimate Google scan bytes without executing the query
  rem google-link <domain> <AR…> [AR…]  save verified Google advertiser IDs for this domain
  rem doctor                show which sources your keys unlock
  rem setup                 connect REM to Claude Code / Codex (shows the plan, asks first)
  rem diff <domain>         what changed since the previous run (or: rem diff <runA> <runB>)
  rem demo                  open a recorded Cal AI teardown in the web app — no keys needed

Options
  --no-ai                   skip the written strategy; evidence report only
  --json                    print the evidence bundle as JSON to stdout
  --out <dir>               output folder (default ./rem-reports/<domain>-<date>)
  --only <areas>            comma list: ${AREAS.join(",")}
  --handle <platform=name>  override a discovered handle, e.g. --handle tiktok=notionhq
  --model <id>              Claude model for the report (default claude-opus-5)
  --google-advertiser <AR…>  target-specific Google advertiser ID (repeat for multiple IDs)
  --max-credits <n>         Scrape Creators budget per run (default 50)
  --port <n>                web app port (default 4321)
  --client <list>           setup: claude_code,codex (default: all detected)
  --dry-run / --yes         setup: only show the plan / apply without asking
  --no-open                 don't open the browser for rem web
  -q, --quiet               no progress output

Sources (optional): REM_BIGQUERY_PROJECT_ID + Google ADC for Google ads; SCRAPECREATORS_API_KEY for other paid/social sources; ANTHROPIC_API_KEY for reports — see .env.example`;

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const cmd = args._[0];
  if (!cmd || args.help) {
    console.log(HELP);
    return cmd ? 0 : 1;
  }
  if (args.version) {
    console.log(VERSION);
    return 0;
  }
  if (cmd === "mcp") {
    const { startMcp } = await import("./mcp.js");
    await startMcp();
    return -1; // keep running
  }
  if (cmd === "web") {
    const { startWeb } = await import("./web/server.js");
    const url = await startWeb(Number(args.port ?? process.env.REM_PORT ?? 4321));
    console.log(`REM is running at ${url}  (Ctrl+C to stop)`);
    if (!args["no-open"]) openBrowser(url);
    return -1;
  }
  if (cmd === "doctor") return doctor();
  if (cmd === "google-estimate") {
    const ids = advertiserIdsForDomain(undefined, args._.slice(1));
    if (!ids.length) throw new Error("usage: rem google-estimate <AR…> [AR…]");
    try {
      const estimate = await estimateGoogleAdsScan(ids);
      console.log(JSON.stringify({ dryRun: true, ...estimate, note: "No ad query executed. Raising the cap can incur BigQuery charges after the free tier is exhausted." }, null, 2));
    } catch { throw new Error("Google BigQuery estimate failed. Check project, ADC, BigQuery API, IAM, advertiser IDs and byte-cap configuration."); }
    return 0;
  }
  if (cmd === "google-link") {
    const target = parseTarget(args._[1] ?? "");
    const ids = advertiserIdsForDomain(target.domain, args._.slice(2));
    if (target.kind !== "website" || !target.domain || !ids.length) throw new Error("usage: rem google-link <domain> <AR…> [AR…]");
    writeConfig({ googleAdvertisers: { ...readConfig().googleAdvertisers, [target.domain]: ids } });
    console.log(`Saved Google advertiser IDs for ${target.domain}: ${ids.join(", ")}. This is a user-supplied identity mapping, not a destination-domain match.`);
    return 0;
  }
  if (cmd === "setup") {
    const { setup } = await import("./setup.js");
    return setup({ clients: args.client ? String(args.client).split(",") : [], yes: Boolean(args.yes), dryRun: Boolean(args["dry-run"]), json: Boolean(args.json) });
  }
  if (cmd === "diff") return diff(args._.slice(1), Boolean(args.json));
  if (cmd === "demo") return demo(Boolean(args["no-open"]), Number(args.port ?? process.env.REM_PORT ?? 4321));

  const log = args.quiet || args.json ? () => {} : (m: string) => console.error(m);
  const only = args.only ? (String(args.only).split(",").map(s => s.trim()) as Area[]) : undefined;
  const bad = only?.filter(a => !AREAS.includes(a));
  if (bad?.length) throw new Error(`Unknown area(s): ${bad.join(", ")}. Use: ${AREAS.join(", ")}`);
  const handles = Object.fromEntries(([] as string[]).concat(args.handle ?? []).map(h => h.split("=") as [string, string]).filter(([k, v]) => k && v));

  const t0 = Date.now();
  const bundle = await reverseEngineer(cmd, { only, handles, googleAdvertiserIds: args["google-advertiser"], maxCredits: args["max-credits"] ? Number(args["max-credits"]) : undefined, log });
  log(`✓ ${bundle.evidence.length} evidence items, ${bundle.unknowns.length} unknowns in ${((Date.now() - t0) / 1000).toFixed(1)}s${bundle.credits.scrapecreators != null ? ` (${bundle.credits.scrapecreators} credits)` : ""}`);

  if (args.json) {
    process.stdout.write(`${JSON.stringify(bundle, null, 2)}\n`);
    return 0;
  }

  let narrative: string | undefined;
  if (!args["no-ai"]) {
    if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) {
      log("→ writing strategy report with Claude…");
      try {
        const res = await synthesize(bundle, { model: args.model });
        narrative = res.markdown;
        const v = validateReport(narrative, bundle);
        log(`✓ report by ${res.model} (${res.usage.output} output tokens) · validation ${Math.round(v.score * 100)}%${v.ok ? "" : ` — ${v.checks.filter(c => !c.ok).map(c => `${c.name}: ${c.detail}`).join("; ")}`}`);
      } catch (err) {
        log(`! synthesis failed: ${err instanceof Error ? err.message : err} — writing evidence report instead`);
      }
    } else log("· ANTHROPIC_API_KEY not set — writing the evidence report (use MCP to let your agent write the strategy)");
  }

  const dir = resolve(args.out ?? join("rem-reports", `${(bundle.target.domain ?? bundle.brand).replace(/[^a-z0-9.-]/gi, "_")}-${bundle.generatedAt.slice(0, 10)}`));
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "evidence.json"), JSON.stringify(bundle, null, 2));
  await writeFile(join(dir, "report.md"), renderMarkdown(bundle, { narrative }));
  console.log(join(dir, "report.md"));
  log("\nNeed UGC creatives to run what you just found? → https://dansugc.com/?utm_source=rem&utm_medium=cli&utm_campaign=reverse-engineer-marketing");
  return 0;
}

function openBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const argv = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  spawn(cmd, argv, { stdio: "ignore", detached: true }).on("error", () => {}).unref();
}

function doctor(): number {
  const sc = Boolean(process.env.SCRAPECREATORS_API_KEY || process.env.SCRAPE_CREATORS_API_KEY);
  const ai = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
  const row = (ok: boolean, name: string, what: string) => console.log(`${ok ? "✓" : "·"} ${name.padEnd(24)} ${what}`);
  console.log(`reverse-engineer-marketing v${VERSION} · node ${process.version}\n`);
  row(true, "free sources", "website, pixels + GTM, SEO/sitemaps, AI-crawler stance, Wayback history, App Store/Play, Hacker News");
  row(sc, "SCRAPECREATORS_API_KEY", sc ? "Meta/LinkedIn ad libraries, TikTok/IG/YouTube/X/LinkedIn stats, founders, Reddit, Product Hunt" : "not set — Meta/LinkedIn/social/founders become manual-check links (https://scrapecreators.com)");
  row(Boolean(process.env.REM_BIGQUERY_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT), "Google BigQuery", "official EEA/Turkey Google ads; requires project + ADC + target advertiser IDs (credentials/access not checked)");
  row(ai, "ANTHROPIC_API_KEY", ai ? `written strategy report (${process.env.REM_MODEL ?? "claude-opus-5"})` : "not set — CLI writes the evidence report; via MCP your agent writes the strategy");
  return 0;
}

async function diff(refs: string[], asJson: boolean): Promise<number> {
  const { diffRuns, renderDiff } = await import("./report/diff.js");
  const { resolveRun, runsForDomain, loadRun } = await import("./runs.js");
  let a, b;
  if (refs.length === 1) {
    const runs = await runsForDomain(refs[0]!);
    if (runs.length < 2) throw new Error(`Need two saved runs of ${refs[0]} to diff (found ${runs.length}). Run \`rem ${refs[0]}\` again later.`);
    [b, a] = [await loadRun(runs[0]!.id), await loadRun(runs[1]!.id)];
  } else if (refs.length === 2) {
    [a, b] = [await resolveRun(refs[0]!), await resolveRun(refs[1]!)];
  } else throw new Error("usage: rem diff <domain>  |  rem diff <runA> <runB>");
  const d = diffRuns(a, b);
  console.log(asJson ? JSON.stringify(d, null, 2) : renderDiff(d));
  return 0;
}

/** Keyless demo: load the bundled Cal AI run (evidence + written report) and open it in the web app. */
async function demo(noOpen: boolean, port: number): Promise<number> {
  const { readFile } = await import("node:fs/promises");
  const { fileURLToPath } = await import("node:url");
  const { dirname } = await import("node:path");
  const { saveReport, RUNS_DIR } = await import("./runs.js");
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "examples");
  const bundle = JSON.parse(await readFile(join(root, "calai.app.evidence.json"), "utf8"));
  const report = (await readFile(join(root, "calai.app.md"), "utf8")).split(/\n---\n\n## Evidence/)[0]!;
  const id = "demo-calai.app";
  await mkdir(RUNS_DIR, { recursive: true });
  await writeFile(join(RUNS_DIR, `${id}.json`), JSON.stringify(bundle, null, 2));
  await saveReport(id, report, { engine: "claude-code", model: "recorded example" });
  console.log(`Demo run saved (no keys used): ${id}`);
  const { startWeb } = await import("./web/server.js");
  const url = await startWeb(port);
  console.log(`Open ${url}/#/run/${id}  (Ctrl+C to stop)`);
  if (!noOpen) openBrowser(`${url}/#/run/${id}`);
  return -1;
}

interface Args {
  _: string[];
  [k: string]: any;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { _: [] };
  const flags = new Set(["no-ai", "json", "quiet", "help", "version", "no-open", "yes", "dry-run"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "-q") out.quiet = true;
    else if (a === "-h") out.help = true;
    else if (a === "-v") out.version = true;
    else if (a.startsWith("--")) {
      const [k, inline] = a.slice(2).split(/=(.*)/s) as [string, string | undefined];
      if (flags.has(k)) out[k] = true;
      else {
        const v = inline ?? argv[++i];
        if (v === undefined) throw new Error(`--${k} needs a value`);
        out[k] = k === "handle" || k === "google-advertiser" ? [...(out[k] ?? []), v] : v;
      }
    } else out._.push(a);
  }
  return out;
}

main(process.argv.slice(2)).then(
  code => {
    if (code >= 0) process.exitCode = code;
  },
  err => {
    console.error(`error: ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
  },
);
