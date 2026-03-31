import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { probeLocalMlxBackend } from "../dist/local_mlx_backend_probe.js";

test("probeLocalMlxBackend measures real service and benchmark data", async () => {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }
    if (req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          object: "list",
          data: [{ id: "mlx-community/Qwen2.5-Coder-3B-Instruct-4bit" }],
        })
      );
      return;
    }
    if (req.url === "/v1/chat/completions") {
      let body = "";
      req.on("data", (chunk) => {
        body += String(chunk);
      });
      req.on("end", () => {
        const payload = JSON.parse(body);
        assert.equal(payload.model, "mlx-community/Qwen2.5-Coder-3B-Instruct-4bit");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: "chatcmpl-test",
            object: "chat.completion",
            choices: [{ message: { role: "assistant", content: "ready" } }],
            usage: { completion_tokens: 4 },
          })
        );
      });
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const endpoint = `http://127.0.0.1:${address.port}`;

  try {
    const result = await probeLocalMlxBackend({
      endpoint,
      model_id: "mlx-community/Qwen2.5-Coder-3B-Instruct-4bit",
      benchmark: true,
    });
    assert.equal(result.service_ok, true);
    assert.equal(result.health_ok, true);
    assert.equal(result.model_known, true);
    assert.equal(result.benchmark_ok, true);
    assert.equal(result.benchmark_attempted, true);
    assert.ok(result.benchmark_latency_ms !== null);
    assert.ok(result.benchmark_completion_tokens === 4);
    assert.ok(result.throughput_tps !== null);
    assert.deepEqual(requests, ["/health", "/v1/models", "/v1/chat/completions"]);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
