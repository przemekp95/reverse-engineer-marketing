import { beforeEach, expect, it, vi } from "vitest";
import { renderMarkdown } from "../src/report/markdown.js";
import { reverseEngineer } from "../src/index.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/mcp.js";
const mocks=vi.hoisted(()=>({research:vi.fn(),check:vi.fn()}));
vi.mock("../src/keywords/index.js",()=>({researchKeywords:mocks.research,checkKeywordAccess:mocks.check}));
vi.mock("../src/sources/website.js",()=>({collectWebsite:async()=>{}}));
vi.mock("../src/sources/scrapecreators.js",()=>({scrapeCreatorsFromEnv:()=>null}));
const result={provider:"google_ads_api",customerId:"1234567890",currencyCode:"PLN",languageId:"1030",geoTargetIds:["2616"],network:"GOOGLE_SEARCH",fetchedAt:"2026-11-15T00:00:00.000Z",cacheHit:false,truncated:false,keywords:[{text:"CRM",avgMonthlySearches:"100",lowTopOfPageBidMicros:"1000000",highTopOfPageBidMicros:"5000000",averageCpcMicros:null}],limitations:["Market ideas, not competitor settings or costs"]};
beforeEach(()=>{mocks.research.mockReset();mocks.check.mockReset();});
it("adds optional keyword research as separately labelled evidence without affecting Google activity",async()=>{
  mocks.research.mockResolvedValue(result);
  const bundle=await reverseEngineer("example.com",{only:["website"],keywordResearch:{keywords:["CRM"],limit:20}} as any);
  expect(mocks.research).toHaveBeenCalledWith(expect.objectContaining({keywords:["CRM"],url:"https://example.com",limit:20}));
  expect(bundle.evidence).toContainEqual(expect.objectContaining({source:"keyword_research",data:result}));
  expect(bundle.evidence.some(e=>e.source==="google_ads")).toBe(false);
  const markdown=renderMarkdown(bundle);
  expect(markdown).toContain("## Keyword market research");
  expect(markdown).toContain("avgMonthlySearches");
  expect(markdown).toContain("Market ideas, not competitor settings or costs");
  expect(bundle.scorecard.find(c=>c.channel==="paid_google")?.status).toBe("unknown");
});
it("does not call keyword planning by default and marks failed explicit research Unknown safely",async()=>{
  await reverseEngineer("example.com",{only:["website"]});expect(mocks.research).not.toHaveBeenCalled();
  mocks.research.mockRejectedValue(new Error("SECRET /private/credentials.json"));
  const bundle=await reverseEngineer("example.com",{only:["website"],keywordResearch:{keywords:["CRM"]}} as any);
  expect(bundle.evidence.some(e=>(e.source as string)==="keyword_research")).toBe(false);
  expect(bundle.unknowns).toContainEqual(expect.objectContaining({channel:"keyword_research",reason:expect.stringContaining("keywords-check")}));
  expect(JSON.stringify(bundle)).not.toMatch(/SECRET|private\/credentials/);
});
it("exposes direct research and actual access checks over MCP",async()=>{
  mocks.research.mockResolvedValue(result);mocks.check.mockResolvedValue({available:false,code:"DEVELOPER_TOKEN_NOT_APPROVED",customerId:"1234567890",checkedAt:new Date().toISOString()});
  const server=createServer(),client=new Client({name:"keyword-test",version:"1"});
  const[a,b]=InMemoryTransport.createLinkedPair();await server.connect(a);await client.connect(b);
  try{
    const names=(await client.listTools()).tools.map(t=>t.name);
    expect(names).toContain("research_keywords");expect(names).toContain("check_keyword_access");
    const response=await client.callTool({name:"research_keywords",arguments:{keywords:["CRM"],language_id:"1030",geo_target_ids:["2616"],limit:20}});
    expect(response.isError).not.toBe(true);
    expect(mocks.research).toHaveBeenCalledWith(expect.objectContaining({keywords:["CRM"],languageId:"1030",geoTargetIds:["2616"],limit:20}));
    await client.callTool({name:"check_keyword_access",arguments:{customer_id:"1234567890"}});
    expect(mocks.check).toHaveBeenCalledWith(expect.objectContaining({customerId:"1234567890"}));
  }finally{await client.close();await server.close();}
});
