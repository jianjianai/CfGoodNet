import "./setup.js";
import { server } from "./api/server.js";
import { initCfGoodIp, port } from "./config.js";
import packageJson from "../package.json" with { type: "json" };

console.log(`Starting ${packageJson.name} v${packageJson.version}...`);

async function start(): Promise<void> {
  await initCfGoodIp();

  server.listen(port, () => {
    console.log("Server listening", server.address());
  });
}

void start().catch((error) => {
  console.error("[proxy] startup failed", error);
  process.exitCode = 1;
});
