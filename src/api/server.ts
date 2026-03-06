import { createServer } from "node:http";
import { TLSSocket } from "node:tls";
import { createMitmSecureContext } from "./mitm-cert.js";
import { handleProxyRequest } from "./proxy-handler.js";

const mitmSecureContext = await createMitmSecureContext();

export const server = createServer(handleProxyRequest);

server.on("connect", (_req, clientSocket, head) => {
  clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
  if (head.length > 0) {
    clientSocket.unshift(head);
  }

  const tlsSocket = new TLSSocket(clientSocket, {
    isServer: true,
    secureContext: mitmSecureContext,
  });

  tlsSocket.on("error", (error) => {
    console.error("[proxy] mitm tls failed", error);
    if (!tlsSocket.destroyed) {
      tlsSocket.destroy();
    }
  });

  server.emit("connection", tlsSocket);
});
