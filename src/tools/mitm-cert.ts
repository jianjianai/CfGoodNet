import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createSecureContext, type SecureContext } from "node:tls";
import forge from "node-forge";

type CertificateAuthority = {
  cert: forge.pki.Certificate;
  certPem: string;
  key: forge.pki.rsa.PrivateKey;
  keyPem: string;
};

type SubjectAltNameEntry =
  | {
      type: 2;
      value: string;
    }
  | {
      type: 7;
      ip: string;
    };

const secureContextCache = new Map<string, SecureContext>();
let loadedCa: CertificateAuthority | undefined;
let loadedCaPaths: { cert: string; key: string } | undefined;

function randomSerialNumber(): string {
  return forge.util.bytesToHex(forge.random.getBytesSync(16));
}

function isIpv4(hostname: string): boolean {
  return /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/.test(
    hostname,
  );
}

function isIpv6(hostname: string): boolean {
  return hostname.includes(":");
}

function createRootCertificateAuthority(): CertificateAuthority {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = randomSerialNumber();

  const notBefore = new Date();
  notBefore.setDate(notBefore.getDate() - 1);
  const notAfter = new Date();
  notAfter.setFullYear(notAfter.getFullYear() + 10);
  cert.validity.notBefore = notBefore;
  cert.validity.notAfter = notAfter;

  const attrs: forge.pki.CertificateField[] = [
    { name: "commonName", value: "CFGoodNet MITM Root CA" },
    { name: "organizationName", value: "CFGoodNet" },
    { name: "countryName", value: "CN" },
  ];

  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    {
      name: "basicConstraints",
      cA: true,
      critical: true,
    },
    {
      name: "keyUsage",
      keyCertSign: true,
      cRLSign: true,
      digitalSignature: true,
      critical: true,
    },
    {
      name: "subjectKeyIdentifier",
    },
  ]);

  cert.sign(keys.privateKey, forge.md.sha256.create());

  return {
    cert,
    certPem: forge.pki.certificateToPem(cert),
    key: keys.privateKey,
    keyPem: forge.pki.privateKeyToPem(keys.privateKey),
  };
}

function loadOrCreateCertificateAuthority(mitmCertFile: string, mitmKeyFile: string): CertificateAuthority {
  if (
    loadedCa &&
    loadedCaPaths &&
    loadedCaPaths.cert === mitmCertFile &&
    loadedCaPaths.key === mitmKeyFile
  ) {
    return loadedCa;
  }

  const certExists = existsSync(mitmCertFile);
  const keyExists = existsSync(mitmKeyFile);

  let ca: CertificateAuthority;
  if (certExists && keyExists) {
    const certPem = readFileSync(mitmCertFile, "utf8");
    const keyPem = readFileSync(mitmKeyFile, "utf8");
    ca = {
      cert: forge.pki.certificateFromPem(certPem),
      certPem,
      key: forge.pki.privateKeyFromPem(keyPem) as forge.pki.rsa.PrivateKey,
      keyPem,
    };
  } else {
    ca = createRootCertificateAuthority();
    writeFileSync(mitmCertFile, ca.certPem, { encoding: "utf8" });
    writeFileSync(mitmKeyFile, ca.keyPem, { encoding: "utf8" });
    console.log(`[proxy] generated MITM root CA: ${mitmCertFile}`);
  }

  loadedCa = ca;
  loadedCaPaths = { cert: mitmCertFile, key: mitmKeyFile };
  return ca;
}

function buildSubjectAltNames(hostname: string): SubjectAltNameEntry[] {
  if (isIpv4(hostname) || isIpv6(hostname)) {
    return [
      {
        type: 7,
        ip: hostname,
      },
    ];
  }

  return [
    {
      type: 2,
      value: hostname,
    },
  ];
}

function createLeafSecureContext(hostname: string, ca: CertificateAuthority): SecureContext {
  const keyPair = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keyPair.publicKey;
  cert.serialNumber = randomSerialNumber();

  const notBefore = new Date();
  notBefore.setDate(notBefore.getDate() - 1);
  const notAfter = new Date();
  notAfter.setFullYear(notAfter.getFullYear() + 1);
  cert.validity.notBefore = notBefore;
  cert.validity.notAfter = notAfter;

  const subject: forge.pki.CertificateField[] = [
    { name: "commonName", value: hostname },
    { name: "organizationName", value: "CFGoodNet MITM" },
  ];

  cert.setSubject(subject);
  cert.setIssuer(ca.cert.subject.attributes);
  cert.setExtensions([
    {
      name: "basicConstraints",
      cA: false,
      critical: true,
    },
    {
      name: "keyUsage",
      digitalSignature: true,
      keyEncipherment: true,
      critical: true,
    },
    {
      name: "extKeyUsage",
      serverAuth: true,
    },
    {
      name: "subjectAltName",
      altNames: buildSubjectAltNames(hostname),
    },
    {
      name: "authorityKeyIdentifier",
      keyIdentifier: true,
    },
    {
      name: "subjectKeyIdentifier",
    },
  ]);

  cert.sign(ca.key, forge.md.sha256.create());

  const leafCertPem = forge.pki.certificateToPem(cert);
  const leafKeyPem = forge.pki.privateKeyToPem(keyPair.privateKey);

  return createSecureContext({
    cert: `${leafCertPem}\n${ca.certPem}`,
    key: leafKeyPem,
  });
}

export function ensureMitmRootCertificate(mitmCertFile: string, mitmKeyFile: string): void {
  loadOrCreateCertificateAuthority(mitmCertFile, mitmKeyFile);
}

export function createMitmSecureContextForHostname(
  hostname: string,
  mitmCertFile: string,
  mitmKeyFile: string,
): SecureContext {
  const normalizedHostname = hostname.trim().toLowerCase();
  if (!normalizedHostname) {
    throw new Error("hostname is required for MITM certificate generation");
  }

  const cacheKey = `${mitmCertFile}|${mitmKeyFile}|${normalizedHostname}`;
  const cached = secureContextCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const ca = loadOrCreateCertificateAuthority(mitmCertFile, mitmKeyFile);
  const secureContext = createLeafSecureContext(normalizedHostname, ca);
  secureContextCache.set(cacheKey, secureContext);
  return secureContext;
}
