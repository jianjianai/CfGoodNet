import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import yaml from "yaml";
import { createMitmSecureContext } from "./tools/mitm-cert.js";

export const mitmDir = (() => {
  const path = join(process.cwd(), "config");
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true });
  }
  return path;
})();
export const mitmSecureContext = await createMitmSecureContext(
  join(mitmDir, "mitm-cert.pem"),
  join(mitmDir, "mitm-key.pem")
);
export const configYaml = (() => {
  const path = join(mitmDir, "config.yml");
  if (!existsSync(path)) {
    const defaultConfig = 
`
server:
  listen: 3000
cfProxy: http://test.com/
`;
    writeFileSync(path, defaultConfig, { encoding: "utf8" });
  }
  const content = readFileSync(path, "utf8");
  return yaml.parse(content);
})();

export const port = configYaml.server?.listen ?? 3000;
export const cfProxyUrl = new URL(configYaml.cfProxy);



