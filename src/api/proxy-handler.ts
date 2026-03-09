import { type IncomingMessage, type ServerResponse, } from "node:http";
import { resolveProxyRuleByHostname } from "../config.js";
import { type Socket } from "node:net";
import { outbounds } from "./outbound/index.js";

export const hopByHopHeaders = [
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
export function writeHttpError(socket: Socket, statusCode: number, message: string): void {
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
export function buildUpstreamUpgradeRequest(
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
 * 处理普通 HTTP/HTTPS 代理请求：按规则选择 DIRECT/cfProxy/httpProxy 并转发响应。
 * @param clientReq 客户端请求。
 * @param clientRes 客户端响应。
 * @returns 无返回值。
 */

export function handleProxyRequest(clientReq: IncomingMessage, clientRes: ServerResponse): void {
  // 原始 URL 和 Host 头
  const rawUrl = clientReq.url ?? "";
  const hostHeader = clientReq.headers.host;

  // 默认协议根据 socket 是否加密决定
  const defaultProtocol: "http:" | "https:" =
    "encrypted" in clientReq.socket && clientReq.socket.encrypted ? "https:" : "http:";

  const targetUrl = buildTargetUrl(rawUrl, hostHeader, defaultProtocol);
  if (!targetUrl) {
    clientRes.writeHead(400, { "Content-Type": "text/plain" });
    clientRes.end("Invalid proxy request URL");
    return;
  }

  const { action: proxyAction, ruleText } = resolveProxyRuleByHostname(targetUrl);
  const handler = outbounds[proxyAction];
  if (!handler) {
    clientRes.writeHead(502, { "Content-Type": "text/plain" });
    clientRes.end("No outbound handler for action");
    return;
  }

  handler.handleRequest(clientReq, clientRes, targetUrl, ruleText);
}

/**
 * 处理 WebSocket Upgrade：按规则建立直连、cfProxy 或 HTTP 代理隧道。
 * @param clientReq 客户端升级请求。
 * @param clientSocket 客户端 socket。
 * @param head Upgrade 阶段已读取但未消费的首包数据。
 * @returns 无返回值。
 */
export function handleProxyUpgrade(clientReq: IncomingMessage, clientSocket: Socket, head: Buffer): void {
  const rawUrl = clientReq.url ?? "";
  const defaultProtocol: "ws:" | "wss:" =
    "encrypted" in clientReq.socket && clientReq.socket.encrypted ? "wss:" : "ws:";

  const targetUrl = buildTargetUrl(rawUrl, clientReq.headers.host, defaultProtocol);
  if (!targetUrl) {
    writeHttpError(clientSocket, 400, "Bad Request");
    return;
  }

  const { action: proxyAction, ruleText } = resolveProxyRuleByHostname(targetUrl);
  const handler = outbounds[proxyAction];
  if (!handler) {
    writeHttpError(clientSocket, 502, "No outbound handler for action");
    return;
  }

  handler.handleUpgrade(clientReq, clientSocket, head, targetUrl, ruleText);
}
