import { expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/mcp.js";
import { reverseEngineer } from "../src/index.js";
vi.mock("../src/index.js", async importOriginal => ({ ...(await importOriginal<object>()), reverseEngineer: vi.fn() }));
vi.mock("../src/runs.js", () => ({ saveRun: async () => ({ id: "test-run", path: "test-run.json" }) }));
it("accepts selected Google identities over MCP and forwards them to the pipeline", async () => {
  const server = createServer();
  const client = new Client({ name: "test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b);
  try {
    const tools = await client.listTools();
    const tool = tools.tools.find(t => t.name === "reverse_engineer_marketing")!;
    expect(tool.inputSchema.properties).toHaveProperty("google_advertiser_ids");
    vi.mocked(reverseEngineer).mockResolvedValue({ brand: "Example", evidence: [], unknowns: [], content: [], credits: { scrapecreators: null }, harness: { version: "test", sha: "test" }, scorecard: [] } as any);
    await client.callTool({ name: tool.name, arguments: { url: "example.com", only: ["paid"], google_advertiser_ids: ["AR01847332847816278017"] } });
    expect(reverseEngineer).toHaveBeenCalledWith("example.com", expect.objectContaining({ googleAdvertiserIds: ["AR01847332847816278017"] }));
  } finally { await client.close(); await server.close(); }
});
