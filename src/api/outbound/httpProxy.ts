import { IncomingMessage, ServerResponse, request as httpRequest } from "node:http";
import { Socket, connect as connectSocket } from "node:net";
import { connect as connectTlsSocket, TLSSocket } from "node:tls";
import {
  httpProxyAuth,
  httpProxyHost,
  httpProxyPort,
} from "../../config.js";
import {
  buildProxyAuthorizationHeader,
  readHttpProxyConnectResponse,
} from "./utils.js";
import {
  hopByHopHeaders,
  buildUpstreamUpgradeRequest,
  writeHttpError,
} from "../proxy-handler.js";
import type { Outbound } from "./types.js";

export const httpProxyOutbound: Outbound = {
  handleRequest(clientReq: IncomingMessage, clientRes: ServerResponse, targetUrl: URL, ruleText: string) {
    const method = clientReq.method ?? "GET";

    const headers = { ...clientReq.headers };
    for (const headerName of hopByHopHeaders) {
      delete headers[headerName];
    }

    const upstreamUrl = targetUrl;
    const proxyRul = `http://${httpProxyHost}:${httpProxyPort}`;
    const proxyAuthorization = buildProxyAuthorizationHeader(httpProxyAuth);

    // headers 对象中部分字段可能为 undefined，强制转换为字符串键值对用于发送
    const upstreamHeaders: Record<string, string> = { ...headers, host: upstreamUrl.href } as unknown as Record<string, string>;
    if (proxyAuthorization) {
      upstreamHeaders["proxy-authorization"] = proxyAuthorization;
    }

    const upstreamRequest = httpRequest(
      {
        hostname: httpProxyHost,
        port: Number(httpProxyPort),
        method,
        path: upstreamUrl.href,
        headers: upstreamHeaders,
      },
      (upstreamResponse) => {
        const responseHeaders = { ...upstreamResponse.headers };
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
  },

  handleUpgrade(clientReq: IncomingMessage, clientSocket: Socket, head: Buffer, targetUrl: URL, ruleText: string) {
    const isSecureTarget =
      targetUrl.protocol === "wss:" ||
      targetUrl.protocol === "https:";
    const targetPort = Number(
      targetUrl.port || (isSecureTarget ? "443" : "80"),
    );

    const proxyRul = `http://${httpProxyHost}:${httpProxyPort}`;
    const proxyAuthorization = buildProxyAuthorizationHeader(httpProxyAuth);

    const onUpstreamError = (error: Error) => {
      console.error("[proxy] upstream websocket tunnel failed", error);
      if (!clientSocket.destroyed) {
        writeHttpError(clientSocket, 502, "Bad Gateway");
      }
    };


    // 先跟 http 代理建立 TCP 连接，随后发送 CONNECT 请求
    const proxySocket = connectSocket({
      host: httpProxyHost,
      port: Number(httpProxyPort),
    });

    proxySocket.once("error", onUpstreamError);
    proxySocket.once("connect", () => {
      const connectHeaders = [
        `CONNECT ${targetUrl.host} HTTP/1.1`,
        `Host: ${targetUrl.host}`,
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
              servername: targetUrl.hostname,
            });
            attachUpgradeTunnel(tlsTunnelSocket, false);
            return;
          }

          attachUpgradeTunnel(proxySocket, true);
        },
        onUpstreamError,
      );
    });

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
            `${targetUrl.pathname}${targetUrl.search}`,
            targetUrl.host,
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
  },
};
