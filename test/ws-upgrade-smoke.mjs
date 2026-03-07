import net from "node:net";
import http from "node:http";

const { server: proxyServer } = await import("../dist/api/server.js");

const upstream = http.createServer();
upstream.on("upgrade", (_req, socket) => {
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      "Sec-WebSocket-Accept: test\r\n" +
      "\r\n",
  );
  socket.end();
});

await new Promise((resolve) => upstream.listen(19001, "127.0.0.1", resolve));
await new Promise((resolve) => proxyServer.listen(3100, "127.0.0.1", resolve));

const responseLine = await new Promise((resolve, reject) => {
  const client = net.createConnection({ host: "127.0.0.1", port: 3100 }, () => {
    client.write(
      "GET ws://127.0.0.1:19001/socket HTTP/1.1\r\n" +
        "Host: 127.0.0.1:19001\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" +
        "Sec-WebSocket-Version: 13\r\n" +
        "\r\n",
    );
  });

  let buffer = "";

  client.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    if (!buffer.includes("\r\n")) {
      return;
    }

    resolve(buffer.split("\r\n", 1)[0]);
    client.destroy();
  });

  client.on("error", reject);
});

console.log(`WS_UPGRADE_RESULT=${responseLine}`);

await new Promise((resolve) => proxyServer.close(resolve));
await new Promise((resolve) => upstream.close(resolve));
