import http from "node:http";
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { logEvent } from "../utils.js";

export type HttpOptions = {
  port: number;
  host: string;
  allowedOrigins: string[];
  bearerToken: string | null;
};

type SessionBinding = {
  server: Server;
  transport: StreamableHTTPServerTransport;
};

export async function startHttpTransport(createServer: () => Server, options: HttpOptions) {
  if (options.host !== "127.0.0.1" && options.host !== "localhost") {
    throw new Error("HTTP transport must bind to 127.0.0.1 or localhost");
  }
  if (!options.bearerToken) {
    throw new Error("MCP_HTTP_BEARER_TOKEN is required for HTTP transport");
  }

  const sessions = new Map<string, SessionBinding>();

  const httpServer = http.createServer((req, res) => {
    if (!validateOrigin(req.headers.origin, options.allowedOrigins)) {
      res.statusCode = 403;
      res.end("Forbidden");
      return;
    }

    if (!validateBearer(req.headers.authorization, options.bearerToken)) {
      res.statusCode = 403;
      res.end("Forbidden");
      return;
    }

    void routeRequest(createServer, sessions, req, res).catch((error) => {
      logEvent("http.error", {
        error: String(error),
        method: req.method ?? "unknown",
        url: req.url ?? "",
      });
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end("Internal Server Error");
      }
    });
  });

  await new Promise<void>((resolve) => {
    httpServer.listen(options.port, options.host, () => resolve());
  });

  logEvent("http.listen", { host: options.host, port: options.port });
}

function validateOrigin(origin: string | undefined, allowed: string[]) {
  if (!origin) {
    return false;
  }
  return allowed.includes(origin);
}

function validateBearer(authorization: string | undefined, expected: string | null) {
  if (!expected) {
    return false;
  }
  if (!authorization) {
    return false;
  }
  const [scheme, token] = authorization.split(" ");
  return scheme === "Bearer" && token === expected;
}

async function routeRequest(
  createServer: () => Server,
  sessions: Map<string, SessionBinding>,
  req: http.IncomingMessage,
  res: http.ServerResponse
) {
  const method = String(req.method ?? "GET").toUpperCase();
  const sessionHeader = req.headers["mcp-session-id"];
  const sessionId = Array.isArray(sessionHeader) ? sessionHeader[0] : sessionHeader;

  if (method === "POST") {
    const body = await parseJsonBody(req);
    let transport: StreamableHTTPServerTransport | undefined;
    let server: Server | undefined;

    if (sessionId) {
      const session = sessions.get(sessionId);
      if (!session) {
        res.statusCode = 404;
        res.end("Unknown MCP session");
        return;
      }
      transport = session.transport;
      server = session.server;
    } else if (isInitializeRequest(body)) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (newSessionId) => {
          sessions.set(newSessionId, {
            server: server!,
            transport: transport!,
          });
        },
      });
      transport.onclose = () => {
        const sid = transport?.sessionId;
        if (sid) {
          sessions.delete(sid);
        }
      };
      server = createServer();
      await server.connect(transport);
    } else {
      res.statusCode = 400;
      res.end("Missing MCP session id or initialize payload");
      return;
    }

    await transport.handleRequest(req, res, body);
    return;
  }

  if (method === "GET" || method === "DELETE") {
    if (!sessionId) {
      res.statusCode = 400;
      res.end("Missing MCP session id");
      return;
    }
    const session = sessions.get(sessionId);
    if (!session) {
      res.statusCode = 404;
      res.end("Unknown MCP session");
      return;
    }
    await session.transport.handleRequest(req, res);
    return;
  }

  res.statusCode = 405;
  res.end("Method Not Allowed");
}

async function parseJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) {
    return undefined;
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    return undefined;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}
