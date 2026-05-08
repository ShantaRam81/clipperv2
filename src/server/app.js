import { createServer } from "node:http";
import { mkdir, readFile, readdir, rm, unlink, writeFile, stat } from "node:fs/promises";
import { chmodSync, createReadStream, existsSync, readdirSync } from "node:fs";
import { extname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import ffmpegStaticPath from "ffmpeg-static";
import ytdlpConstants from "youtube-dl-exec/src/constants.js";

const require = createRequire(import.meta.url);
const packagedFfmpegPath = ffmpegStaticPath || "";
const packagedYtdlpConstants = ytdlpConstants || {};

const rootDir = process.cwd();
const publicDir = join(rootDir, "public");
const storageDir = process.env.STORAGE_DIR || (process.env.VERCEL ? join("/tmp", "reference-clipper") : join(rootDir, "storage"));
const clipsDir = join(storageDir, "clips");
const tempDir = join(storageDir, "tmp");
const libraryPath = join(storageDir, "library.json");
const port = Number(process.env.PORT || 3000);
const maxLocalClips = Number(process.env.MAX_LOCAL_CLIPS || 100);
const clipTtlHours = Number(process.env.CLIP_TTL_HOURS || 0);
const remoteProcessorUrl = process.env.CLIPPER_PROCESSOR_URL || "";
const remoteProcessorToken = process.env.CLIPPER_PROCESSOR_TOKEN || "";
const commandPaths = {
  "ffmpeg": process.env.FFMPEG_PATH || packagedFfmpegPath,
  "ffprobe": process.env.FFPROBE_PATH,
  "yt-dlp": process.env.YTDLP_PATH || packagedYtdlpConstants?.YOUTUBE_DL_PATH || findPackagedYtdlp()
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
  const server = createServer(handleRequest);

  return new Promise((resolveServer) => {
    server.listen(listenPort, () => {
      console.log(`Reference Clipper is running at http://localhost:${listenPort}`);
      resolveServer(server);
    });
  });
}

export async function handleRequest(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === "GET" && url.pathname === "/api/health") {
      return sendJson(res, await getHealth());
    }

    if (req.method === "GET" && url.pathname === "/api/library") {
      return sendJson(res, []);
    }

    if (req.method === "POST" && url.pathname === "/api/probe") {
      const body = await readJson(req);
      return sendJson(res, await probeSource(body.url));
    }

    if (req.method === "POST" && url.pathname === "/api/preview") {
      const body = await readJson(req);
      return sendJson(res, await createPreview(body.url));
    }

    if (req.method === "POST" && url.pathname === "/api/frames") {
      const body = await readJson(req);
      return sendJson(res, await createFrames(body));
    }

    if (req.method === "POST" && url.pathname === "/api/select-folder") {
      return sendJson(res, await selectOutputFolder());
    }

    if (req.method === "POST" && url.pathname === "/api/clips") {
      const body = await readJson(req);
      const clip = await createClip(body);
      return sendJson(res, clip, 201);
    }

    if (req.method === "GET" && url.pathname === "/api/download") {
      return serveDownload(url, res);
    }

    if (req.method === "GET" && url.pathname.startsWith("/remote-clips/")) {
      return serveRemoteClip(url.pathname, res);
    }

    if (req.method === "GET" && url.pathname.startsWith("/api/clips/") && url.pathname.endsWith("/file")) {
      const id = decodeURIComponent(url.pathname.replace("/api/clips/", "").replace("/file", ""));
      return serveLibraryClip(id, res);
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
}

export async function ensureStorage() {
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
  if (!isPathInside(resolve(publicDir), filePath)) {
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
  if (!isPathInside(resolve(clipsDir), filePath)) {
    return sendJson(res, { error: "Forbidden" }, 403);
  }

  try {
    await stat(filePath);
    res.writeHead(200, {
      "Content-Type": mimeTypes[extname(filePath)] || "application/octet-stream",
      "Content-Disposition": `attachment; filename="${encodeURIComponent(fileName || "clip.mp4")}"`,
      "Cache-Control": "no-store"
    });
    createReadStream(filePath).pipe(res);
  } catch {
    sendJson(res, { error: "Clip not found" }, 404);
  }
}

async function getHealth() {
  const [ffmpeg, ffprobe, ytdlp] = await Promise.all([hasCommand("ffmpeg"), hasCommand("ffprobe"), hasCommand("yt-dlp")]);
  return {
    ok: true,
    processing: {
      mode: remoteProcessorUrl ? "remote" : "local",
      maxLocalClips,
      clipTtlHours,
      canSelectOutputFolder: !process.env.VERCEL
    },
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
  if (process.env.VERCEL) {
    return {
      selected: false,
      path: "",
      message: "На Vercel нельзя выбрать локальную папку. Фрагмент будет доступен по ссылке после сохранения."
    };
  }

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
  if (remoteProcessorUrl) {
    return callRemoteProcessor({
      action: "probe",
      url: parsedUrl.href
    });
  }

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
    throw statusError("В этом Behance-кейсе не найдено поддерживаемое видео. GIF и картинки пропущены.", 404);
  }

  const result = await runCommand("yt-dlp", ["--dump-json", "--no-playlist", parsedUrl.href], { timeout: 30000 });
  const info = JSON.parse(result.stdout);
  return {
    url: parsedUrl.href,
    previewUrl: getPreviewUrl(info),
    provider: detectProvider(parsedUrl.href),
    title: info.title || "",
    duration: Number(info.duration || 30),
    thumbnail: info.thumbnail || "",
    canDownload: true
  };
}

async function createPreview(sourceUrl) {
  const parsedUrl = validateUrl(sourceUrl);

  if (/^https?:\/\/.+\.(mp4|webm|mov)(\?|$)/i.test(parsedUrl.href)) {
    return {
      previewUrl: parsedUrl.href,
      provider: detectProvider(parsedUrl.href)
    };
  }

  if (remoteProcessorUrl) {
    const data = await callRemoteProcessor({
      action: "probe",
      url: parsedUrl.href
    });
    if (!data.previewUrl) {
      throw statusError("Не удалось получить временную ссылку для предпросмотра.", 502);
    }
    return {
      previewUrl: data.previewUrl,
      provider: data.provider || detectProvider(parsedUrl.href),
      expiresSoon: true
    };
  }

  const ytdlp = await hasCommand("yt-dlp");
  if (!ytdlp) {
    throw statusError("Для предпросмотра Vimeo/YouTube нужен yt-dlp.", 409);
  }

  const result = await runCommand("yt-dlp", ["--dump-json", "--no-playlist", parsedUrl.href], { timeout: 30000 });
  const info = JSON.parse(result.stdout);
  const previewUrl = getPreviewUrl(info);
  if (!previewUrl) {
    throw statusError("Не удалось получить временную ссылку для предпросмотра.", 502);
  }

  return {
    previewUrl,
    provider: detectProvider(parsedUrl.href),
    expiresSoon: true
  };
}

async function createFrames(input) {
  const sourceUrl = validateUrl(input.url || input.sourceUrl);
  const duration = Math.max(1, Number(input.duration || 30));
  const count = Math.min(12, Math.max(3, Number(input.count || 9)));

  if (remoteProcessorUrl) {
    return callRemoteProcessor({
      action: "frames",
      url: sourceUrl.href,
      duration,
      count
    });
  }

  const [ffmpeg, ytdlp] = await Promise.all([hasCommand("ffmpeg"), hasCommand("yt-dlp")]);
  if (!ffmpeg || !ytdlp) {
    throw statusError("Для кадров таймлайна нужны ffmpeg и yt-dlp.", 409);
  }

  const id = randomUUID();
  const mediaFiles = await resolveMediaFiles(sourceUrl.href, "480");
  const frames = [];
  const safeDuration = Math.max(1, duration);

  try {
    for (let index = 0; index < count; index += 1) {
      const time = clamp((safeDuration * (index + 0.5)) / count, 0, Math.max(0, safeDuration - 0.05));
      const framePath = join(tempDir, `${id}-${index}.jpg`);
      await captureFrame(mediaFiles.videoPath, time, framePath, mediaFiles);
      const data = await readFile(framePath);
      frames.push(`data:image/jpeg;base64,${data.toString("base64")}`);
      await unlink(framePath).catch(() => {});
    }
  } finally {
    await cleanupTempFiles(id);
  }

  if (!frames.length) {
    throw statusError("Не удалось построить кадры таймлайна.", 502);
  }

  return { frames };
}

async function createClip(input) {
  const sourceUrl = validateUrl(input.sourceUrl || input.url);
  const title = sanitizeTitle(input.title || "Untitled reference");
  const start = parseTime(input.start);
  const end = parseTime(input.end);
  const duration = Math.max(0, end - start);
  const quality = normalizeQuality(input.quality);
  const requestedOutputDir = normalizeOutputDir(input.outputDir);

  if (duration <= 0) {
    throw statusError("Конец фрагмента должен быть позже начала.", 400);
  }
  if (duration > 60) {
    throw statusError("Для референсов лучше держать фрагмент до 60 секунд.", 400);
  }

  if (remoteProcessorUrl) {
    return createRemoteClip({
      url: input.url,
      sourceUrl: sourceUrl.href,
      title,
      start,
      end,
      duration,
      quality
    });
  }

  const [ffmpeg, ytdlp] = await Promise.all([hasCommand("ffmpeg"), hasCommand("yt-dlp")]);
  if (!ffmpeg || !ytdlp) {
    throw statusError(`Для экспорта нужны зависимости: ${!ytdlp ? "yt-dlp " : ""}${!ffmpeg ? "ffmpeg" : ""}`.trim(), 409);
  }

  const id = randomUUID();
  const outputName = `${safeFileName(title)}-${id.slice(0, 8)}.mp4`;
  const outputDir = requestedOutputDir || clipsDir;
  await mkdir(outputDir, { recursive: true });
  const outputPath = join(outputDir, outputName);

  try {
    const mediaFiles = await resolveMediaFiles(sourceUrl.href, quality);
    await cutMedia(mediaFiles, start, duration, outputPath, quality);
    await assertVideoFile(outputPath);
  } catch (error) {
    try {
      await unlink(outputPath);
    } catch (cleanupError) {
      if (cleanupError.code !== "ENOENT") {
        console.warn(`Could not remove failed output: ${cleanupError.message}`);
      }
    }
    throw error;
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
    href: requestedOutputDir ? `/api/clips/${id}/file` : `/api/download?file=${encodeURIComponent(outputName)}&name=${encodeURIComponent(outputName)}`,
    downloadUrl: requestedOutputDir ? `/api/clips/${id}/file` : `/api/download?file=${encodeURIComponent(outputName)}&name=${encodeURIComponent(outputName)}`
  };

  return clip;
}

async function createRemoteClip(payload) {
  return callRemoteProcessor(payload);
}

async function callRemoteProcessor(payload) {
  const response = await fetch(remoteProcessorUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(remoteProcessorToken ? { "Authorization": `Bearer ${remoteProcessorToken}` } : {})
    },
    body: JSON.stringify(payload)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw statusError(data.error || `Облачный обработчик вернул статус ${response.status}.`, response.status);
  }

  if (payload.action === "probe" || payload.action === "frames") {
    return data;
  }

  const clip = {
    id: data.id || randomUUID(),
    title: data.title || payload.title,
    sourceUrl: payload.sourceUrl,
    provider: detectProvider(payload.sourceUrl),
    start: payload.start,
    end: payload.end,
    duration: payload.duration,
    quality: payload.quality,
    createdAt: data.createdAt || new Date().toISOString(),
    file: "",
    outputName: data.outputName || "",
    href: data.href || data.url || data.publicUrl
  };

  if (!clip.href) {
    throw statusError("Облачный обработчик не вернул ссылку на готовый фрагмент.", 502);
  }

  return {
    ...clip,
    downloadUrl: getRemoteClipDownloadUrl(clip.href)
  };
}

async function cleanupTempDir() {
  try {
    const entries = await readdir(tempDir, { withFileTypes: true });
    await Promise.all(entries.map((entry) => rm(join(tempDir, entry.name), { recursive: true, force: true })));
  } catch (error) {
    console.warn(`Could not clean temporary storage: ${error.message}`);
  }
}

async function cleanupTempFiles(id) {
  try {
    const entries = await readdir(tempDir, { withFileTypes: true });
    await Promise.all(
      entries
        .filter((entry) => entry.name.startsWith(`${id}.`))
        .map((entry) => rm(join(tempDir, entry.name), { recursive: true, force: true }))
    );
  } catch (error) {
    console.warn(`Could not clean temporary files: ${error.message}`);
  }
}

async function deleteClip(id) {
  const library = await readLibrary();
  const clip = library.find((item) => item.id === id);
  if (!clip) {
    throw statusError("Запись не найдена.", 404);
  }

  const nextLibrary = library.filter((item) => item.id !== id);
  await writeLibrary(nextLibrary);
  await removeLocalClipFile(clip);

  return { deleted: true, id };
}

async function serveLibraryClip(id, res) {
  const library = await readLibrary();
  const clip = library.find((item) => item.id === id);
  if (clip?.href && !clip.file) {
    return proxyRemoteClip(clip, res);
  }
  if (!clip?.file) {
    return sendJson(res, { error: "Clip not found" }, 404);
  }

  try {
    await stat(clip.file);
    res.writeHead(200, {
      "Content-Type": mimeTypes[extname(clip.file)] || "application/octet-stream",
      "Content-Disposition": `attachment; filename="${encodeURIComponent(clip.outputName || "clip.mp4")}"`,
      "Cache-Control": "no-store"
    });
    createReadStream(clip.file).pipe(res);
  } catch {
    sendJson(res, { error: "Clip file not found" }, 404);
  }
}

async function proxyRemoteClip(clip, res) {
  const response = await fetch(clip.href);
  if (!response.ok || !response.body) {
    return sendJson(res, { error: "Remote clip file not found" }, response.status || 404);
  }

  res.writeHead(200, {
    "Content-Type": response.headers.get("content-type") || "video/mp4",
    "Content-Disposition": `attachment; filename="${encodeURIComponent(clip.outputName || "clip.mp4")}"`,
    "Cache-Control": "no-store"
  });
  Readable.fromWeb(response.body).pipe(res);
}

async function serveRemoteClip(pathname, res) {
  const target = remoteClipTargetFromProxyPath(pathname);
  if (!target) {
    return sendJson(res, { error: "Remote clip target is unavailable" }, 404);
  }

  const fileName = sanitizeDownloadName(decodeURIComponent(target.pathname.split("/").pop() || "clip.mp4"));
  return streamRemoteDownload(target, fileName, res);
}

async function serveDownload(url, res) {
  const remoteUrl = url.searchParams.get("url") || "";
  const localFile = url.searchParams.get("file") || "";
  const fileName = sanitizeDownloadName(url.searchParams.get("name") || localFile || "clip.mp4");

  if (remoteUrl) {
    return proxyDownloadUrl(remoteUrl, fileName, res);
  }

  if (!localFile) {
    return sendJson(res, { error: "Download target is missing" }, 400);
  }

  const filePath = resolve(clipsDir, `./${localFile}`);
  if (!isPathInside(resolve(clipsDir), filePath)) {
    return sendJson(res, { error: "Forbidden" }, 403);
  }

  try {
    await stat(filePath);
    res.writeHead(200, {
      "Content-Type": mimeTypes[extname(filePath)] || "application/octet-stream",
      "Content-Disposition": `attachment; filename="${encodeURIComponent(fileName)}"`,
      "Cache-Control": "no-store"
    });
    const stream = createReadStream(filePath);
    stream.pipe(res);
    res.on("finish", () => unlink(filePath).catch(() => {}));
  } catch {
    sendJson(res, { error: "Clip file not found" }, 404);
  }
}

async function proxyDownloadUrl(remoteUrl, fileName, res) {
  const target = validateUrl(remoteUrl);
  if (!isAllowedRemoteDownload(target)) {
    return sendJson(res, { error: "Forbidden download target" }, 403);
  }

  return streamRemoteDownload(target, fileName, res, { deleteAfter: true });
}

async function streamRemoteDownload(target, fileName, res, options = {}) {
  const response = await fetch(target.href);
  if (!response.ok || !response.body) {
    return sendJson(res, { error: "Remote clip file not found" }, response.status || 404);
  }

  const headers = {
    "Content-Type": response.headers.get("content-type") || "video/mp4",
    "Content-Disposition": `attachment; filename="${encodeURIComponent(fileName)}"`,
    "Cache-Control": "no-store"
  };
  const contentLength = response.headers.get("content-length");
  if (contentLength) {
    headers["Content-Length"] = contentLength;
  }

  res.writeHead(200, headers);
  if (options.deleteAfter) {
    res.on("finish", () => deleteRemoteDownload(target));
  }
  Readable.fromWeb(response.body).pipe(res);
}

function isAllowedRemoteDownload(target) {
  if (!remoteProcessorUrl) return false;
  try {
    const processor = new URL(remoteProcessorUrl);
    return target.host === processor.host && target.pathname.startsWith("/clips/");
  } catch {
    return false;
  }
}

function getRemoteClipDownloadUrl(remoteUrl) {
  try {
    const target = validateUrl(remoteUrl);
    if (!isAllowedRemoteDownload(target)) return remoteUrl;
    return `/remote-clips/${target.pathname.replace(/^\/clips\/?/, "")}`;
  } catch {
    return remoteUrl;
  }
}

function remoteClipTargetFromProxyPath(pathname) {
  if (!remoteProcessorUrl) return null;
  try {
    const processor = new URL(remoteProcessorUrl);
    const filePath = pathname.replace(/^\/remote-clips\/?/, "");
    if (!filePath || filePath.includes("..")) return null;
    return new URL(`/clips/${filePath}`, processor);
  } catch {
    return null;
  }
}

async function deleteRemoteDownload(target) {
  if (!remoteProcessorToken) return;
  await fetch(target.href, {
    method: "DELETE",
    headers: {
      "Authorization": `Bearer ${remoteProcessorToken}`
    }
  }).catch(() => {});
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

  for (const match of html.matchAll(/https?:\/\/player\.vimeo\.com\/video\/\d+[^"'<>\\\s]*/gi)) {
    addVideoCandidate(candidates, match[0], "Vimeo");
  }
  for (const match of html.matchAll(/https?:\/\/(?:www\.)?vimeo\.com\/(?:video\/)?(\d+)(?:[/?#][^"'<>\\\s]*)?/gi)) {
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
  const fallback = [];
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
        previewUrl: getPreviewUrl(info),
        provider: option.provider,
        title: info.title || `${option.provider} video ${index + 1}`,
        duration: Number(info.duration || 30),
        thumbnail: info.thumbnail || "",
        canDownload: true
      });
    } catch {
      fallback.push({
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
  return enriched.length ? enriched : fallback;
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

  if (!mp4Url) throw new Error("Не найден mp4URL в Adobe CCV embed.");
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

function getPreviewUrl(info) {
  if (typeof info.url === "string" && /^https?:\/\//i.test(info.url)) {
    return info.url;
  }

  const requested = [
    ...(Array.isArray(info.requested_downloads) ? info.requested_downloads : []),
    ...(Array.isArray(info.requested_formats) ? info.requested_formats : []),
    ...(Array.isArray(info.formats) ? info.formats : [])
  ];
  const playable = requested.find((format) => {
    if (!format?.url || !/^https?:\/\//i.test(format.url)) return false;
    if (format.vcodec === "none") return false;
    const protocol = String(format.protocol || "");
    return !protocol.includes("m3u8") && !protocol.includes("dash");
  });

  return playable?.url || "";
}

function addVideoCandidate(candidates, url, provider) {
  const cleanUrl = provider === "Vimeo" ? normalizeVimeoUrl(url) : url.replace(/&amp;/g, "&");
  if (!isGif(cleanUrl)) {
    candidates.set(getVideoCandidateKey(cleanUrl, provider), { url: cleanUrl, provider });
  }
}

function getVideoCandidateKey(url, provider) {
  if (provider !== "Vimeo") return url;
  try {
    const parsed = new URL(url);
    const playerId = parsed.hostname.includes("player.vimeo.com")
      ? parsed.pathname.match(/\/video\/(\d+)/)?.[1]
      : "";
    const pageMatch = parsed.hostname.includes("vimeo.com")
      ? parsed.pathname.match(/^\/(\d+)(?:\/([^/?#]+))?/)
      : null;
    const id = playerId || pageMatch?.[1] || url;
    const hash = parsed.searchParams.get("h") || pageMatch?.[2] || "";
    return `vimeo:${id}:${hash}`;
  } catch {
    return url;
  }
}

function normalizeVimeoUrl(url) {
  const cleanUrl = url.replace(/&amp;/g, "&");
  try {
    const parsed = new URL(cleanUrl);
    const playerId = parsed.hostname.includes("player.vimeo.com")
      ? parsed.pathname.match(/\/video\/(\d+)/)?.[1]
      : "";
    if (playerId) {
      const hash = parsed.searchParams.get("h");
      return hash ? `https://vimeo.com/${playerId}/${hash}` : cleanUrl;
    }
  } catch {
    return cleanUrl;
  }
  return cleanUrl;
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

async function resolveMediaFiles(sourceUrl, quality) {
  if (isDirectVideoUrl(sourceUrl)) {
    return { videoPath: sourceUrl, audioPath: "", streamed: false };
  }

  const result = await runCommand("yt-dlp", ["--dump-json", "--no-playlist", sourceUrl], { timeout: 30000 });
  const info = JSON.parse(result.stdout);
  const infoProtocol = String(info.protocol || "");
  const cleanInfoUrl = cleanMediaUrl(info.url);
  if (cleanInfoUrl && !isStreamProtocol(infoProtocol)) {
    return { videoPath: cleanInfoUrl, audioPath: "", streamed: false };
  }

  const requested = [
    ...(Array.isArray(info.requested_downloads) ? info.requested_downloads : []),
    ...(Array.isArray(info.requested_formats) ? info.requested_formats : []),
    ...(Array.isArray(info.formats) ? info.formats : [])
  ];
  const formats = requested
    .map((format) => ({ ...format, url: cleanMediaUrl(format.url) }))
    .filter((format) => format.url);
  const maxHeight = getMaxHeight(quality);
  const withinQuality = (format) => !maxHeight || !format.height || Number(format.height) <= maxHeight;
  const hasVideo = (format) => Boolean(format.vcodec && format.vcodec !== "none");
  const hasAudio = (format) => Boolean(format.acodec && format.acodec !== "none");
  const isPlainHttpMedia = (format) => {
    const protocol = String(format.protocol || "");
    return !isStreamProtocol(protocol);
  };
  const byQuality = (a, b) => {
    const aScore = Number(a.height || 0) * 100000 + Number(a.tbr || a.vbr || a.abr || 0);
    const bScore = Number(b.height || 0) * 100000 + Number(b.tbr || b.vbr || b.abr || 0);
    return bScore - aScore;
  };

  const combined = formats
    .filter((format) => hasVideo(format) && hasAudio(format) && withinQuality(format) && isPlainHttpMedia(format))
    .sort(byQuality)[0];
  if (combined) {
    return { videoPath: combined.url, audioPath: "", streamed: false };
  }

  const video = formats
    .filter((format) => hasVideo(format) && !hasAudio(format) && withinQuality(format) && isPlainHttpMedia(format))
    .sort(byQuality)[0];
  const audio = formats
    .filter((format) => hasAudio(format) && !hasVideo(format) && isPlainHttpMedia(format))
    .sort((a, b) => Number(b.abr || b.tbr || 0) - Number(a.abr || a.tbr || 0))[0];

  const streamedCombined = formats
    .filter((format) => hasVideo(format) && hasAudio(format) && withinStreamQuality(format, maxHeight))
    .sort(byQuality)[0];
  if (!video && streamedCombined) {
    return { videoPath: streamedCombined.url, audioPath: "", streamed: true };
  }

  const streamedVideo = formats
    .filter((format) => hasVideo(format) && !hasAudio(format) && withinStreamQuality(format, maxHeight))
    .sort(byQuality)[0];
  const streamedAudio = formats
    .filter((format) => hasAudio(format) && !hasVideo(format))
    .sort((a, b) => Number(b.abr || b.tbr || 0) - Number(a.abr || a.tbr || 0))[0];
  if (!video && streamedVideo) {
    return { videoPath: streamedVideo.url, audioPath: streamedAudio?.url || "", streamed: true };
  }

  if (!video) {
    throw statusError("В источнике не найден видеопоток.", 500);
  }

  return { videoPath: video.url, audioPath: audio?.url || "", streamed: false };
}

async function cutMedia(mediaFiles, start, duration, outputPath, quality = "720") {
  const args = ["-y"];

  if (!mediaFiles.streamed) {
    args.push("-ss", formatSeconds(start), "-t", formatSeconds(duration));
  }
  args.push("-i", mediaFiles.videoPath);
  if (mediaFiles.audioPath && mediaFiles.audioPath !== mediaFiles.videoPath) {
    if (!mediaFiles.streamed) {
      args.push("-ss", formatSeconds(start), "-t", formatSeconds(duration));
    }
    args.push("-i", mediaFiles.audioPath);
    args.push("-map", "0:v:0", "-map", "1:a:0");
  } else {
    args.push("-map", "0:v:0", "-map", "0:a:0?");
  }

  if (mediaFiles.streamed) {
    args.push("-ss", formatSeconds(start), "-t", formatSeconds(duration));
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

async function captureFrame(videoPath, time, outputPath, mediaFiles = {}) {
  const args = ["-y"];
  if (!mediaFiles.streamed) {
    args.push("-ss", formatSeconds(time));
  }
  args.push("-i", videoPath);
  if (mediaFiles.streamed) {
    args.push("-ss", formatSeconds(time));
  }
  args.push(
    "-frames:v",
    "1",
    "-vf",
    "scale=160:90:force_original_aspect_ratio=increase,crop=160:90",
    "-q:v",
    "5",
    "-f",
    "image2",
    "-update",
    "1",
    outputPath
  );
  const result = await runCommand("ffmpeg", args, { timeout: mediaFiles.streamed ? 90000 : 45000 });
  try {
    await assertNonEmptyFile(outputPath);
  } catch (error) {
    throw statusError(result.stderr || error.message, 500);
  }
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

async function assertNonEmptyFile(filePath) {
  const info = await stat(filePath);
  if (!info.size) {
    throw statusError("Фрагмент создан пустым файлом. Файл не сохранен как готовый клип.", 500);
  }
}

async function assertVideoFile(filePath) {
  await assertNonEmptyFile(filePath);
  const streams = await getStreams(filePath);
  if (!streams.includes("video")) {
    throw statusError("Фрагмент создан без видеопотока. Файл не сохранен как готовый клип.", 500);
  }
}

function normalizeQuality(value) {
  const allowed = new Set(["source", "1080", "720", "480"]);
  const quality = String(value || "720");
  return allowed.has(quality) ? quality : "720";
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

function getYtdlpFormat(quality) {
  if (quality === "source") return "bv*+ba/b";
  return `bv*[height<=${quality}]+ba/b[height<=${quality}]/b`;
}

function getMaxHeight(quality) {
  if (quality === "source") return 0;
  return Number(quality) || 720;
}

function withinStreamQuality(format, maxHeight) {
  const safeStreamHeight = maxHeight && maxHeight <= 720 ? maxHeight : 720;
  return !format.height || Number(format.height) <= safeStreamHeight;
}

async function readLibrary() {
  return JSON.parse((await readFile(libraryPath, "utf8")).replace(/^\uFEFF/, ""));
}

async function writeLibrary(library) {
  await writeFile(libraryPath, `${JSON.stringify(library, null, 2)}\n`, "utf8");
}

async function pruneLibrary(library) {
  const ttlMs = clipTtlHours > 0 ? clipTtlHours * 60 * 60 * 1000 : 0;
  const now = Date.now();
  const keep = [];
  const remove = [];

  for (const [index, clip] of library.entries()) {
    const expiredByTtl = ttlMs > 0 && clip.createdAt && now - Date.parse(clip.createdAt) > ttlMs;
    const expiredByCount = maxLocalClips > 0 && index >= maxLocalClips;
    if (expiredByTtl || expiredByCount) {
      remove.push(clip);
    } else {
      keep.push(clip);
    }
  }

  await Promise.all(remove.map((clip) => removeLocalClipFile(clip)));
  return keep;
}

async function removeLocalClipFile(clip) {
  if (!clip.file) return;
  const filePath = resolve(clip.file);
  if (!isPathInside(resolve(clipsDir), filePath)) return;
  try {
    await unlink(filePath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

function isPathInside(baseDir, targetPath) {
  const relation = relative(baseDir, targetPath);
  return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
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

function isDirectVideoUrl(value) {
  return /^https?:\/\/.+\.(mp4|webm|mov)(\?|$)/i.test(value);
}

function isStreamProtocol(value) {
  const protocol = String(value || "");
  return protocol.includes("m3u8") || protocol.includes("dash");
}

function cleanMediaUrl(value) {
  return String(value || "").split(/\r?\n/).find((part) => /^https?:\/\//i.test(part.trim()))?.trim() || "";
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

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
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

function sanitizeDownloadName(value) {
  const clean = String(value || "clip.mp4")
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return clean || "clip.mp4";
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
    const versionArgs = command === "yt-dlp" ? ["--version"] : ["-version"];
    let child;
    try {
      child = spawn(resolveCommand(command), versionArgs, { shell: false });
    } catch {
      resolveCheck(false);
      return;
    }
    child.on("error", () => resolveCheck(false));
    child.on("close", (code) => resolveCheck(code === 0));
  });
}

function runCommand(command, args, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    let child;
    try {
      child = spawn(resolveCommand(command), args, { shell: false });
    } catch (error) {
      rejectRun(error);
      return;
    }
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
  if (commandPaths[command]) {
    makeExecutable(commandPaths[command]);
    return commandPaths[command];
  }
  const localAppData = process.env.LOCALAPPDATA || join(process.env.USERPROFILE || "", "AppData", "Local");
  const candidates = [
    join(localAppData, "Microsoft", "WinGet", "Links", `${command}.exe`),
    ...findWinGetPackageCommands(localAppData, command)
  ];
  commandPaths[command] = candidates.find((candidate) => existsSync(candidate)) || command;
  makeExecutable(commandPaths[command]);
  return commandPaths[command];
}

function makeExecutable(commandPath) {
  if (!commandPath || commandPath === "ffmpeg" || commandPath === "ffprobe" || commandPath === "yt-dlp") return;
  try {
    chmodSync(commandPath, 0o755);
  } catch {
    // Best effort for packaged binaries on serverless platforms.
  }
}

function safeRequire(name) {
  try {
    return require(name);
  } catch {
    return "";
  }
}

function findPackagedYtdlp() {
  const exeName = process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp";
  const packageDir = getPackageDir("youtube-dl-exec");
  const candidates = [
    packageDir ? join(packageDir, "bin", exeName) : "",
    packageDir ? join(packageDir, "bin", "yt-dlp") : "",
    join(rootDir, "node_modules", "youtube-dl-exec", "bin", exeName),
    join(rootDir, "node_modules", "youtube-dl-exec", "bin", "yt-dlp")
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate)) || "";
}

function getPackageDir(name) {
  try {
    return fileURLToPath(new URL(".", import.meta.resolve(`${name}/package.json`)));
  } catch {
    try {
      return require("node:path").dirname(require.resolve(`${name}/package.json`));
    } catch {
      return "";
    }
  }
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

