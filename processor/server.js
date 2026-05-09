import { createServer } from "node:http";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, stat, unlink, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

const port = Number(process.env.PORT || 8080);
const publicBaseUrl = (process.env.PUBLIC_BASE_URL || `http://localhost:${port}`).replace(/\/$/, "");
const token = process.env.PROCESSOR_TOKEN || "";
const storageDir = process.env.STORAGE_DIR || "/opt/clipper-processor/storage";
const clipsDir = join(storageDir, "clips");
const tempDir = join(storageDir, "tmp");
const clipTtlMs = Number(process.env.CLIP_TTL_MINUTES || 60) * 60 * 1000;

const mimeTypes = {
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".json": "application/json; charset=utf-8"
};

await ensureStorage();
cleanupOldClips().catch((error) => console.warn(`Could not clean old clips: ${error.message}`));
setInterval(() => cleanupOldClips().catch((error) => console.warn(`Could not clean old clips: ${error.message}`)), 15 * 60 * 1000).unref();

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === "GET" && url.pathname === "/api/health") {
      return sendJson(res, {
        ok: true,
        dependencies: {
          ffmpeg: await hasCommand("ffmpeg"),
          "yt-dlp": await hasCommand("yt-dlp"),
          deno: await hasCommand("deno")
        }
      });
    }

    if (req.method === "GET" && url.pathname.startsWith("/clips/")) {
      return serveClip(url.pathname, res);
    }

    if (req.method === "DELETE" && url.pathname.startsWith("/clips/")) {
      authorize(req);
      return sendJson(res, await deleteClip(url.pathname));
    }

    if (req.method === "POST" && url.pathname === "/api/process") {
      authorize(req);
      const body = await readJson(req);
      if (body.action === "probe") {
        return sendJson(res, await probeSource(body.url));
      }
      if (body.action === "frames") {
        return sendJson(res, await createFrames(body));
      }
      return sendJson(res, await createClip(body), 201);
    }

    sendJson(res, { error: "Not found" }, 404);
  } catch (error) {
    sendJson(res, { error: error.message || "Unexpected error" }, error.status || 500);
  }
}).listen(port, () => {
  console.log(`Clipper processor listening on ${port}`);
});

async function ensureStorage() {
  await mkdir(clipsDir, { recursive: true });
  await mkdir(tempDir, { recursive: true });
}

function authorize(req) {
  if (!token) return;
  const header = req.headers.authorization || "";
  if (header !== `Bearer ${token}`) {
    throw statusError("Unauthorized", 401);
  }
}

async function probeSource(sourceUrl) {
  const parsedUrl = validateUrl(sourceUrl);
  const provider = detectProvider(parsedUrl.href);

  if (provider === "Behance") {
    const options = await discoverBehanceVideos(parsedUrl.href);
    if (!options.length) {
      throw statusError("В этом Behance-кейсе не найдено поддерживаемое видео.", 404);
    }
    const enriched = await enrichVideoOptions(options);
    return {
      ...enriched[0],
      options: enriched,
      pageUrl: parsedUrl.href,
      message: `Найдено видео в кейсе: ${enriched.length}. Выберите нужный ролик.`
    };
  }

  const info = await getYtdlpInfo(parsedUrl.href);
  const preview = getPreviewSource(info);
  return {
    url: parsedUrl.href,
    previewUrl: preview.url,
    previewKind: preview.kind,
    provider,
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

  if (duration <= 0) throw statusError("Конец фрагмента должен быть позже начала.", 400);
  if (duration > 60) throw statusError("Фрагмент должен быть до 60 секунд.", 400);

  const id = randomUUID();
  const outputName = `${safeFileName(title)}-${id.slice(0, 8)}.mp4`;
  const outputPath = join(clipsDir, outputName);

  try {
    const mediaFiles = await resolveMediaFiles(sourceUrl.href, quality);
    await cutMedia(mediaFiles, start, duration, outputPath, quality);
    await assertVideoFile(outputPath);
  } catch (error) {
    await unlink(outputPath).catch(() => {});
    throw error;
  }

  return {
    id,
    title,
    outputName,
    href: `${publicBaseUrl}/clips/${encodeURIComponent(outputName)}`,
    publicUrl: `${publicBaseUrl}/clips/${encodeURIComponent(outputName)}`,
    createdAt: new Date().toISOString()
  };
}

async function createFrames(input) {
  const sourceUrl = validateUrl(input.url || input.sourceUrl);
  const duration = Math.max(1, Number(input.duration || 30));
  const count = Math.min(12, Math.max(3, Number(input.count || 9)));
  const id = randomUUID();
  const mediaFiles = await resolveMediaFiles(sourceUrl.href, "480");
  const frames = [];

  try {
    for (let index = 0; index < count; index += 1) {
      const time = clamp((duration * (index + 0.5)) / count, 0, Math.max(0, duration - 0.05));
      const framePath = join(tempDir, `${id}-${index}.jpg`);
      await captureFrame(mediaFiles.videoPath, time, framePath, mediaFiles);
      const data = await readFile(framePath);
      frames.push(`data:image/jpeg;base64,${data.toString("base64")}`);
      await unlink(framePath).catch(() => {});
    }
  } finally {
    await cleanupTempFiles(id);
  }

  if (!frames.length) throw statusError("Не удалось построить кадры таймлайна.", 502);
  return { frames };
}

async function discoverBehanceVideos(pageUrl) {
  const response = await fetch(pageUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ReferenceClipper/1.0",
      "Accept": "text/html,application/xhtml+xml"
    }
  });
  if (!response.ok) throw statusError(`Behance вернул статус ${response.status}.`, 502);

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
      const info = await getYtdlpInfo(option.url);
      const preview = getPreviewSource(info);
      enriched.push({
        id: `${option.provider.toLowerCase()}-${index}`,
        url: option.url,
        previewUrl: preview.url,
        previewKind: preview.kind,
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
      "User-Agent": "Mozilla/5.0 ReferenceClipper/1.0",
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
    previewUrl: mp4Url,
    provider: "Adobe CCV",
    title: `Adobe CCV video ${index + 1}`,
    duration,
    thumbnail: poster || "",
    canDownload: true
  };
}

async function resolveMediaFiles(sourceUrl, quality) {
  if (isDirectVideoUrl(sourceUrl)) return { videoPath: sourceUrl, audioPath: "" };

  const info = await getYtdlpInfo(sourceUrl);
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
  if (combined) return { videoPath: combined.url, audioPath: "", streamed: false };

  const video = formats
    .filter((format) => hasVideo(format) && !hasAudio(format) && withinQuality(format) && isPlainHttpMedia(format))
    .sort(byQuality)[0];
  const audio = formats
    .filter((format) => hasAudio(format) && !hasVideo(format) && isPlainHttpMedia(format))
    .sort((a, b) => Number(b.abr || b.tbr || 0) - Number(a.abr || a.tbr || 0))[0];
  const streamedCombined = formats
    .filter((format) => hasVideo(format) && hasAudio(format) && withinStreamQuality(format, maxHeight))
    .sort(byQuality)[0];
  if (!video && streamedCombined) return { videoPath: streamedCombined.url, audioPath: "", streamed: true };
  const streamedVideo = formats
    .filter((format) => hasVideo(format) && !hasAudio(format) && withinStreamQuality(format, maxHeight))
    .sort(byQuality)[0];
  const streamedAudio = formats
    .filter((format) => hasAudio(format) && !hasVideo(format))
    .sort((a, b) => Number(b.abr || b.tbr || 0) - Number(a.abr || a.tbr || 0))[0];
  if (!video && streamedVideo) return { videoPath: streamedVideo.url, audioPath: streamedAudio?.url || "", streamed: true };
  if (!video) throw statusError("В источнике не найден видеопоток.", 500);
  return { videoPath: video.url, audioPath: audio?.url || "", streamed: false };
}

async function getYtdlpInfo(url) {
  const result = await runCommand("yt-dlp", [
    "--dump-json",
    "--no-playlist",
    "--js-runtimes",
    "deno",
    "--remote-components",
    "ejs:github",
    url
  ], { timeout: 60000 });
  return JSON.parse(result.stdout);
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
  if (maxHeight) args.push("-vf", `scale=-2:min(${maxHeight}\\,ih)`);
  args.push("-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", "-movflags", "+faststart", outputPath);
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

  const result = await runCommand("ffmpeg", [
    ...args
  ], { timeout: mediaFiles.streamed ? 90000 : 45000 });
  try {
    await assertNonEmptyFile(outputPath);
  } catch (error) {
    throw statusError(result.stderr || error.message, 500);
  }
}

async function captureSourceFrame(sourceUrl, time, outputPath) {
  const id = randomUUID();
  const sectionStart = Math.max(0, time - 0.25);
  const sectionEnd = time + 0.75;
  const outputTemplate = join(tempDir, `${id}.%(ext)s`);

  try {
    await runCommand("yt-dlp", [
      "--no-playlist",
      "--js-runtimes",
      "deno",
      "--remote-components",
      "ejs:github",
      "--download-sections",
      `*${formatSeconds(sectionStart)}-${formatSeconds(sectionEnd)}`,
      "--force-keyframes-at-cuts",
      "-f",
      "bv*[height<=480]/b[height<=480]/b",
      "--merge-output-format",
      "mp4",
      "-o",
      outputTemplate,
      sourceUrl
    ], { timeout: 120000 });

    const samplePath = await findTempFile(id);
    await captureFrame(samplePath, 0, outputPath);
  } finally {
    await cleanupTempFiles(id);
  }
}

async function assertNonEmptyFile(filePath) {
  const info = await stat(filePath);
  if (!info.size) throw statusError("Фрагмент создан пустым файлом.", 500);
}

async function assertVideoFile(filePath) {
  await assertNonEmptyFile(filePath);
  const result = await runCommand("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "stream=codec_type",
    "-of",
    "csv=p=0",
    filePath
  ], { timeout: 30000 });
  const streams = result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!streams.includes("video")) {
    throw statusError("Фрагмент создан без видеопотока.", 500);
  }
}

function getPreviewSource(info) {
  if (typeof info.url === "string" && /^https?:\/\//i.test(info.url)) {
    return {
      url: info.url,
      kind: isStreamProtocol(info.protocol) ? "hls" : "direct"
    };
  }
  const requested = [
    ...(Array.isArray(info.requested_downloads) ? info.requested_downloads : []),
    ...(Array.isArray(info.requested_formats) ? info.requested_formats : []),
    ...(Array.isArray(info.formats) ? info.formats : [])
  ];
  const directPlayable = requested.find((format) => {
    if (!format?.url || !/^https?:\/\//i.test(format.url)) return false;
    if (format.vcodec === "none") return false;
    const protocol = String(format.protocol || "");
    return !isStreamProtocol(protocol);
  });
  if (directPlayable?.url) {
    return { url: directPlayable.url, kind: "direct" };
  }

  const streamPlayable = requested.find((format) => {
    if (!format?.url || !/^https?:\/\//i.test(format.url)) return false;
    if (format.vcodec === "none") return false;
    return isStreamProtocol(format.protocol);
  });
  if (streamPlayable?.url) {
    return { url: streamPlayable.url, kind: "hls" };
  }

  return { url: "", kind: "" };
}

function runCommand(command, args, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { shell: false });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      rejectRun(statusError(`${command} не ответил вовремя.`, 504));
    }, options.timeout || 60000);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", rejectRun);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolveRun({ stdout, stderr });
      else rejectRun(statusError(stderr || `${command} завершился с кодом ${code}`, 500));
    });
  });
}

function hasCommand(command) {
  return new Promise((resolveCheck) => {
    const child = spawn(command, command === "yt-dlp" ? ["--version"] : ["-version"], { shell: false });
    child.on("error", () => resolveCheck(false));
    child.on("close", (code) => resolveCheck(code === 0));
  });
}

function serveClip(pathname, res) {
  const fileName = decodeURIComponent(pathname.replace("/clips/", ""));
  const filePath = resolve(clipsDir, `./${fileName}`);
  if (!filePath.startsWith(resolve(clipsDir))) return sendJson(res, { error: "Forbidden" }, 403);
  createReadStream(filePath)
    .on("error", () => sendJson(res, { error: "Clip not found" }, 404))
    .once("open", () => res.writeHead(200, {
      "Content-Type": mimeTypes[extname(filePath)] || "application/octet-stream",
      "Content-Disposition": `attachment; filename="${encodeURIComponent(fileName || "clip.mp4")}"`,
      "Cache-Control": "no-store"
    }))
    .pipe(res);
}

async function deleteClip(pathname) {
  const fileName = decodeURIComponent(pathname.replace("/clips/", ""));
  const filePath = resolve(clipsDir, `./${fileName}`);
  if (!filePath.startsWith(resolve(clipsDir))) throw statusError("Forbidden", 403);
  await unlink(filePath).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
  return { deleted: true };
}

async function cleanupOldClips() {
  if (clipTtlMs <= 0) return;
  const now = Date.now();
  const entries = await readdir(clipsDir, { withFileTypes: true });
  await Promise.all(entries
    .filter((entry) => entry.isFile())
    .map(async (entry) => {
      const filePath = join(clipsDir, entry.name);
      const info = await stat(filePath);
      if (now - info.mtimeMs > clipTtlMs) {
        await unlink(filePath).catch(() => {});
      }
    }));
}

async function cleanupTempFiles(id) {
  const entries = await readdir(tempDir, { withFileTypes: true }).catch(() => []);
  await Promise.all(entries
    .filter((entry) => entry.isFile() && (entry.name.startsWith(`${id}-`) || entry.name.startsWith(`${id}.`)))
    .map((entry) => unlink(join(tempDir, entry.name)).catch(() => {})));
}

async function findTempFile(id) {
  const entries = await readdir(tempDir, { withFileTypes: true });
  const entry = entries.find((item) => item.isFile() && item.name.startsWith(`${id}.`));
  if (!entry) throw statusError("Не удалось получить временный фрагмент для кадра.", 502);
  return join(tempDir, entry.name);
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

function matchFirst(value, pattern) {
  const match = value.match(pattern);
  return match ? match[1].replace(/&amp;/g, "&") : "";
}

function addVideoCandidate(candidates, url, provider) {
  const cleanUrl = provider === "Vimeo" ? normalizeVimeoUrl(url) : url.replace(/&amp;/g, "&");
  if (!isGif(cleanUrl)) candidates.set(getVideoCandidateKey(cleanUrl, provider), { url: cleanUrl, provider });
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

function normalizeQuality(value) {
  const allowed = new Set(["source", "1080", "720", "480"]);
  const quality = String(value || "720");
  return allowed.has(quality) ? quality : "720";
}

function getMaxHeight(quality) {
  if (quality === "source") return 0;
  return Number(quality) || 720;
}

function withinStreamQuality(format, maxHeight) {
  const safeStreamHeight = maxHeight && maxHeight <= 720 ? maxHeight : 720;
  return !format.height || Number(format.height) <= safeStreamHeight;
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

function statusError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}
