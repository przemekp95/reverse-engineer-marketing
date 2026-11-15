import { expect, it, vi } from "vitest";
import { request, type Server } from "node:http";
import { startWeb } from "../src/web/server.js";
import { reverseEngineer } from "../src/index.js";
const mocks = vi.hoisted(() => ({ server: undefined as Server | undefined }));
vi.mock("node:http", async importOriginal => {
  const original = await importOriginal<typeof import("node:http")>();
  return { ...original, createServer: (...args: any[]) => { mocks.server = (original.createServer as any)(...args); return mocks.server; } };
});
vi.mock("../src/index.js", async importOriginal => ({ ...(await importOriginal<object>()), reverseEngineer: vi.fn() }));
vi.mock("../src/runs.js", () => ({ saveRun: async () => ({ id: "test-run", path: "test-run.json" }) }));
vi.mock("../src/report/markdown.js", () => ({ renderMarkdown: () => "# Example" }));
it("forwards per-target Google identities over local HTTP and retains the origin guard", async () => {
  const logicalUrl = await startWeb(0);
  const address = mocks.server!.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP server");
  const url = `http://127.0.0.1:${address.port}`;
  // Port 0 selects an ephemeral socket; use the Host advertised by startWeb for its guard.
  const headers = { host: new URL(logicalUrl).host, "content-type": "application/json" };
  vi.mocked(reverseEngineer).mockResolvedValue({ brand: "Example", target: { input: "example.com" }, scorecard: [], evidence: [], unknowns: [], credits: { scrapecreators: null }, harness: { version: "test", sha: "test" } } as any);
  const body = JSON.stringify({ url: "example.com", engine: "none", googleAdvertiserIds: ["AR01847332847816278017"] });
  const send = (headers: Record<string, string>) => new Promise<{ status: number }>((resolve, reject) => {
    const req = request(`${url}/api/runs`, { method: "POST", headers }, res => { res.resume(); res.on("end", () => resolve({ status: res.statusCode! })); });
    req.on("error", reject); req.end(body);
  });
  try {
    const rejected = await send({ ...headers, origin: "https://foreign.example" });
    expect(rejected.status).toBe(403);
    expect(reverseEngineer).not.toHaveBeenCalled();
    const response = await send(headers);
    expect(response.status).toBe(200);
    expect(reverseEngineer).toHaveBeenCalledWith("example.com", expect.objectContaining({ googleAdvertiserIds: ["AR01847332847816278017"] }));
  } finally {
    mocks.server!.closeAllConnections();
    await new Promise<void>((resolve, reject) => mocks.server!.close(err => err ? reject(err) : resolve()));
  }
});
