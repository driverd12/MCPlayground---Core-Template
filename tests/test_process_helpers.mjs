import http from "node:http";

const DEFAULT_HTTP_TIMEOUT_MS = 15_000;
const DEFAULT_CHILD_SHUTDOWN_TIMEOUT_MS = 5_000;

export async function reservePort() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to reserve port");
  }
  const { port } = address;
  await closeHttpServer(server);
  return port;
}

export async function closeHttpServer(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

export async function stopChildProcess(
  child,
  {
    signal = "SIGTERM",
    forceSignal = "SIGKILL",
    timeoutMs = DEFAULT_CHILD_SHUTDOWN_TIMEOUT_MS,
  } = {}
) {
  if (!child) {
    return;
  }
  if (child.exitCode !== null || child.signalCode !== null) {
    destroyChildStreams(child);
    return;
  }

  const exitPromise = new Promise((resolve) => {
    child.once("exit", () => resolve());
  });

  try {
    child.kill(signal);
  } catch {}

  const exitedGracefully = await Promise.race([
    exitPromise.then(() => true),
    delay(timeoutMs).then(() => false),
  ]);

  if (!exitedGracefully && child.exitCode === null && child.signalCode === null) {
    try {
      child.kill(forceSignal);
    } catch {}
    await Promise.race([exitPromise, delay(1_000)]);
  }

  destroyChildStreams(child);
}

export function fetchHttpText(url, headers = {}, options = {}) {
  return fetchHttp(url, {
    method: "GET",
    headers,
    timeoutMs: options.timeoutMs,
  }).then((response) => {
    if (response.statusCode >= 400) {
      throw new Error(`${response.statusCode} ${response.body}`);
    }
    return response.body;
  });
}

export function fetchHttpResponse(url, headers = {}, options = {}) {
  return fetchHttp(url, {
    method: "GET",
    headers,
    timeoutMs: options.timeoutMs,
  });
}

export function postHttpJson(url, body, headers = {}, options = {}) {
  return fetchHttp(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
    timeoutMs: options.timeoutMs,
  });
}

async function fetchHttp(
  url,
  {
    method = "GET",
    headers = {},
    body = null,
    timeoutMs = DEFAULT_HTTP_TIMEOUT_MS,
  } = {}
) {
  const parsed = new URL(url);
  return await new Promise((resolve, reject) => {
    const request = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method,
        headers: body
          ? {
              "Content-Length": Buffer.byteLength(body),
              ...headers,
            }
          : headers,
        agent: false,
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("end", () => {
          resolve({
            statusCode: response.statusCode ?? 500,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
        response.on("error", reject);
      }
    );

    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error(`HTTP request timed out after ${timeoutMs}ms: ${method} ${url}`));
    });
    request.on("error", reject);

    if (body) {
      request.write(body);
    }
    request.end();
  });
}

function destroyChildStreams(child) {
  child.stdin?.destroy();
  child.stdout?.destroy();
  child.stderr?.destroy();
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
