import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";

/**
 * 通用的出站处理接口。每种代理策略的模块都应实现此接口。
 * - handleRequest: 处理普通 HTTP/HTTPS 请求
 * - handleUpgrade: 处理 WebSocket Upgrade 隧道
 */
export interface Outbound {
  handleRequest(
    clientReq: IncomingMessage,
    clientRes: ServerResponse,
    targetUrl: URL,
    ruleText: string,
  ): void;

  handleUpgrade(
    clientReq: IncomingMessage,
    clientSocket: Socket,
    head: Buffer,
    targetUrl: URL,
    ruleText: string,
  ): void;
}
