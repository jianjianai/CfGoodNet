import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createSecureContext, type SecureContext } from "node:tls";
import selfsigned from "selfsigned";

const mitmCertFile = join(process.cwd(), "mitm-cert.pem");
const mitmKeyFile = join(process.cwd(), "mitm-key.pem");

async function ensureMitmCertificate(): Promise<void> {
  const certExists = existsSync(mitmCertFile);
  const keyExists = existsSync(mitmKeyFile);
  if (certExists && keyExists) {
    return;
  }

  const attrs = [{ name: "commonName", value: "CFGoodNet MITM Proxy" }];
  const notAfterDate = new Date();
  notAfterDate.setFullYear(notAfterDate.getFullYear() + 10);

  const generated = await selfsigned.generate(attrs, {
    algorithm: "sha256",
    keySize: 2048,
    notAfterDate,
  });

  writeFileSync(mitmCertFile, generated.cert, { encoding: "utf8" });
  writeFileSync(mitmKeyFile, generated.private, { encoding: "utf8" });
  console.log(`[proxy] generated MITM certificate: ${mitmCertFile}`);
}

export async function createMitmSecureContext(): Promise<SecureContext> {
  await ensureMitmCertificate();
  return createSecureContext({
    cert: readFileSync(mitmCertFile),
    key: readFileSync(mitmKeyFile),
  });
}
