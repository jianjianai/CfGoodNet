import { IncomingMessage, ServerResponse, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { Socket, connect as connectSocket } from "node:net";
import { connect as connectTlsSocket, TLSSocket } from "node:tls";
import {
  cfProxyUrl,
  getCfGoodResolvedIp,
  httpProxyAuth,
  httpProxyHost,
  httpProxyPort,
} from "../../config.js";
import {
  buildProxyAuthorizationHeader,
  readHttpProxyConnectResponse
} from "./utils.js";
import {
  hopByHopHeaders,
  buildUpstreamUpgradeRequest,
  writeHttpError,
} from "../proxy-handler.js";
import type { Outbound } from "./types.js";

/**
 * 将 cfProxy 返回的重定向地址还原成客户端可直接访问的原始目标地址。
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

export const cfProxyOutbound: Outbound = {
  handleRequest(clientReq: IncomingMessage, clientRes: ServerResponse, targetUrl: URL, ruleText: string) {
    // 如果 cfProxy 未配置则拒绝请求并记录日志
    if (!cfProxyUrl) {
      console.warn("[proxy] cfProxy rule matched but cfProxy is not configured, rejecting request");
      clientRes.writeHead(502, { "Content-Type": "text/plain" });
      clientRes.end("cfProxy not configured");
      return;
    }

    const method = clientReq.method ?? "GET";

    const headers = { ...clientReq.headers };
    for (const headerName of hopByHopHeaders) {
      delete headers[headerName];
    }

    const proxyBasePath = cfProxyUrl.pathname.endsWith("/")
      ? cfProxyUrl.pathname
      : `${cfProxyUrl.pathname}/`;
    const proxyUrl = `${cfProxyUrl.origin}${proxyBasePath}${targetUrl.href}`;
    const upstreamUrl = new URL(proxyUrl);
    const matchedCfProxyUrl = cfProxyUrl;
    const cfProxyConnectIp = getCfGoodResolvedIp();
    const proxyRul = cfProxyUrl.href;
    const cfProxyPath = proxyBasePath;
    const shouldRewriteCfLocation = true;

    const upstreamHeaders = { ...headers, host: upstreamUrl.host };

    const upstreamRequest = (upstreamUrl.protocol === "https:" ? httpsRequest : httpRequest)(
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
        if (
          shouldRewriteCfLocation &&
          matchedCfProxyUrl &&
          typeof locationHeader === "string"
        ) {
          responseHeaders.location = rewriteCfProxyLocation(
            locationHeader,
            matchedCfProxyUrl,
            cfProxyPath,
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
      clientRes.end(`Bad Gateway: cfProxy upstream ${upstreamUrl.host} unreachable`);
    });

    clientReq.pipe(upstreamRequest);
  },

  handleUpgrade(clientReq: IncomingMessage, clientSocket: Socket, head: Buffer, targetUrl: URL, ruleText: string) {
    // 如果 cfProxy 未配置则拒绝请求并记录日志
    if (!cfProxyUrl) {
      console.warn("[proxy] cfProxy rule matched for websocket but cfProxy is not configured, rejecting upgrade");
      writeHttpError(clientSocket, 502, "cfProxy not configured");
      return;
    }

    let effectiveTargetUrl = buildCfProxyWebSocketUrl(targetUrl, cfProxyUrl);
    const cfProxyConnectIp = getCfGoodResolvedIp();

    const isSecureTarget =
      effectiveTargetUrl.protocol === "wss:" ||
      effectiveTargetUrl.protocol === "https:";
    const targetPort = Number(
      effectiveTargetUrl.port || (isSecureTarget ? "443" : "80"),
    );
    const proxyAuthorization = buildProxyAuthorizationHeader(httpProxyAuth);

    const onUpstreamError = (error: Error) => {
      console.error("[proxy] upstream websocket tunnel failed", error);
      if (!clientSocket.destroyed) {
        writeHttpError(clientSocket, 502, `Bad Gateway (cfProxy ${effectiveTargetUrl.host})`);
      }
    };


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

    // 直接或通过 HTTP 代理连接到 cfProxy 上游
    const connectHost = cfProxyConnectIp ?? effectiveTargetUrl.hostname;
    if (!httpProxyHost || !httpProxyPort) {
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
  },
};
