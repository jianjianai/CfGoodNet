import { IncomingMessage, ServerResponse, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { Socket, connect as connectSocket } from "node:net";
import { connect as connectTlsSocket, TLSSocket } from "node:tls";
import {
  hopByHopHeaders,
  buildUpstreamUpgradeRequest,
  writeHttpError,
} from "../proxy-handler.js";
import type { Outbound } from "./types.js";

// 直接直连的出站实现
export const DIRECToutbound: Outbound = {
  handleRequest(clientReq: IncomingMessage, clientRes: ServerResponse, targetUrl: URL, ruleText: string) {
    const method = clientReq.method ?? "GET";

    // 清理不可转发的 hop-by-hop 头
    const headers = { ...clientReq.headers };
    for (const headerName of hopByHopHeaders) {
      delete headers[headerName];
    }

    const upstreamUrl = targetUrl;
    const upstreamHeaders = { ...headers, host: upstreamUrl.host };

    const upstreamRequest = (upstreamUrl.protocol === "https:" ? httpsRequest : httpRequest)(
      {
        protocol: upstreamUrl.protocol,
        hostname: upstreamUrl.hostname,
        port: upstreamUrl.port || undefined,
        servername: upstreamUrl.hostname,
        method,
        path: `${upstreamUrl.pathname}${upstreamUrl.search}`,
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

    const onUpstreamError = (error: Error) => {
      console.error("[proxy] upstream websocket tunnel failed", error);
      if (!clientSocket.destroyed) {
        writeHttpError(clientSocket, 502, "Bad Gateway");
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

    // 直接连接到目标
    const connectHost = targetUrl.hostname;
    const directUpstreamSocket: Socket | TLSSocket = isSecureTarget
      ? connectTlsSocket({
          host: connectHost,
          port: targetPort,
          servername: targetUrl.hostname,
        })
      : connectSocket({
          host: connectHost,
          port: targetPort,
        });

    attachUpgradeTunnel(directUpstreamSocket, false);
  },
};
