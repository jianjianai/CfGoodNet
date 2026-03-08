import { createWriteStream, existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import yazl from "yazl";

const workspaceRoot = process.cwd();
const startBatPath = resolve(workspaceRoot, "src", "start.bat");
const appCjsPath = resolve(workspaceRoot, "dist", "app.cjs");
const outputZipPath = resolve(workspaceRoot, "dist", "CFGoodNet.zip");

if (!existsSync(startBatPath)) {
  throw new Error(`Missing file: ${startBatPath}`);
}

if (!existsSync(appCjsPath)) {
  throw new Error(`Missing file: ${appCjsPath}`);
}

await mkdir(dirname(outputZipPath), { recursive: true });
await rm(outputZipPath, { force: true });

const zipFile = new yazl.ZipFile();
zipFile.addFile(startBatPath, "start.bat");
zipFile.addFile(appCjsPath, "app.cjs");

await new Promise((resolvePromise, rejectPromise) => {
  zipFile.outputStream
    .pipe(createWriteStream(outputZipPath))
    .on("close", resolvePromise)
    .on("error", rejectPromise);

  zipFile.end();
});

console.log(`Created ${outputZipPath}`);
