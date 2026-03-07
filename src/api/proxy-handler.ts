import {
  type IncomingMessage,
  request as httpRequest,
  type ServerResponse,
} from "node:http";
import { request as httpsRequest } from "node:https";
import {
  cfProxyUrl,
  httpProxyAuth,
  httpProxyHost,
  httpProxyPort,
  resolveProxyRuleByHostname,
} from "../config.js";
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

function buildUpstreamUpgradeRequest(
  clientReq: IncomingMessage,
  requestTarget: string,
  hostHeader: string,
): string {
  const headers = { ...clientReq.headers };
  delete headers["proxy-connection"];
  delete headers["proxy-authenticate"];
  delete headers["proxy-authorization"];
  headers.host = hostHeader;

  const lines = [
    `${clientReq.method ?? "GET"} ${requestTarget} HTTP/${clientReq.httpVersion}`,
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

function buildCfProxyWebSocketUrl(targetUrl: URL, cfProxy: URL): URL {
  const cfProxyPath = cfProxy.pathname.endsWith("/")
    ? cfProxy.pathname
    : `${cfProxy.pathname}/`;

  const mappedScheme = targetUrl.protocol === "wss:" ? "https://" : "http://";
  const mappedTarget = `${mappedScheme}${targetUrl.host}${targetUrl.pathname}${targetUrl.search}`;

  const upstreamProtocol =
    cfProxy.protocol === "https:" ? "wss:" : cfProxy.protocol === "http:" ? "ws:" : cfProxy.protocol;

  return new URL(`${upstreamProtocol}//${cfProxy.host}${cfProxyPath}${mappedTarget}`);
}

function buildProxyAuthorizationHeader(auth: string | undefined): string | undefined {
  if (!auth) {
    return undefined;
  }
  return `Basic ${Buffer.from(auth, "utf8").toString("base64")}`;
}

function getTerminalWidth(): number {
  return typeof process.stdout.columns === "number" && process.stdout.columns > 0
    ? process.stdout.columns
    : 120;
}

function formatProxyLogLine(ruleText: string, url: string): string {
  const prefix = `[PORXY] ${ruleText} `;
  const maxWidth = getTerminalWidth();
  const remaining = maxWidth - prefix.length;
  if (remaining <= 0) {
    return prefix.slice(0, maxWidth);
  }

  return `${prefix}${url.slice(0, remaining)}`;
}

function readHttpProxyConnectResponse(
  proxySocket: Socket,
  onResult: (statusCode: number, rest: Buffer) => void,
  onError: (error: Error) => void,
): void {
  const chunks: Buffer[] = [];

  const onData = (chunk: Buffer) => {
    chunks.push(chunk);
    const merged = Buffer.concat(chunks);
    const headerEnd = merged.indexOf("\r\n\r\n");
    if (headerEnd < 0) {
      return;
    }

    proxySocket.off("data", onData);
    proxySocket.off("error", onSocketError);

    const headerText = merged.subarray(0, headerEnd).toString("ascii");
    const firstLine = headerText.split("\r\n", 1)[0] ?? "";
    const match = /^HTTP\/\d\.\d\s+(\d{3})\b/.exec(firstLine);
    if (!match) {
      onError(new Error(`invalid proxy CONNECT response: ${firstLine}`));
      return;
    }

    const rest = merged.subarray(headerEnd + 4);
    onResult(Number(match[1]), rest);
  };

  const onSocketError = (error: Error) => {
    proxySocket.off("data", onData);
    proxySocket.off("error", onSocketError);
    onError(error);
  };

  proxySocket.on("data", onData);
  proxySocket.once("error", onSocketError);
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

  const { action: proxyAction, ruleText } = resolveProxyRuleByHostname(targetUrl.hostname);
  if (proxyAction === "REJECT") {
    clientRes.writeHead(403, { "Content-Type": "text/plain" });
    clientRes.end("Blocked by proxy rule");
    return;
  }

  let upstreamUrl: URL = targetUrl;
  let shouldUseHttpProxy = false;
  let cfProxyBasePath = "";
  let shouldRewriteCfLocation = false;

  let matchedCfProxyUrl: URL | undefined;
  if (proxyAction === "cfProxy" && cfProxyUrl) {
    const proxyBasePath = cfProxyUrl.pathname.endsWith("/")
      ? cfProxyUrl.pathname
      : `${cfProxyUrl.pathname}/`;
    const proxyUrl = `${cfProxyUrl.origin}${proxyBasePath}${targetUrl.href}`;
    upstreamUrl = new URL(proxyUrl);
    matchedCfProxyUrl = cfProxyUrl;
    cfProxyBasePath = proxyBasePath;
    shouldRewriteCfLocation = true;
  } else if (proxyAction === "httpProxy") {
    shouldUseHttpProxy = !!httpProxyHost && !!httpProxyPort;
  }

  if (proxyAction === "cfProxy" && !cfProxyUrl) {
    console.warn("[proxy] cfProxy rule matched but cfProxy is not configured, fallback to DIRECT");
  }

  if (proxyAction === "httpProxy" && !shouldUseHttpProxy) {
    console.warn("[proxy] httpProxy rule matched but httpProxy is not configured, fallback to DIRECT");
  }

  const upstreamHeaders = { ...headers, host: upstreamUrl.host };
  const proxyAuthorization = buildProxyAuthorizationHeader(httpProxyAuth);
  if (proxyAuthorization && shouldUseHttpProxy) {
    upstreamHeaders["proxy-authorization"] = proxyAuthorization;
  }

  console.log(formatProxyLogLine(ruleText, targetUrl.href));
  const upstreamRequest = shouldUseHttpProxy
    ? httpRequest(
        {
          hostname: httpProxyHost,
          port: Number(httpProxyPort),
          method,
          path: upstreamUrl.href,
          headers: upstreamHeaders,
        },
        (upstreamResponse) => {
          const responseHeaders = { ...upstreamResponse.headers };
          const locationHeader = upstreamResponse.headers.location;
          if (shouldRewriteCfLocation && matchedCfProxyUrl && typeof locationHeader === "string") {
            responseHeaders.location = rewriteCfProxyLocation(
              locationHeader,
              matchedCfProxyUrl,
              cfProxyBasePath,
            );
          }

          clientRes.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders);
          upstreamResponse.pipe(clientRes);
        },
      )
    : (upstreamUrl.protocol === "https:" ? httpsRequest : httpRequest)(
        {
          protocol: upstreamUrl.protocol,
          hostname: upstreamUrl.hostname,
          port: upstreamUrl.port || undefined,
          method,
          path: `${upstreamUrl.pathname}${upstreamUrl.search}`,
          headers: upstreamHeaders,
        },
        (upstreamResponse) => {
          const responseHeaders = { ...upstreamResponse.headers };
          const locationHeader = upstreamResponse.headers.location;
          if (shouldRewriteCfLocation && matchedCfProxyUrl && typeof locationHeader === "string") {
            responseHeaders.location = rewriteCfProxyLocation(
              locationHeader,
              matchedCfProxyUrl,
              cfProxyBasePath,
            );
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

  const { action: proxyAction, ruleText } = resolveProxyRuleByHostname(targetUrl.hostname);
  if (proxyAction === "REJECT") {
    writeHttpError(clientSocket, 403, "Forbidden");
    return;
  }

  let effectiveTargetUrl = targetUrl;
  let shouldUseHttpProxy = false;
  if (proxyAction === "cfProxy" && cfProxyUrl) {
    effectiveTargetUrl = buildCfProxyWebSocketUrl(targetUrl, cfProxyUrl);
  } else if (proxyAction === "httpProxy") {
    shouldUseHttpProxy = !!httpProxyHost && !!httpProxyPort;
  }

  if (proxyAction === "cfProxy" && !cfProxyUrl) {
    console.warn("[proxy] cfProxy rule matched for websocket but cfProxy is not configured, fallback to DIRECT");
  }

  if (proxyAction === "httpProxy" && !shouldUseHttpProxy) {
    console.warn("[proxy] httpProxy rule matched for websocket but httpProxy is not configured, fallback to DIRECT");
  }

  const isSecureTarget =
    effectiveTargetUrl.protocol === "wss:" ||
    effectiveTargetUrl.protocol === "https:";
  const targetPort = Number(
    effectiveTargetUrl.port || (isSecureTarget ? "443" : "80"),
  );
  const proxyAuthorization = buildProxyAuthorizationHeader(httpProxyAuth);
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

  console.log(formatProxyLogLine(ruleText, targetUrl.href));

  const attachUpgradeTunnel = (
    upstreamSocket: Socket | TLSSocket,
    alreadyConnected: boolean,
  ) => {
    upstreamSocket.once("error", onUpstreamError);

    const onReady = () => {
      upstreamSocket.off("error", onUpstreamError);
      console.log(`[proxy] websocket ${targetUrl.protocol}//${targetUrl.host}`);

      upstreamSocket.write(
        buildUpstreamUpgradeRequest(
          clientReq,
          `${effectiveTargetUrl.pathname}${effectiveTargetUrl.search}`,
          effectiveTargetUrl.host,
        ),
      );
      if (head.length > 0) {
        upstreamSocket.write(head);
      }

      clientSocket.pipe(upstreamSocket);
      upstreamSocket.pipe(clientSocket);
    };

    if (isSecureTarget) {
      upstreamSocket.once("secureConnect", onReady);
    } else if (alreadyConnected) {
      onReady();
    } else {
      upstreamSocket.once("connect", onReady);
    }
  };

  if (!shouldUseHttpProxy) {
    const directUpstreamSocket: Socket | TLSSocket = isSecureTarget
      ? connectTlsSocket({
          host: effectiveTargetUrl.hostname,
          port: targetPort,
          servername: effectiveTargetUrl.hostname,
        })
      : connectSocket({
          host: effectiveTargetUrl.hostname,
          port: targetPort,
        });

    attachUpgradeTunnel(directUpstreamSocket, false);
  } else {
    const proxySocket = connectSocket({
      host: httpProxyHost,
      port: Number(httpProxyPort),
    });

    proxySocket.once("error", onUpstreamError);
    proxySocket.once("connect", () => {
      const connectHeaders = [
        `CONNECT ${effectiveTargetUrl.host} HTTP/1.1`,
        `Host: ${effectiveTargetUrl.host}`,
      ];
      if (proxyAuthorization) {
        connectHeaders.push(`Proxy-Authorization: ${proxyAuthorization}`);
      }
      connectHeaders.push("", "");
      proxySocket.write(connectHeaders.join("\r\n"));

      readHttpProxyConnectResponse(
        proxySocket,
        (statusCode, rest) => {
          if (statusCode !== 200) {
            onUpstreamError(new Error(`proxy CONNECT failed with status ${statusCode}`));
            return;
          }

          if (rest.length > 0) {
            proxySocket.unshift(rest);
          }

          if (isSecureTarget) {
            const tlsTunnelSocket = connectTlsSocket({
              socket: proxySocket,
              servername: effectiveTargetUrl.hostname,
            });
            attachUpgradeTunnel(tlsTunnelSocket, false);
            return;
          }

          attachUpgradeTunnel(proxySocket, true);
        },
        onUpstreamError,
      );
    });
  }

  clientSocket.on("error", (error) => {
    console.error("[proxy] client websocket socket failed", error);
  });
}
