import {
  type IncomingMessage,
  request as httpRequest,
  type ServerResponse,
} from "node:http";
import { request as httpsRequest } from "node:https";

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
  defaultProtocol: "http:" | "https:",
): URL | null {
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
  return new URL(`${defaultProtocol}//${host}${normalizedPath}`);
}

export function handleProxyRequest(clientReq: IncomingMessage, clientRes: ServerResponse): void {
  const method = clientReq.method ?? "GET";
  const rawUrl = clientReq.url ?? "";
  console.log(`[proxy] ${method} ${rawUrl}`);

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
}
