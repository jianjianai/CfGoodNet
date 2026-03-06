import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { connect as netConnect } from "node:net";

const hopByHopHeaders = [
  "connection",
  "proxy-connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
] as const;

function buildTargetUrl(url: string | undefined, host: string | undefined): URL | null  {
  if (!url) {
    return null;
  }

  if (url.startsWith("http://") || url.startsWith("https://")) {
    return new URL(url);
  }

  if (!host) {
    return null;
  }

  const normalizedPath = url.startsWith("/") ? url : `/${url}`;
  return new URL(`http://${host}${normalizedPath}`);
};

function parseConnectTarget(authority: string | undefined): { host: string; port: number } | null {
  if (!authority) {
    return null;
  }

  const separatorIndex = authority.lastIndexOf(":");
  if (separatorIndex <= 0) {
    return { host: authority, port: 443 };
  }

  const host = authority.slice(0, separatorIndex);
  const portText = authority.slice(separatorIndex + 1);
  const port = Number(portText);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    return null;
  }

  return { host, port };
};

function handleProxyRequest(clientReq, clientRes) {
  const method = clientReq.method ?? "GET";
  const rawUrl = clientReq.url ?? "";
  console.log(`[proxy] ${method} ${rawUrl}`);

  const targetUrl = buildTargetUrl(rawUrl, clientReq.headers.host);
  if (!targetUrl) {
    clientRes.writeHead(400, { "Content-Type": "text/plain" });
    clientRes.end("Invalid proxy request URL");
    return;
  }

  const headers = { ...clientReq.headers };
  for (const headerName of hopByHopHeaders) {
    delete headers[headerName];
  }
  headers.host = targetUrl.host;

  const upstreamRequest = (targetUrl.protocol === "https:" ? httpsRequest : httpRequest)(
    {
      protocol: targetUrl.protocol,
      hostname: targetUrl.hostname,
      port: targetUrl.port || undefined,
      method,
      path: `${targetUrl.pathname}${targetUrl.search}`,
      headers,
    },
    (upstreamResponse) => {
      clientRes.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.pipe(clientRes);
    },
  );

  upstreamRequest.on("error", (error) => {
    console.error("[proxy] upstream http request failed", error);
    if (!clientRes.headersSent) {
      clientRes.writeHead(502, { "Content-Type": "text/plain" });
    }
    clientRes.end("Bad Gateway");
  });

  clientReq.pipe(upstreamRequest);
};

export const server = createServer(handleProxyRequest);

server.on("connect", (req, clientSocket, head) => {
  const target = parseConnectTarget(req.url);
  console.log(`[proxy] CONNECT ${req.url ?? ""}`);

  if (!target) {
    clientSocket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
    clientSocket.destroy();
    return;
  }

  const upstreamSocket = netConnect(target.port, target.host, () => {
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length > 0) {
      upstreamSocket.write(head);
    }
    upstreamSocket.pipe(clientSocket);
    clientSocket.pipe(upstreamSocket);
  });

  upstreamSocket.on("error", (error) => {
    console.error("[proxy] connect tunnel failed", error);
    if (!clientSocket.destroyed) {
      clientSocket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      clientSocket.destroy();
    }
  });

  clientSocket.on("error", () => {
    upstreamSocket.destroy();
  });
});
