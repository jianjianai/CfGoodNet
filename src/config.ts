import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import yaml from "yaml";
import { ensureMitmRootCertificate } from "./tools/mitm-cert.js";

export type ProxyAction = "REJECT" | "cfProxy" | "httpProxy" | "DIRECT";

type RuleType =
  | "DOMAIN"
  | "DOMAIN-SUFFIX"
  | "DOMAIN-KEYWORD"
  | "DOMAIN-WILDCARD"
  | "DOMAIN-REGEX"
  | "MATCH";

type RuleMatcher = (hostname: string) => boolean;

type ParsedRule = {
  type: RuleType;
  pattern: string;
  action: ProxyAction;
  text: string;
  matches: RuleMatcher;
};

export type ResolvedProxyRule = {
  action: ProxyAction;
  ruleText: string;
};

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

function normalizeProxyAction(input: unknown): ProxyAction | null {
  if (typeof input !== "string") {
    return null;
  }

  const normalized = input.trim().toUpperCase();
  switch (normalized) {
    case "REJECT":
      return "REJECT";
    case "CFPROXY":
      return "cfProxy";
    case "HTTPPROXY":
      return "httpProxy";
    case "DIRECT":
      return "DIRECT";
    default:
      return null;
  }
}

function normalizeHostnamePattern(input: string): string {
  return input.trim().toLowerCase();
}

function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const regexBody = escaped.replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${regexBody}$`, "i");
}

function buildRuleMatcher(type: RuleType, pattern: string): RuleMatcher | null {
  if (type === "MATCH") {
    return () => true;
  }

  const normalizedPattern = normalizeHostnamePattern(pattern);
  if (!normalizedPattern) {
    return null;
  }

  switch (type) {
    case "DOMAIN":
      return (hostname) => hostname === normalizedPattern;
    case "DOMAIN-SUFFIX":
      return (hostname) =>
        hostname === normalizedPattern || hostname.endsWith(`.${normalizedPattern}`);
    case "DOMAIN-KEYWORD":
      return (hostname) => hostname.includes(normalizedPattern);
    case "DOMAIN-WILDCARD": {
      const wildcardRegex = wildcardToRegExp(normalizedPattern);
      return (hostname) => wildcardRegex.test(hostname);
    }
    case "DOMAIN-REGEX": {
      try {
        const regex = new RegExp(pattern, "i");
        return (hostname) => regex.test(hostname);
      } catch {
        return null;
      }
    }
    default:
      return null;
  }
}

function parseRuleLine(rawRule: unknown): ParsedRule | null {
  if (typeof rawRule !== "string") {
    return null;
  }

  const parts = rawRule
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  if (parts.length < 2) {
    return null;
  }

  const ruleTypeText = parts[0];
  if (!ruleTypeText) {
    return null;
  }

  const ruleType = ruleTypeText.toUpperCase() as RuleType;
  if (
    ruleType !== "DOMAIN" &&
    ruleType !== "DOMAIN-SUFFIX" &&
    ruleType !== "DOMAIN-KEYWORD" &&
    ruleType !== "DOMAIN-WILDCARD" &&
    ruleType !== "DOMAIN-REGEX" &&
    ruleType !== "MATCH"
  ) {
    return null;
  }

  if (ruleType === "MATCH") {
    const actionText = parts[1];
    if (!actionText) {
      return null;
    }

    const action = normalizeProxyAction(actionText);
    const matcher = buildRuleMatcher(ruleType, "");
    if (!action || !matcher) {
      return null;
    }

    return {
      type: ruleType,
      pattern: "",
      action,
      text: `${ruleType},${action}`,
      matches: matcher,
    };
  }

  if (parts.length < 3) {
    return null;
  }

  const pattern = parts[1];
  const actionText = parts[2];
  if (!pattern || !actionText) {
    return null;
  }

  const action = normalizeProxyAction(actionText);
  const matcher = buildRuleMatcher(ruleType, pattern);
  if (!action || !matcher) {
    return null;
  }

  return {
    type: ruleType,
    pattern,
    action,
    text: `${ruleType},${pattern},${action}`,
    matches: matcher,
  };
}

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
export const httpProxyHost =
  typeof configYaml.httpProxy?.host === "string" && configYaml.httpProxy.host.trim() !== ""
    ? configYaml.httpProxy.host.trim()
    : undefined;
export const httpProxyPort = parsePort(configYaml.httpProxy?.port);
export const httpProxyAuth =
  typeof configYaml.httpProxy?.auth === "string" && configYaml.httpProxy.auth.trim() !== ""
    ? configYaml.httpProxy.auth.trim()
    : undefined;

const rawRules: unknown[] = Array.isArray(configYaml.rules) ? configYaml.rules : [];
export const proxyRules = rawRules
  .map((rule: unknown) => parseRuleLine(rule))
  .filter((rule: ParsedRule | null): rule is ParsedRule => rule !== null);

export function resolveProxyRuleByHostname(hostname: string): ResolvedProxyRule {
  const normalizedHostname = hostname.trim().toLowerCase();
  if (!normalizedHostname) {
    return {
      action: "DIRECT",
      ruleText: "MATCH,DIRECT",
    };
  }

  for (const rule of proxyRules) {
    if (rule.matches(normalizedHostname)) {
      return {
        action: rule.action,
        ruleText: rule.text,
      };
    }
  }

  return {
    action: "DIRECT",
    ruleText: "MATCH,DIRECT",
  };
}

export function resolveProxyActionByHostname(hostname: string): ProxyAction {
  return resolveProxyRuleByHostname(hostname).action;
}

let cfGoodResolvedIp: string | undefined;

export async function initCfGoodIp(): Promise<void> {
  if (!cfGoodIp) {
    return;
  }

  if (isIP(cfGoodIp) !== 0) {
    cfGoodResolvedIp = cfGoodIp;
    console.log(`[proxy] cfGoodIp: ${cfGoodResolvedIp}`);
    return;
  }

  try {
    const result = await lookup(cfGoodIp, { family: 0, all: false, verbatim: true });
    cfGoodResolvedIp = result.address;
    console.log(`[proxy] cfGoodIp: ${cfGoodResolvedIp}`);
  } catch (error) {
    console.warn(`[proxy] cfGoodIp resolve failed: ${cfGoodIp}`, error);
  }
}

export function getCfGoodResolvedIp(): string | undefined {
  return cfGoodResolvedIp;
}




