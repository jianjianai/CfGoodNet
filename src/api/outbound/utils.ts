import { type Socket } from "node:net";



/**
 * 生成 Proxy-Authorization 头（Basic），用于带认证的 HTTP 代理。
 */
export function buildProxyAuthorizationHeader(auth: string | undefined): string | undefined {
  if (!auth) {
    return undefined;
  }
  return `Basic ${Buffer.from(auth, "utf8").toString("base64")}`;
}

/**
 * 生成两行代理日志：第一行规则与代理，第二行目标 URL。
 */
export function formatProxyLogBlock(ruleText: string, url: string): string {
  const maxWidth = typeof process.stdout.columns === "number" && process.stdout.columns > 0
    ? process.stdout.columns
    : 120;
  const clip = (input: string) => (input.length <= maxWidth ? input : input.slice(0, maxWidth));

  const firstLine = clip(`[PORXY] ${ruleText}`);
  const secondLine = clip(url);
  return `${firstLine}\n${secondLine}`;
}

/**
 * 读取 HTTP 代理 CONNECT 响应头并提取状态码，剩余字节回推给后续隧道处理。
 */
export function readHttpProxyConnectResponse(
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
