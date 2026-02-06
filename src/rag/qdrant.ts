import { ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as https from "node:https";
import * as os from "node:os";
import * as path from "node:path";
import { pipeline } from "node:stream/promises";
import AdmZip from "adm-zip";
import * as tar from "tar";

export type QdrantConfig = {
  binaryPath: string;
  configPath?: string;
  host: string;
  port: number;
  dataDir?: string;
};

let qdrantProcess: ChildProcess | null = null;
let downloadPromise: Promise<string> | null = null;

type QdrantAsset = {
  archiveName: string;
  binaryName: string;
  archiveType: "tar.gz" | "zip";
};

export async function startQdrant(config: QdrantConfig): Promise<void> {
  if (qdrantProcess) {
    return;
  }

  await assertFileExists(config.binaryPath);

  const args: string[] = [];
  if (config.configPath) {
    args.push("--config-path", config.configPath);
  }

  const env: NodeJS.ProcessEnv = { ...process.env };
  if (config.dataDir) {
    env.QDRANT__STORAGE__STORAGE_PATH = config.dataDir;
  }
  env.QDRANT__SERVICE__HOST = config.host;
  env.QDRANT__SERVICE__HTTP_PORT = String(config.port);

  const cwd = path.dirname(config.binaryPath);
  qdrantProcess = spawn(config.binaryPath, args, {
    cwd,
    env,
    stdio: "ignore",
    detached: false,
  });

  qdrantProcess.on("exit", () => {
    qdrantProcess = null;
  });
}

export async function ensureQdrantBinary(
  installRoot: string
): Promise<string> {
  if (downloadPromise) {
    return downloadPromise;
  }

  downloadPromise = (async () => {
    const asset = getQdrantAsset();
    const installDir = path.join(
      installRoot,
      `${process.platform}-${process.arch}`
    );
    const expectedPath = path.join(installDir, asset.binaryName);
    if (await fileExists(expectedPath)) {
      return expectedPath;
    }

    await fs.mkdir(installDir, { recursive: true });
    const archivePath = path.join(installDir, asset.archiveName);
    const url = `https://github.com/qdrant/qdrant/releases/latest/download/${asset.archiveName}`;

    await downloadToFile(url, archivePath);
    await extractArchive(asset, archivePath, installDir);
    await safeUnlink(archivePath);

    const resolved = await findBinaryPath(installDir, asset.binaryName);
    if (!resolved) {
      throw new Error("Qdrant binary not found after download.");
    }
    if (process.platform !== "win32") {
      await fs.chmod(resolved, 0o755);
    }
    return resolved;
  })();

  try {
    return await downloadPromise;
  } finally {
    downloadPromise = null;
  }
}

export async function stopQdrant(): Promise<void> {
  if (!qdrantProcess) {
    return;
  }
  qdrantProcess.kill("SIGTERM");
  qdrantProcess = null;
}

export function getQdrantStatus(): "running" | "stopped" {
  return qdrantProcess ? "running" : "stopped";
}

async function assertFileExists(filePath: string): Promise<void> {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) {
      throw new Error("Path is not a file.");
    }
  } catch {
    throw new Error(
      "Qdrant binary not found. Set llmPrAssistant.qdrantPath to the local binary."
    );
  }
}

function getQdrantAsset(): QdrantAsset {
  const platform = process.platform;
  const arch = process.arch;

  if (platform === "darwin" && arch === "arm64") {
    return {
      archiveName: "qdrant-aarch64-apple-darwin.tar.gz",
      binaryName: "qdrant",
      archiveType: "tar.gz",
    };
  }
  if (platform === "darwin" && arch === "x64") {
    return {
      archiveName: "qdrant-x86_64-apple-darwin.tar.gz",
      binaryName: "qdrant",
      archiveType: "tar.gz",
    };
  }
  if (platform === "linux" && arch === "x64") {
    return {
      archiveName: "qdrant-x86_64-unknown-linux-gnu.tar.gz",
      binaryName: "qdrant",
      archiveType: "tar.gz",
    };
  }
  if (platform === "linux" && arch === "arm64") {
    return {
      archiveName: "qdrant-aarch64-unknown-linux-gnu.tar.gz",
      binaryName: "qdrant",
      archiveType: "tar.gz",
    };
  }
  if (platform === "win32" && arch === "x64") {
    return {
      archiveName: "qdrant-x86_64-pc-windows-msvc.zip",
      binaryName: "qdrant.exe",
      archiveType: "zip",
    };
  }

  throw new Error(
    `Qdrant binary is not available for ${os.platform()} ${os.arch()}.`
  );
}

async function downloadToFile(url: string, destPath: string): Promise<void> {
  await fs.mkdir(path.dirname(destPath), { recursive: true });
  return new Promise((resolve, reject) => {
    https
      .get(url, (response) => {
        if (
          response.statusCode &&
          response.statusCode >= 300 &&
          response.statusCode < 400 &&
          response.headers.location
        ) {
          response.resume();
          downloadToFile(response.headers.location, destPath)
            .then(resolve)
            .catch(reject);
          return;
        }

        if (response.statusCode !== 200) {
          response.resume();
          reject(
            new Error(
              `Failed to download Qdrant (status ${response.statusCode}).`
            )
          );
          return;
        }

        const fileStream = fs
          .open(destPath, "w")
          .then((handle) => handle.createWriteStream());

        fileStream
          .then((stream) => pipeline(response, stream).then(resolve).catch(reject))
          .catch(reject);
      })
      .on("error", reject);
  });
}

async function extractArchive(
  asset: QdrantAsset,
  archivePath: string,
  installDir: string
): Promise<void> {
  if (asset.archiveType === "tar.gz") {
    await tar.x({ file: archivePath, cwd: installDir });
    return;
  }
  const zip = new AdmZip(archivePath);
  zip.extractAllTo(installDir, true);
}

async function findBinaryPath(
  rootDir: string,
  binaryName: string
): Promise<string | null> {
  const entries = await fs.readdir(rootDir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isFile() && entry.name === binaryName) {
      return fullPath;
    }
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const found = await findBinaryPath(
        path.join(rootDir, entry.name),
        binaryName
      );
      if (found) {
        return found;
      }
    }
  }
  return null;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function safeUnlink(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch {
    // Ignore missing file cleanup errors.
  }
}

