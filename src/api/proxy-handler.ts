import {
  type IncomingMessage,
  request as httpRequest,
  type ServerResponse,
} from "node:http";
import { request as httpsRequest } from "node:https";
import { cfProxyUrl } from "../config.js";
import { connect as connectSocket, type Socket } from "node:net";
import { connect as connectTlsSocket, type TLSSocket } from "node:tls";

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

function buildTargetUrl(
  url: string | undefined,
  host: string | undefined,
  defaultProtocol: "http:" | "https:" | "ws:" | "wss:",
): URL | null {
  if (!url) {
    return null;
  }

  if (
    url.startsWith("http://") ||
    url.startsWith("https://") ||
    url.startsWith("ws://") ||
    url.startsWith("wss://")
  ) {
    return new URL(url);
  }

  if (!host) {
    return null;
  }

  const normalizedPath = url.startsWith("/") ? url : `/${url}`;
  return new URL(`${defaultProtocol}//${host}${normalizedPath}`);
}

function writeHttpError(socket: Socket, statusCode: number, message: string): void {
  socket.write(`HTTP/1.1 ${statusCode} ${message}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

function serializeHeaderValue(headerValue: string | string[]): string {
  return Array.isArray(headerValue) ? headerValue.join(", ") : headerValue;
}

function buildUpstreamUpgradeRequest(clientReq: IncomingMessage, targetUrl: URL): string {
  const headers = { ...clientReq.headers };
  delete headers["proxy-connection"];
  delete headers["proxy-authenticate"];
  delete headers["proxy-authorization"];
  headers.host = targetUrl.host;

  const lines = [
    `${clientReq.method ?? "GET"} ${targetUrl.pathname}${targetUrl.search} HTTP/${clientReq.httpVersion}`,
  ];

  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) {
      continue;
    }
    lines.push(`${name}: ${serializeHeaderValue(value)}`);
  }

  lines.push("", "");
  return lines.join("\r\n");
}

function rewriteCfProxyLocation(location: string, cfProxy: URL, proxyBasePath: string): string {
  const directPrefix = `${cfProxy.origin}${proxyBasePath}`;
  if (location.startsWith(directPrefix)) {
    const restored = location.slice(directPrefix.length);
    if (restored.startsWith("http://") || restored.startsWith("https://")) {
      return restored;
    }
  }

  const fallbackPrefix = `${cfProxy.origin}/`;
  if (location.startsWith(fallbackPrefix)) {
    const restored = location.slice(fallbackPrefix.length);
    if (restored.startsWith("http://") || restored.startsWith("https://")) {
      return restored;
    }
  }

  return location;
}

export function handleProxyRequest(clientReq: IncomingMessage, clientRes: ServerResponse): void {
  const method = clientReq.method ?? "GET";
  const rawUrl = clientReq.url ?? "";

  const defaultProtocol: "http:" | "https:" =
    "encrypted" in clientReq.socket && clientReq.socket.encrypted ? "https:" : "http:";

  const targetUrl = buildTargetUrl(rawUrl, clientReq.headers.host, defaultProtocol);
  if (!targetUrl) {
    clientRes.writeHead(400, { "Content-Type": "text/plain" });
    clientRes.end("Invalid proxy request URL");
    return;
  }

  const headers = { ...clientReq.headers };
  for (const headerName of hopByHopHeaders) {
    delete headers[headerName];
  }

  // Worker/反代风格：直接拼接目标URL
  if (cfProxyUrl) {
    const proxyHeaders = { ...headers };
    // Keep Host/SNI aligned with cfProxy origin, otherwise TLS handshake can fail.
    proxyHeaders.host = cfProxyUrl.host;
    const proxyBasePath = cfProxyUrl.pathname.endsWith("/")
      ? cfProxyUrl.pathname
      : `${cfProxyUrl.pathname}/`;
    const proxyUrl = `${cfProxyUrl.origin}${proxyBasePath}${targetUrl.href}`;
    console.log(`[proxy] ${proxyUrl}`);
    const isHttpsProxy = cfProxyUrl.protocol === "https:";
    const request = isHttpsProxy ? httpsRequest : httpRequest;
    const upstreamRequest = request(
      proxyUrl,
      {
        method,
        headers: proxyHeaders,
      },
      (upstreamResponse) => {
        const responseHeaders = { ...upstreamResponse.headers };
        const locationHeader = upstreamResponse.headers.location;
        if (typeof locationHeader === "string") {
          responseHeaders.location = rewriteCfProxyLocation(locationHeader, cfProxyUrl, proxyBasePath);
        }

        clientRes.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders);
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
    return;
  }

  // 原有直连逻辑
  headers.host = targetUrl.host;
  console.log(`[proxy] ${targetUrl.href}`);
  const request = targetUrl.protocol === "https:" ? httpsRequest : httpRequest;
  const upstreamRequest = request(
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
}

export function handleProxyUpgrade(clientReq: IncomingMessage, clientSocket: Socket, head: Buffer): void {
  const rawUrl = clientReq.url ?? "";
  const defaultProtocol: "ws:" | "wss:" =
    "encrypted" in clientReq.socket && clientReq.socket.encrypted ? "wss:" : "ws:";

  const targetUrl = buildTargetUrl(rawUrl, clientReq.headers.host, defaultProtocol);
  if (!targetUrl) {
    writeHttpError(clientSocket, 400, "Bad Request");
    return;
  }

  const isSecureTarget = targetUrl.protocol === "wss:" || targetUrl.protocol === "https:";
  const targetPort = Number(
    targetUrl.port || (isSecureTarget ? "443" : "80"),
  );
  if (!Number.isFinite(targetPort) || targetPort <= 0) {
    writeHttpError(clientSocket, 400, "Bad Request");
    return;
  }

  const onUpstreamError = (error: Error) => {
    console.error("[proxy] upstream websocket tunnel failed", error);
    if (!clientSocket.destroyed) {
      writeHttpError(clientSocket, 502, "Bad Gateway");
    }
  };

  console.log(`[proxy] ${targetUrl.href}`);
  const upstreamSocket: Socket | TLSSocket = isSecureTarget
    ? connectTlsSocket({
        host: targetUrl.hostname,
        port: targetPort,
        servername: targetUrl.hostname,
      })
    : connectSocket({
        host: targetUrl.hostname,
        port: targetPort,
      });

  upstreamSocket.once("error", onUpstreamError);

  upstreamSocket.once(isSecureTarget ? "secureConnect" : "connect", () => {
    upstreamSocket.off("error", onUpstreamError);
    console.log(`[proxy] websocket ${targetUrl.protocol}//${targetUrl.host}`);

    upstreamSocket.write(buildUpstreamUpgradeRequest(clientReq, targetUrl));
    if (head.length > 0) {
      upstreamSocket.write(head);
    }

    clientSocket.pipe(upstreamSocket);
    upstreamSocket.pipe(clientSocket);
  });

  clientSocket.on("error", (error) => {
    console.error("[proxy] client websocket socket failed", error);
    if (!upstreamSocket.destroyed) {
      upstreamSocket.destroy();
    }
  });
}
