import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import yaml from "yaml";
import { ensureMitmRootCertificate } from "./tools/mitm-cert.js";

export type ProxyAction = "REJECT" | "cfProxy" | "httpProxy" | "DIRECT";


export const mitmDir = (() => {
  const path = join(process.cwd(), "config");
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true });
  }
  return path;
})();

export const mitmCertPath = join(mitmDir, "mitm-cert.pem");
export const mitmKeyPath = join(mitmDir, "mitm-key.pem");
ensureMitmRootCertificate(mitmCertPath, mitmKeyPath);

export const configYaml = (() => {
  const path = join(mitmDir, "config.yml");
  if (!existsSync(path)) {
    const defaultConfig = `
server:
  listen: 3000
cfProxy: http://test.com/
cfGoodIp: freeyx.cloudflare88.eu.org
cfXForwardedForHeader: freeyx.cloudflare88.eu.org
httpProxy:
  host: 127.0.0.1
  port: 7897
  auth: # "username:password" format, optional
rules:
  - DOMAIN,ad.com,REJECT
  - DOMAIN-SUFFIX,google.com,cfProxy
  - DOMAIN-KEYWORD,youtube,httpProxy
  - DOMAIN-WILDCARD,*.google.com,cfProxy
  - DOMAIN-REGEX,^abc.*com,DIRECT
  - MATCH,DIRECT
`;
    writeFileSync(path, defaultConfig, { encoding: "utf8" });
  }

  const content = readFileSync(path, "utf8");
  return yaml.parse(content);
})();


function parseProxyUrl(raw: unknown): URL | undefined {
  if (typeof raw !== "string" || raw.trim() === "") {
    return undefined;
  }

  try {
    return new URL(raw);
  } catch {
    return undefined;
  }
}

function parsePort(raw: unknown): number | undefined {
  const portNumber = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(portNumber) || portNumber <= 0) {
    return undefined;
  }

  return portNumber;
}

export const port = parsePort(configYaml.server?.listen) ?? 3000;
export const cfProxyUrl = parseProxyUrl(configYaml.cfProxy);
export const cfGoodIp =
  typeof configYaml.cfGoodIp === "string" && configYaml.cfGoodIp.trim() !== ""
    ? configYaml.cfGoodIp.trim()
    : undefined;
export const cfXForwardedForHeader =
  typeof configYaml.cfXForwardedForHeader === "string" && configYaml.cfXForwardedForHeader.trim() !== ""
    ? configYaml.cfXForwardedForHeader.trim()
    : undefined;
export const httpProxyHost =
  typeof configYaml.httpProxy?.host === "string" && configYaml.httpProxy.host.trim() !== ""
    ? configYaml.httpProxy.host.trim()
    : undefined;
export const httpProxyPort = parsePort(configYaml.httpProxy?.port);
export const httpProxyAuth =
  typeof configYaml.httpProxy?.auth === "string" && configYaml.httpProxy.auth.trim() !== ""
    ? configYaml.httpProxy.auth.trim()
    : undefined;

let cfGoodResolvedIp: string | undefined;
let cfXForwardedForResolvedIp: string | undefined;

export async function initCfGoodIp(): Promise<void> {
  if (cfGoodIp) {
    if (isIP(cfGoodIp) !== 0) {
      cfGoodResolvedIp = cfGoodIp;
      console.log(`[proxy] cfGoodIp: ${cfGoodResolvedIp}`);
    } else {
      try {
        const result = await lookup(cfGoodIp, { family: 0, all: false, verbatim: true });
        cfGoodResolvedIp = result.address;
        console.log(`[proxy] cfGoodIp: ${cfGoodResolvedIp}`);
      } catch (error) {
        console.warn(`[proxy] cfGoodIp resolve failed: ${cfGoodIp}`, error);
      }
    }
  }

  if (cfXForwardedForHeader) {
    if (isIP(cfXForwardedForHeader) !== 0) {
      cfXForwardedForResolvedIp = cfXForwardedForHeader;
      console.log(`[proxy] cfXForwardedForHeader: ${cfXForwardedForResolvedIp}`);
    } else {
      try {
        const result = await lookup(cfXForwardedForHeader, { family: 0, all: false, verbatim: true });
        cfXForwardedForResolvedIp = result.address;
        console.log(`[proxy] cfXForwardedForHeader: ${cfXForwardedForResolvedIp}`);
      } catch (error) {
        console.warn(`[proxy] cfXForwardedForHeader resolve failed: ${cfXForwardedForHeader}`, error);
      }
    }
  }
}

export function getCfGoodResolvedIp(): string | undefined {
  return cfGoodResolvedIp;
}

export function getCfXForwardedForResolvedIp(): string | undefined {
  return cfXForwardedForResolvedIp;
}




