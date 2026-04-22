/**
 * Fake bridge for the `woid-skills` test.
 *
 * Stands up a tiny HTTP server at localhost:4455 that accepts the three
 * skill calls a woid-sandbox character would emit (post / move / state).
 * Each endpoint returns a JSON payload whose `"kind"` field the progress
 * detectors key on.
 *
 * Since DockerBashOperations runs containers with --network host, the
 * agent's curl calls to localhost:4455 reach this server directly.
 */
import http from "node:http";

export interface WoidBridgeRecord {
  ts: number;
  kind: "post" | "move" | "state";
  body: unknown;
}

export interface WoidBridge {
  port: number;
  records: WoidBridgeRecord[];
  close(): void;
}

export function startWoidBridge(port = 4455): Promise<WoidBridge> {
  const records: WoidBridgeRecord[] = [];

  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString("utf-8");
    let body: unknown;
    try { body = raw ? JSON.parse(raw) : null; } catch { body = { raw }; }

    const url = req.url || "";
    let kind: "post" | "move" | "state" | null = null;
    if (url === "/internal/post") kind = "post";
    else if (url === "/internal/move") kind = "move";
    else if (url === "/internal/state") kind = "state";

    if (!kind) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "unknown route" }));
      return;
    }

    records.push({ ts: Date.now(), kind, body });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, kind, seq: records.length, received: body }));
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "0.0.0.0", () => {
      resolve({
        port,
        records,
        close: () => server.close(),
      });
    });
  });
}
