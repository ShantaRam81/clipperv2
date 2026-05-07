import { createServer } from "node:http";
import { copyFile, mkdir, readFile, readdir, rm, unlink, writeFile, stat } from "node:fs/promises";
import { createReadStream, existsSync, readdirSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

const rootDir = process.cwd();
const publicDir = join(rootDir, "public");
const storageDir = join(rootDir, "storage");
const clipsDir = join(storageDir, "clips");
const tempDir = join(storageDir, "tmp");
const libraryPath = join(storageDir, "library.json");
const port = Number(process.env.PORT || 3000);
const commandPaths = {
  "ffmpeg": process.env.FFMPEG_PATH,
  "yt-dlp": process.env.YTDLP_PATH
};

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml"
};

export async function startServer(options = {}) {
  await ensureStorage();
  const listenPort = Number(options.port || port);
  const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === "GET" && url.pathname === "/api/health") {
      return sendJson(res, await getHealth());
    }

    if (req.method === "GET" && url.pathname === "/api/library") {
      return sendJson(res, await readLibrary());
    }

    if (req.method === "POST" && url.pathname === "/api/probe") {
      const body = await readJson(req);
      return sendJson(res, await probeSource(body.url));
    }

    if (req.method === "POST" && url.pathname === "/api/select-folder") {
      return sendJson(res, await selectOutputFolder());
    }

    if (req.method === "POST" && url.pathname === "/api/clips") {
      const body = await readJson(req);
      const clip = await createClip(body);
      return sendJson(res, clip, 201);
    }

    if (req.method === "DELETE" && url.pathname.startsWith("/api/clips/")) {
      const id = decodeURIComponent(url.pathname.replace("/api/clips/", ""));
      return sendJson(res, await deleteClip(id));
    }

    if (req.method === "GET" && url.pathname.startsWith("/clips/")) {
      return serveClip(url.pathname, res);
    }

    if (req.method === "GET") {
      return serveStatic(url.pathname, res);
    }

    sendJson(res, { error: "Method not allowed" }, 405);
  } catch (error) {
    sendJson(res, { error: error.message || "Unexpected error" }, error.status || 500);
  }
  });

  return new Promise((resolveServer) => {
    server.listen(listenPort, () => {
      console.log(`Reference Clipper is running at http://localhost:${listenPort}`);
      resolveServer(server);
    });
  });
}

async function ensureStorage() {
  await mkdir(publicDir, { recursive: true });
  await mkdir(clipsDir, { recursive: true });
  await mkdir(tempDir, { recursive: true });
  try {
    await stat(libraryPath);
  } catch {
    await writeFile(libraryPath, "[]\n", "utf8");
  }
}

async function serveStatic(pathname, res) {
  const requested = pathname === "/" ? "/index.html" : pathname;
  const filePath = resolve(publicDir, `.${decodeURIComponent(requested)}`);
  if (!filePath.startsWith(resolve(publicDir))) {
    return sendJson(res, { error: "Forbidden" }, 403);
  }

  try {
    await stat(filePath);
    res.writeHead(200, { "Content-Type": mimeTypes[extname(filePath)] || "application/octet-stream" });
    createReadStream(filePath).pipe(res);
  } catch {
    sendJson(res, { error: "Not found" }, 404);
  }
}

async function serveClip(pathname, res) {
  const fileName = decodeURIComponent(pathname.replace("/clips/", ""));
  const filePath = resolve(clipsDir, `./${fileName}`);
  if (!filePath.startsWith(resolve(clipsDir))) {
    return sendJson(res, { error: "Forbidden" }, 403);
  }

  try {
    await stat(filePath);
    res.writeHead(200, { "Content-Type": mimeTypes[extname(filePath)] || "application/octet-stream" });
    createReadStream(filePath).pipe(res);
  } catch {
    sendJson(res, { error: "Clip not found" }, 404);
  }
}

async function getHealth() {
  const [ffmpeg, ytdlp] = await Promise.all([hasCommand("ffmpeg"), hasCommand("yt-dlp")]);
  return {
    ok: true,
    dependencies: {
      node: process.version,
      ffmpeg,
      "yt-dlp": ytdlp
    },
    storage: {
      clipsDir
    }
  };
}

async function selectOutputFolder() {
  try {
    return await selectOutputFolderWithShell();
  } catch {
    return await selectOutputFolderWithPowerShell();
  }
}

async function selectOutputFolderWithShell() {
  const scriptPath = join(tempDir, `select-folder-${randomUUID()}.vbs`);
  const script = [
    'Set shell = CreateObject("Shell.Application")',
    'Set folder = shell.BrowseForFolder(0, "Select folder for clip export", &H00000041, 17)',
    "If Not folder Is Nothing Then",
    "  WScript.Echo folder.Self.Path",
    "End If"
  ].join("\r\n");

  await writeFile(scriptPath, script, "utf8");
  try {
    const result = await runCommand("cscript.exe", ["//nologo", scriptPath], { timeout: 120000 });
    const path = result.stdout.trim();
    return {
      path,
      selected: Boolean(path)
    };
  } finally {
    try {
      await unlink(scriptPath);
    } catch {
      // temporary dialog script cleanup is best-effort
    }
  }
}

async function selectOutputFolderWithPowerShell() {
  const script = `
Add-Type -AssemblyName System.Windows.Forms
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = "Выберите папку для сохранения клипов"
$dialog.ShowNewFolderButton = $true
$result = $dialog.ShowDialog()
if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
  Write-Output $dialog.SelectedPath
}
`;
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const result = await runCommand("powershell.exe", [
    "-NoProfile",
    "-STA",
    "-EncodedCommand",
    encoded
  ], { timeout: 300000 });
  const path = result.stdout.trim();
  return {
    path,
    selected: Boolean(path)
  };
}

async function probeSource(sourceUrl) {
  const parsedUrl = validateUrl(sourceUrl);
  const ytdlp = await hasCommand("yt-dlp");

  if (!ytdlp) {
    return {
      provider: detectProvider(parsedUrl.href),
      title: "",
      duration: 30,
      thumbnail: "",
      canDownload: false,
      message: "yt-dlp не найден. Интерфейс доступен, но метаданные и экспорт требуют установки yt-dlp."
    };
  }

  if (detectProvider(parsedUrl.href) === "Behance") {
    const options = await discoverBehanceVideos(parsedUrl.href);
    if (options.length) {
      const enriched = await enrichVideoOptions(options);
      const first = enriched[0];
      return {
        ...first,
        options: enriched,
        pageUrl: parsedUrl.href,
        message: `Найдено видео в кейсе: ${enriched.length}. Выберите нужный ролик.`
      };
    }
    throw statusError("В этом Behance-кейсе не нашел поддерживаемое видео. GIF и картинки пропущены.", 404);
  }

  const result = await runCommand("yt-dlp", ["--dump-json", "--no-playlist", parsedUrl.href], { timeout: 30000 });
  const info = JSON.parse(result.stdout);
  return {
    url: parsedUrl.href,
    provider: detectProvider(parsedUrl.href),
    title: info.title || "",
    duration: Number(info.duration || 30),
    thumbnail: info.thumbnail || "",
    canDownload: true
  };
}

async function createClip(input) {
  const sourceUrl = validateUrl(input.sourceUrl || input.url);
  const title = sanitizeTitle(input.title || "Untitled reference");
  const start = parseTime(input.start);
  const end = parseTime(input.end);
  const duration = Math.max(0, end - start);
  const quality = normalizeQuality(input.quality);

  if (duration <= 0) {
    throw statusError("Конец фрагмента должен быть позже начала.", 400);
  }
  if (duration > 60) {
    throw statusError("Для референсов лучше держать фрагмент до 60 секунд.", 400);
  }

  const [ffmpeg, ytdlp] = await Promise.all([hasCommand("ffmpeg"), hasCommand("yt-dlp")]);
  if (!ffmpeg || !ytdlp) {
    throw statusError(`Для экспорта нужны зависимости: ${!ytdlp ? "yt-dlp " : ""}${!ffmpeg ? "ffmpeg" : ""}`.trim(), 409);
  }

  const id = randomUUID();
  const outputName = `${safeFileName(title)}-${id.slice(0, 8)}.mp4`;
  const outputPath = join(clipsDir, outputName);
  const requestedOutputDir = normalizeOutputDir(input.outputDir);
  const sourcePath = join(tempDir, `${id}.source.%(ext)s`);

  await runCommand("yt-dlp", [
    "--no-playlist",
    "-f",
    getYtdlpFormat(quality),
    "--merge-output-format",
    "mp4",
    "-o",
    sourcePath,
    sourceUrl.href
  ], { timeout: 120000 });

  const mediaFiles = await findDownloadedMediaFiles(id);
  await cutMedia(mediaFiles, start, duration, outputPath, quality);
  await assertVideoFile(outputPath);

  let copiedTo = "";
  if (requestedOutputDir) {
    await mkdir(requestedOutputDir, { recursive: true });
    copiedTo = join(requestedOutputDir, outputName);
    await copyFile(outputPath, copiedTo);
  }

  const clip = {
    id,
    title,
    sourceUrl: sourceUrl.href,
    provider: detectProvider(sourceUrl.href),
    start,
    end,
    duration,
    quality,
    createdAt: new Date().toISOString(),
    file: normalize(outputPath),
    outputName,
    copiedTo: copiedTo ? normalize(copiedTo) : "",
    href: `/clips/${outputName}`
  };

  const library = await readLibrary();
  library.unshift(clip);
  await writeFile(libraryPath, `${JSON.stringify(library, null, 2)}\n`, "utf8");
  await cleanupTempDir();
  return clip;
}

async function cleanupTempDir() {
  try {
    const entries = await readdir(tempDir, { withFileTypes: true });
    await Promise.all(entries.map((entry) => rm(join(tempDir, entry.name), { recursive: true, force: true })));
  } catch (error) {
    console.warn(`Could not clean temporary storage: ${error.message}`);
  }
}

async function deleteClip(id) {
  const library = await readLibrary();
  const clip = library.find((item) => item.id === id);
  if (!clip) {
    throw statusError("Запись не найдена.", 404);
  }

  const nextLibrary = library.filter((item) => item.id !== id);
  await writeFile(libraryPath, `${JSON.stringify(nextLibrary, null, 2)}\n`, "utf8");

  if (clip.file) {
    const filePath = resolve(clip.file);
    if (filePath.startsWith(resolve(clipsDir))) {
      try {
        await unlink(filePath);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
  }

  return { deleted: true, id };
}

async function discoverBehanceVideos(pageUrl) {
  const response = await fetch(pageUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0 ReferenceClipper/0.1",
      "Accept": "text/html,application/xhtml+xml"
    }
  });

  if (!response.ok) {
    throw statusError(`Behance вернул статус ${response.status}.`, 502);
  }

  const html = decodeHtmlEntities((await response.text()).replace(/\\\//g, "/").replace(/\\u002F/g, "/"));
  const candidates = new Map();

  for (const match of html.matchAll(/https?:\/\/player\.vimeo\.com\/video\/(\d+)/gi)) {
    addVideoCandidate(candidates, `https://vimeo.com/${match[1]}`, "Vimeo");
  }
  for (const match of html.matchAll(/https?:\/\/(?:www\.)?vimeo\.com\/(?:video\/)?(\d+)/gi)) {
    addVideoCandidate(candidates, `https://vimeo.com/${match[1]}`, "Vimeo");
  }
  for (const match of html.matchAll(/https?:\/\/(?:www\.)?youtube\.com\/embed\/([a-zA-Z0-9_-]+)/gi)) {
    addVideoCandidate(candidates, `https://www.youtube.com/watch?v=${match[1]}`, "YouTube");
  }
  for (const match of html.matchAll(/https?:\/\/(?:www\.)?youtube\.com\/watch\?[^"'<> ]*v=([a-zA-Z0-9_-]+)/gi)) {
    addVideoCandidate(candidates, `https://www.youtube.com/watch?v=${match[1]}`, "YouTube");
  }
  for (const match of html.matchAll(/https?:\/\/youtu\.be\/([a-zA-Z0-9_-]+)/gi)) {
    addVideoCandidate(candidates, `https://www.youtube.com/watch?v=${match[1]}`, "YouTube");
  }
  for (const match of html.matchAll(/https?:\/\/www-ccv\.adobe\.io\/v1\/player\/ccv\/([a-zA-Z0-9_-]+)\/embed[^"'<> ]*/gi)) {
    addVideoCandidate(candidates, `https://www-ccv.adobe.io/v1/player/ccv/${match[1]}/embed?api_key=behance1`, "Adobe CCV");
  }
  for (const match of html.matchAll(/https?:\/\/[^"'<> ]+\.(?:mp4|webm|mov)(?:\?[^"'<> ]*)?/gi)) {
    addVideoCandidate(candidates, match[0], "Direct video");
  }

  return [...candidates.values()].filter((candidate) => !isGif(candidate.url));
}

async function enrichVideoOptions(options) {
  const enriched = [];
  for (let index = 0; index < options.length; index += 1) {
    const option = options[index];
    try {
      if (option.provider === "Adobe CCV") {
        enriched.push(await enrichAdobeCcvOption(option, index));
        continue;
      }
      const result = await runCommand("yt-dlp", ["--dump-json", "--no-playlist", option.url], { timeout: 30000 });
      const info = JSON.parse(result.stdout);
      enriched.push({
        id: `${option.provider.toLowerCase()}-${index}`,
        url: option.url,
        provider: option.provider,
        title: info.title || `${option.provider} video ${index + 1}`,
        duration: Number(info.duration || 30),
        thumbnail: info.thumbnail || "",
        canDownload: true
      });
    } catch {
      enriched.push({
        id: `${option.provider.toLowerCase()}-${index}`,
        url: option.url,
        provider: option.provider,
        title: `${option.provider} video ${index + 1}`,
        duration: 30,
        thumbnail: "",
        canDownload: true
      });
    }
  }
  return enriched;
}

async function enrichAdobeCcvOption(option, index) {
  const response = await fetch(option.url, {
    headers: {
      "User-Agent": "Mozilla/5.0 ReferenceClipper/0.1",
      "Accept": "text/html"
    }
  });
  if (!response.ok) throw new Error(`Adobe CCV вернул статус ${response.status}`);

  const html = decodeHtmlEntities((await response.text()).replace(/\\\//g, "/"));
  const mp4Url = matchFirst(html, /"mp4URL"\s*:\s*"([^"]+)"/) || matchFirst(html, /<source[^>]+src="([^"]+\.mp4[^"]*)"/);
  const poster = matchFirst(html, /"posterframe"\s*:\s*"([^"]+)"/) || matchFirst(html, /data-poster="([^"]+)"/);
  const duration = Number(matchFirst(html, /"duration"\s*:\s*([\d.]+)/) || 30);

  if (!mp4Url) throw new Error("Не нашел mp4URL в Adobe CCV embed.");
  return {
    id: `adobe-ccv-${index}`,
    url: mp4Url,
    provider: "Adobe CCV",
    title: `Adobe CCV video ${index + 1}`,
    duration,
    thumbnail: poster || "",
    canDownload: true
  };
}

function matchFirst(value, pattern) {
  const match = value.match(pattern);
  return match ? match[1].replace(/&amp;/g, "&") : "";
}

function addVideoCandidate(candidates, url, provider) {
  const cleanUrl = url.replace(/&amp;/g, "&");
  if (!isGif(cleanUrl)) {
    candidates.set(cleanUrl, { url: cleanUrl, provider });
  }
}

function decodeHtmlEntities(value) {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#x2F;/g, "/")
    .replace(/&#47;/g, "/")
    .replace(/&amp;/g, "&");
}

function isGif(value) {
  return /\.gif(?:\?|$)/i.test(value) || /giphy\.com/i.test(value);
}

async function findDownloadedMediaFiles(id) {
  const { readdir } = await import("node:fs/promises");
  const files = await readdir(tempDir);
  const candidates = files
    .filter((file) => file.startsWith(`${id}.source.`))
    .map((file) => join(tempDir, file));

  if (!candidates.length) {
    throw statusError("yt-dlp не создал исходные файлы.", 500);
  }

  let videoPath = "";
  let audioPath = "";
  for (const candidate of candidates) {
    const streams = await getStreams(candidate);
    if (!videoPath && streams.includes("video")) videoPath = candidate;
    if (!audioPath && streams.includes("audio")) audioPath = candidate;
  }

  if (!videoPath) {
    throw statusError("В загруженном источнике не найден видеопоток.", 500);
  }

  return { videoPath, audioPath };
}

async function cutMedia(mediaFiles, start, duration, outputPath, quality = "720") {
  const args = ["-y"];

  args.push("-ss", formatSeconds(start), "-t", formatSeconds(duration), "-i", mediaFiles.videoPath);
  if (mediaFiles.audioPath && mediaFiles.audioPath !== mediaFiles.videoPath) {
    args.push("-ss", formatSeconds(start), "-t", formatSeconds(duration), "-i", mediaFiles.audioPath);
    args.push("-map", "0:v:0", "-map", "1:a:0");
  } else {
    args.push("-map", "0:v:0", "-map", "0:a:0?");
  }

  const maxHeight = getMaxHeight(quality);
  if (maxHeight) {
    args.push("-vf", `scale=-2:min(${maxHeight}\\,ih)`);
  }

  args.push(
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-shortest",
    "-movflags",
    "+faststart",
    outputPath
  );

  await runCommand("ffmpeg", args, { timeout: 120000 });
}

async function getStreams(filePath) {
  const result = await runCommand("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "stream=codec_type",
    "-of",
    "csv=p=0",
    filePath
  ], { timeout: 30000 });
  return result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

async function assertVideoFile(filePath) {
  const streams = await getStreams(filePath);
  if (!streams.includes("video")) {
    throw statusError("Фрагмент создан без видеопотока. Файл не сохранен как готовый клип.", 500);
  }
}

function normalizeOutputDir(value) {
  if (!value || !String(value).trim()) return "";
  const resolved = resolve(String(value).trim().replace(/^"|"$/g, ""));
  const parsedRoot = resolve(resolved).slice(0, 3);
  if (!/^[a-z]:\\/i.test(parsedRoot)) {
    throw statusError("Укажите полный путь папки, например C:\\Users\\BBulat\\Videos\\Refs.", 400);
  }
  return resolved;
}

function normalizeQuality(value) {
  const allowed = new Set(["source", "1080", "720", "480"]);
  const quality = String(value || "720");
  return allowed.has(quality) ? quality : "720";
}

function getYtdlpFormat(quality) {
  if (quality === "source") return "bv*+ba/b";
  return `bv*[height<=${quality}]+ba/b[height<=${quality}]/b`;
}

function getMaxHeight(quality) {
  if (quality === "source") return 0;
  return Number(quality) || 720;
}

async function readLibrary() {
  return JSON.parse((await readFile(libraryPath, "utf8")).replace(/^\uFEFF/, ""));
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(res, payload, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function validateUrl(value) {
  if (!value) throw statusError("Укажите ссылку на источник.", 400);
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) throw new Error("Unsupported protocol");
    return url;
  } catch {
    throw statusError("Ссылка должна быть валидным http/https URL.", 400);
  }
}

function parseTime(value) {
  if (typeof value === "number") return value;
  if (typeof value !== "string") return 0;
  const parts = value.split(":").map(Number);
  if (parts.some((part) => Number.isNaN(part))) return Number(value) || 0;
  return parts.reduce((total, part) => total * 60 + part, 0);
}

function formatSeconds(seconds) {
  return seconds.toFixed(3);
}

function sanitizeTitle(value) {
  return String(value).trim().replace(/\s+/g, " ").slice(0, 90) || "Untitled reference";
}

function safeFileName(value) {
  return sanitizeTitle(value)
    .toLowerCase()
    .replace(/[^a-z0-9а-яё]+/giu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 70) || "reference";
}

function detectProvider(value) {
  const host = new URL(value).hostname.replace(/^www\./, "");
  if (host.includes("youtube.com") || host.includes("youtu.be")) return "YouTube";
  if (host.includes("vimeo.com")) return "Vimeo";
  if (host.includes("behance.net")) return "Behance";
  return host;
}

function hasCommand(command) {
  return new Promise((resolveCheck) => {
    const versionArgs = command === "ffmpeg" ? ["-version"] : ["--version"];
    const child = spawn(resolveCommand(command), versionArgs, { shell: false });
    child.on("error", () => resolveCheck(false));
    child.on("close", (code) => resolveCheck(code === 0));
  });
}

function runCommand(command, args, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(resolveCommand(command), args, { shell: false });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      rejectRun(statusError(`${command} не ответил вовремя.`, 504));
    }, options.timeout || 60000);

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", rejectRun);
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolveRun({ stdout, stderr });
      } else {
        rejectRun(statusError(stderr || `${command} завершился с кодом ${code}`, 500));
      }
    });
  });
}

function resolveCommand(command) {
  if (commandPaths[command]) return commandPaths[command];
  const localAppData = process.env.LOCALAPPDATA || join(process.env.USERPROFILE || "", "AppData", "Local");
  const candidates = [
    join(localAppData, "Microsoft", "WinGet", "Links", `${command}.exe`),
    ...findWinGetPackageCommands(localAppData, command)
  ];
  commandPaths[command] = candidates.find((candidate) => existsSync(candidate)) || command;
  return commandPaths[command];
}

function findWinGetPackageCommands(localAppData, command) {
  const packagesDir = join(localAppData, "Microsoft", "WinGet", "Packages");
  if (!existsSync(packagesDir)) return [];

  try {
    return readdirSync(packagesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) => [
        join(packagesDir, entry.name, "bin", `${command}.exe`),
        ...findNestedCommand(join(packagesDir, entry.name), command)
      ]);
  } catch {
    return [];
  }
}

function findNestedCommand(dir, command) {
  const found = [];
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isFile() && entry.name.toLowerCase() === `${command}.exe`) {
        found.push(path);
      } else if (entry.isDirectory() && found.length < 4) {
        found.push(...findNestedCommand(path, command));
      }
    }
  } catch {
    return found;
  }
  return found;
}

function statusError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}
