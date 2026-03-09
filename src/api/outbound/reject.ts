import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { writeHttpError } from "../proxy-handler.js";
import type { Outbound } from "./types.js";

export const REJECToutbound: Outbound = {
  handleRequest(_clientReq: IncomingMessage, clientRes: ServerResponse, _targetUrl: URL, ruleText: string) {
    // 直接拒绝请求
    clientRes.writeHead(403, { "Content-Type": "text/plain" });
    clientRes.end("Blocked by proxy rule");
  },

  handleUpgrade(_clientReq: IncomingMessage, clientSocket: Socket, _head: Buffer, _targetUrl: URL, ruleText: string) {
    // WebSocket 升级时同样拒绝
    writeHttpError(clientSocket, 403, "Forbidden");
  },
};
