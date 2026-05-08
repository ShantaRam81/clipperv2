import { chmod, mkdir } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

if (process.platform !== "linux") {
  process.exit(0);
}

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const outputPath = join(rootDir, "node_modules", "youtube-dl-exec", "bin", "yt-dlp_linux");
const releaseUrl = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux";

await mkdir(dirname(outputPath), { recursive: true });

const response = await fetch(releaseUrl);
if (!response.ok || !response.body) {
  throw new Error(`Could not download yt-dlp_linux: ${response.status} ${response.statusText}`);
}

await pipeline(response.body, createWriteStream(outputPath));
await chmod(outputPath, 0o755);
console.log(`Installed ${outputPath}`);
