import {
  type IncomingMessage,
  request as httpRequest,
  type ServerResponse,
} from "node:http";
import { request as httpsRequest } from "node:https";
import {
  getCfGoodResolvedIp,
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

/**
 * 解析客户端请求中的目标地址，支持绝对 URL 和相对路径两种代理请求形式。
 * @param url 客户端请求中的 URL 字段。
 * @param host 客户端请求头中的 Host。
 * @param defaultProtocol 当 URL 为相对路径时使用的默认协议。
 * @returns 成功返回标准化后的目标 URL；失败返回 null。
 */
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

/**
 * 向客户端 socket 写回 HTTP 错误并主动关闭连接。
 * @param socket 客户端套接字。
 * @param statusCode HTTP 状态码。
 * @param message HTTP 状态文本。
 * @returns 无返回值。
 */
function writeHttpError(socket: Socket, statusCode: number, message: string): void {
  socket.write(`HTTP/1.1 ${statusCode} ${message}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

/**
 * 将 header 值统一序列化为字符串，便于拼接原始 HTTP 报文。
 * @param headerValue 原始请求头值。
 * @returns 序列化后的字符串。
 */
function serializeHeaderValue(headerValue: string | string[]): string {
  return Array.isArray(headerValue) ? headerValue.join(", ") : headerValue;
}

/**
 * 构造发往上游的 WebSocket Upgrade 请求行与请求头原文。
 * @param clientReq 客户端升级请求。
 * @param requestTarget 发往上游的请求路径与查询参数。
 * @param hostHeader 发往上游时使用的 Host 头。
 * @returns 完整的 HTTP Upgrade 请求报文。
 */
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

/**
 * 将 cfProxy 返回的重定向地址还原成客户端可直接访问的原始目标地址。
 * @param location 上游返回的 Location。
 * @param cfProxy 当前使用的 cfProxy URL。
 * @param proxyBasePath cfProxy 拼接目标 URL 时使用的基础路径。
 * @returns 还原后的重定向地址。
 */
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

/**
 * 将 ws/wss 目标映射为 cfProxy 约定的 ws/wss 入口与 http/https 目标路径。
 * @param targetUrl 客户端原始 ws/wss 目标。
 * @param cfProxy 配置的 cfProxy 地址。
 * @returns 可用于上游连接的 cfProxy WebSocket URL。
 */
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

/**
 * 生成 Proxy-Authorization 头（Basic），用于带认证的 HTTP 代理。
 * @param auth 代理认证信息，格式为 username:password。
 * @returns 可直接写入请求头的认证字符串；无认证则返回 undefined。
 */
function buildProxyAuthorizationHeader(auth: string | undefined): string | undefined {
  if (!auth) {
    return undefined;
  }
  return `Basic ${Buffer.from(auth, "utf8").toString("base64")}`;
}

/**
 * 获取终端宽度，用于日志按行裁剪显示。
 * @returns 终端宽度；不可用时返回默认值 120。
 */
function getTerminalWidth(): number {
  return typeof process.stdout.columns === "number" && process.stdout.columns > 0
    ? process.stdout.columns
    : 120;
}

/**
 * 将单行日志裁剪到终端宽度，避免输出自动换行影响可读性。
 * @param input 待裁剪日志。
 * @returns 裁剪后的日志文本。
 */
function clipToTerminalWidth(input: string): string {
  const maxWidth = getTerminalWidth();
  if (input.length <= maxWidth) {
    return input;
  }

  return input.slice(0, maxWidth);
}

/**
 * 生成两行代理日志：第一行规则与代理，第二行目标 URL。
 * @param ruleText 命中的规则文本。
 * @param proxyRul 当前使用的上游代理标识。
 * @param url 本次请求目标 URL。
 * @returns 可直接输出到控制台的日志块。
 */
function formatProxyLogBlock(ruleText: string, proxyRul: string, url: string): string {
  const firstLine = clipToTerminalWidth(`[PORXY] ${ruleText} ${proxyRul}`);
  const secondLine = clipToTerminalWidth(url);
  return `${firstLine}\n${secondLine}`;
}

/**
 * 读取 HTTP 代理 CONNECT 响应头并提取状态码，剩余字节回推给后续隧道处理。
 * @param proxySocket 与 HTTP 代理的连接。
 * @param onResult 成功解析状态码后的回调。
 * @param onError 解析失败或连接异常时的回调。
 * @returns 无返回值。
 */
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

/**
 * 处理普通 HTTP/HTTPS 代理请求：按规则选择 DIRECT/cfProxy/httpProxy 并转发响应。
 * @param clientReq 客户端请求。
 * @param clientRes 客户端响应。
 * @returns 无返回值。
 */
export function handleProxyRequest(clientReq: IncomingMessage, clientRes: ServerResponse): void {
  // 提取请求方法和原始 URL，如果缺省则使用 GET 或空字符串
  const method = clientReq.method ?? "GET";
  const rawUrl = clientReq.url ?? "";

  // 根据 socket 是否加密决定默认协议（用于相对路径的情况）
  const defaultProtocol: "http:" | "https:" =
    "encrypted" in clientReq.socket && clientReq.socket.encrypted ? "https:" : "http:";

  const targetUrl = buildTargetUrl(rawUrl, clientReq.headers.host, defaultProtocol);
  if (!targetUrl) {
    clientRes.writeHead(400, { "Content-Type": "text/plain" });
    clientRes.end("Invalid proxy request URL");
    return;
  }

  // 复制请求头并删除所有 hop-by-hop 头，这些头不能转发给上游
  const headers = { ...clientReq.headers };
  for (const headerName of hopByHopHeaders) {
    delete headers[headerName];
  }

  // 根据目标主机名应用代理规则，可能返回 DIRECT、cfProxy、httpProxy 或 REJECT
  const { action: proxyAction, ruleText } = resolveProxyRuleByHostname(targetUrl.hostname);
  if (proxyAction === "REJECT") {
    // 拒绝的规则直接返回 403
    clientRes.writeHead(403, { "Content-Type": "text/plain" });
    clientRes.end("Blocked by proxy rule");
    return;
  }

  // 默认上游 URL 是目标地址，可根据规则调整
  let upstreamUrl: URL = targetUrl;
  let shouldUseHttpProxy = false;
  let proxyRul = "localhost"; // 用于日志记录当前使用的代理
  let cfProxyConnectIp: string | undefined;
  let cfProxyBasePath = "";
  let shouldRewriteCfLocation = false;

  let matchedCfProxyUrl: URL | undefined;
  // 如果是 cfProxy 规则并且配置了 cfProxyUrl，则将目标嵌入到 cfProxy 地址中
  if (proxyAction === "cfProxy" && cfProxyUrl) {
    const proxyBasePath = cfProxyUrl.pathname.endsWith("/")
      ? cfProxyUrl.pathname
      : `${cfProxyUrl.pathname}/`;
    const proxyUrl = `${cfProxyUrl.origin}${proxyBasePath}${targetUrl.href}`;
    upstreamUrl = new URL(proxyUrl);
    matchedCfProxyUrl = cfProxyUrl;
    cfProxyConnectIp = getCfGoodResolvedIp();
    proxyRul = cfProxyUrl.href;
    cfProxyBasePath = proxyBasePath;
    shouldRewriteCfLocation = true; // cfProxy 可能返回重定向需要处理
  } else if (proxyAction === "httpProxy") {
    // httpProxy 情况下只在主机和端口都存在时才使用
    shouldUseHttpProxy = !!httpProxyHost && !!httpProxyPort;
    if (shouldUseHttpProxy) {
      proxyRul = `http://${httpProxyHost}:${httpProxyPort}`;
    }
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

  // 输出日志块，包含命中规则与代理以及原始目标 URL
  console.log(formatProxyLogBlock(ruleText, proxyRul, targetUrl.href));
  // 根据是否需要 HTTP 代理选择不同的请求构造方式
  const upstreamRequest = shouldUseHttpProxy
    ? httpRequest(
        {
          hostname: httpProxyHost,
          port: Number(httpProxyPort),
          method,
          path: upstreamUrl.href, // 通过代理时使用完整 URL
          headers: upstreamHeaders,
        },
        (upstreamResponse) => {
          const responseHeaders = { ...upstreamResponse.headers };
          const locationHeader = upstreamResponse.headers.location;
          if (shouldRewriteCfLocation && matchedCfProxyUrl && typeof locationHeader === "string") {
            // cfProxy 的重定向地址需要还原给客户端
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
          hostname: cfProxyConnectIp ?? upstreamUrl.hostname,
          port: upstreamUrl.port || undefined,
          servername: upstreamUrl.hostname,
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

/**
 * 处理 WebSocket Upgrade：按规则建立直连、cfProxy 或 HTTP 代理隧道。
 * @param clientReq 客户端升级请求。
 * @param clientSocket 客户端 socket。
 * @param head Upgrade 阶段已读取但未消费的首包数据。
 * @returns 无返回值。
 */
export function handleProxyUpgrade(clientReq: IncomingMessage, clientSocket: Socket, head: Buffer): void {
  // 提取原始 URL 并依据加密状态设置默认 websocket 协议
  const rawUrl = clientReq.url ?? "";
  const defaultProtocol: "ws:" | "wss:" =
    "encrypted" in clientReq.socket && clientReq.socket.encrypted ? "wss:" : "ws:";

  const targetUrl = buildTargetUrl(rawUrl, clientReq.headers.host, defaultProtocol);
  if (!targetUrl) {
    writeHttpError(clientSocket, 400, "Bad Request");
    return;
  }

  // 根据目标主机名查找代理规则
  const { action: proxyAction, ruleText } = resolveProxyRuleByHostname(targetUrl.hostname);
  if (proxyAction === "REJECT") {
    // 拒绝则直接返回错误并关闭 socket
    writeHttpError(clientSocket, 403, "Forbidden");
    return;
  }

  // 基于代理规则决定上游目标，cfProxy 和 httpProxy 时会对 URL 做特殊处理
  let effectiveTargetUrl = targetUrl;
  let shouldUseHttpProxy = false;
  let proxyRul = "localhost";
  let cfProxyConnectIp: string | undefined;
  if (proxyAction === "cfProxy" && cfProxyUrl) {
    // 使用 cfProxy 隧道时构造对应的入口地址，并可能通过固定 IP 连接
    effectiveTargetUrl = buildCfProxyWebSocketUrl(targetUrl, cfProxyUrl);
    cfProxyConnectIp = getCfGoodResolvedIp();
    proxyRul = cfProxyUrl.href;
  } else if (proxyAction === "httpProxy") {
    // HTTP 代理需要 host/port 都配置
    shouldUseHttpProxy = !!httpProxyHost && !!httpProxyPort;
    if (shouldUseHttpProxy) {
      proxyRul = `http://${httpProxyHost}:${httpProxyPort}`;
    }
  }

  if (proxyAction === "cfProxy" && !cfProxyUrl) {
    console.warn("[proxy] cfProxy rule matched for websocket but cfProxy is not configured, fallback to DIRECT");
  }

  if (proxyAction === "httpProxy" && !shouldUseHttpProxy) {
    console.warn("[proxy] httpProxy rule matched for websocket but httpProxy is not configured, fallback to DIRECT");
  }

  // 判断目标是否使用 TLS，并计算端口号
  const isSecureTarget =
    effectiveTargetUrl.protocol === "wss:" ||
    effectiveTargetUrl.protocol === "https:";
  const targetPort = Number(
    effectiveTargetUrl.port || (isSecureTarget ? "443" : "80"),
  );
  const proxyAuthorization = buildProxyAuthorizationHeader(httpProxyAuth);
  if (!Number.isFinite(targetPort) || targetPort <= 0) {
    // 端口非法则直接报错
    writeHttpError(clientSocket, 400, "Bad Request");
    return;
  }

  const onUpstreamError = (error: Error) => {
    console.error("[proxy] upstream websocket tunnel failed", error);
    if (!clientSocket.destroyed) {
      writeHttpError(clientSocket, 502, "Bad Gateway");
    }
  };

  console.log(formatProxyLogBlock(ruleText, proxyRul, targetUrl.href));

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

  // 如果不经过 HTTP 代理，就直接建立 TCP 或 TLS 连接
  if (!shouldUseHttpProxy) {
    const connectHost = cfProxyConnectIp ?? effectiveTargetUrl.hostname;
    const directUpstreamSocket: Socket | TLSSocket = isSecureTarget
      ? connectTlsSocket({
          host: connectHost,
          port: targetPort,
          servername: effectiveTargetUrl.hostname,
        })
      : connectSocket({
          host: connectHost,
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
