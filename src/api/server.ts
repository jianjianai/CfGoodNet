import { createServer } from "node:http";
import { TLSSocket } from "node:tls";
import { handleProxyRequest, handleProxyUpgrade } from "./proxy-handler.js";
import { mitmCertPath, mitmKeyPath, port } from "../config.js";
import { createMitmSecureContextForHostname } from "../tools/mitm-cert.js";

function parseConnectHostname(connectTarget: string | undefined): string | null {
  if (!connectTarget) {
    return null;
  }

  try {
    const url = new URL(`https://${connectTarget}`);
    return url.hostname || null;
  } catch {
    return null;
  }
}

export const server = createServer(handleProxyRequest);
server.on("upgrade", handleProxyUpgrade);
server.on("connect", (req, clientSocket, head) => {
  const connectHostname = parseConnectHostname(req.url);
  if (!connectHostname) {
    clientSocket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    clientSocket.destroy();
    return;
  }

  clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
  if (head.length > 0) {
    clientSocket.unshift(head);
  }

  let secureContext;
  try {
    secureContext = createMitmSecureContextForHostname(connectHostname, mitmCertPath, mitmKeyPath);
  } catch (error) {
    console.error("[proxy] failed to create MITM leaf certificate", error);
    if (!clientSocket.destroyed) {
      clientSocket.destroy();
    }
    return;
  }

  const tlsSocket = new TLSSocket(clientSocket, {
    isServer: true,
    secureContext,
  });

  tlsSocket.on("error", (error) => {
    console.error("[proxy] mitm tls failed", error);
    if (!tlsSocket.destroyed) {
      tlsSocket.destroy();
    }
  });

  server.emit("connection", tlsSocket);
});
