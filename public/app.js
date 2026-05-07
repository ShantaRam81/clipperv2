const form = document.querySelector("#clipForm");
const urlInput = document.querySelector("#url");
const titleInput = document.querySelector("#title");
const startRange = document.querySelector("#startRange");
const endRange = document.querySelector("#endRange");
const startInput = document.querySelector("#start");
const endInput = document.querySelector("#end");
const durationInput = document.querySelector("#duration");
const rangeLabel = document.querySelector("#rangeLabel");
const selectedRange = document.querySelector("#selectedRange");
const statusEl = document.querySelector("#status");
const messageEl = document.querySelector("#message");
const clipsEl = document.querySelector("#clips");
const previewEl = document.querySelector("#sourcePreview");
const thumbnailEl = document.querySelector("#thumbnail");
const sourceTitleEl = document.querySelector("#sourceTitle");
const sourceMetaEl = document.querySelector("#sourceMeta");
const refreshBtn = document.querySelector("#refreshBtn");
const videoOptionsEl = document.querySelector("#videoOptions");
const qualityInput = document.querySelector("#quality");
const filmstripEl = document.querySelector("#filmstrip");
const filmFramesEl = document.querySelector("#filmFrames");
const timeBubbleEl = document.querySelector("#timeBubble");
const previewSelectedRangeEl = document.querySelector("#previewSelectedRange");
const playPreviewBtn = document.querySelector(".play-preview");
const previewVideoEl = document.querySelector("#previewVideo");

let sourceDuration = 30;
let selectedSourceUrl = "";
let selectedPreviewUrl = "";
let probeTimer = 0;
let probeToken = 0;
let activeDrag = null;
let currentFilmstripUrl = "";

init();

async function init() {
  bindEvents();
  await Promise.all([loadHealth(), loadLibrary()]);
  syncRange("range");
}

function bindEvents() {
  startRange.addEventListener("input", () => syncRange("range"));
  endRange.addEventListener("input", () => syncRange("range"));
  startInput.addEventListener("change", () => syncRange("text"));
  endInput.addEventListener("change", () => syncRange("text"));
  filmstripEl.addEventListener("pointerdown", startTimelineDrag);
  window.addEventListener("pointermove", moveTimelineDrag);
  window.addEventListener("pointerup", stopTimelineDrag);
  previewVideoEl.addEventListener("timeupdate", stopPreviewAtEnd);
  previewVideoEl.addEventListener("error", () => {
    setMessage("Не удалось открыть предпросмотр. Для некоторых Vimeo/YouTube ссылок временный поток может быть заблокирован браузером.");
  });
  urlInput.addEventListener("input", () => {
    probeToken += 1;
    selectedSourceUrl = "";
    selectedPreviewUrl = "";
    videoOptionsEl.hidden = true;
    previewEl.hidden = true;
    scheduleProbe();
  });
  playPreviewBtn.addEventListener("click", playSelectedPreview);
  refreshBtn.addEventListener("click", loadLibrary);
  form.addEventListener("submit", saveClip);
}

function scheduleProbe() {
  clearTimeout(probeTimer);
  const value = urlInput.value.trim();
  if (!value) {
    setMessage("");
    return;
  }
  try {
    new URL(value);
  } catch {
    setMessage("Вставьте полную ссылку.");
    return;
  }
  probeTimer = setTimeout(() => probeSource(), 650);
}

async function loadHealth() {
  const health = await fetchJson("/api/health");
  const missing = Object.entries(health.dependencies)
    .filter(([name, ok]) => name !== "node" && !ok)
    .map(([name]) => name);

  if (missing.length) {
    statusEl.textContent = `Нет ${missing.join(", ")}`;
    statusEl.className = "status warning";
  } else if (health.processing?.mode === "remote") {
    statusEl.textContent = "Облачная обработка";
    statusEl.className = "status ready";
  } else {
    statusEl.textContent = "Локальный режим";
    statusEl.className = "status ready";
  }
}

async function probeSource() {
  const token = ++probeToken;
  setMessage("Получаю метаданные...");
  try {
    const data = await fetchJson("/api/probe", {
      method: "POST",
      body: JSON.stringify({ url: urlInput.value })
    });
    if (token !== probeToken) return;

    renderVideoOptions(data.options || []);
    applySource(data);
    setMessage(data.message || "Источник распознан.");
  } catch (error) {
    setMessage(error.message);
  }
}

async function saveClip(event) {
  event.preventDefault();
  try {
    setMessage("Готовлю фрагмент...");
    const clip = await fetchJson("/api/clips", {
      method: "POST",
      body: JSON.stringify({
        url: urlInput.value,
        sourceUrl: selectedSourceUrl || urlInput.value,
        title: titleInput.value,
        start: startInput.value,
        end: endInput.value,
        quality: qualityInput.value
      })
    });
    setMessage(`Сохранено: ${clip.outputName || clip.href}`);
    await loadLibrary();
  } catch (error) {
    setMessage(error.message);
  }
}

function renderVideoOptions(options) {
  videoOptionsEl.innerHTML = "";
  videoOptionsEl.hidden = !options.length;
  if (!options.length) return;

  for (const [index, option] of options.entries()) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = `video-option${index === 0 ? " active" : ""}`;
    item.innerHTML = `
      <input type="radio" name="videoOption" ${index === 0 ? "checked" : ""}>
      <img alt="">
      <div>
        <strong></strong>
        <span></span>
      </div>
    `;
    item.querySelector("img").src = option.thumbnail || inlinePlaceholder();
    item.querySelector("strong").textContent = option.title || `Видео ${index + 1}`;
    item.querySelector("span").textContent = `${option.provider} · ${formatTime(option.duration || 30)}`;
    item.addEventListener("click", () => {
      for (const sibling of videoOptionsEl.querySelectorAll(".video-option")) {
        sibling.classList.remove("active");
        sibling.querySelector("input").checked = false;
      }
      item.classList.add("active");
      item.querySelector("input").checked = true;
      applySource(option);
      setMessage(`Выбрано: ${option.title || option.provider}`);
    });
    videoOptionsEl.append(item);
  }
}

function applySource(data) {
  selectedSourceUrl = data.url || urlInput.value;
  selectedPreviewUrl = data.previewUrl || directVideoUrl(selectedSourceUrl);
  sourceDuration = Math.max(1, Number(data.duration || 30));
  startRange.max = sourceDuration;
  endRange.max = sourceDuration;
  startRange.value = 0;
  endRange.value = Math.min(5, sourceDuration);
  titleInput.value = titleInput.value || data.title || "";
  sourceTitleEl.textContent = data.title || data.provider || "Источник";
  sourceMetaEl.textContent = `${data.provider} · ${formatTime(sourceDuration)}`;
  thumbnailEl.src = data.thumbnail || inlinePlaceholder();
  renderFilmFrames(data.thumbnail || inlinePlaceholder());
  currentFilmstripUrl = selectedPreviewUrl;
  if (selectedPreviewUrl) buildVideoFilmstrip(selectedPreviewUrl).catch(() => {});
  resetPreviewVideo();
  previewEl.hidden = false;
  syncRange("range");
}

function renderFilmFrames(thumbnail) {
  filmFramesEl.innerHTML = "";
  const count = 9;
  for (let index = 0; index < count; index += 1) {
    const frame = document.createElement("span");
    frame.className = "film-frame";
    frame.style.setProperty("--thumb", `url("${thumbnail}")`);
    frame.style.backgroundPosition = `${Math.round((index / Math.max(1, count - 1)) * 100)}% center`;
    filmFramesEl.append(frame);
  }
}

async function buildVideoFilmstrip(url) {
  if (!directVideoUrl(url)) return;

  const video = document.createElement("video");
  video.crossOrigin = "anonymous";
  video.muted = true;
  video.playsInline = true;
  video.preload = "metadata";
  video.src = url;

  await waitForVideoEvent(video, "loadedmetadata", 5000);
  const duration = Math.min(video.duration || sourceDuration, sourceDuration);
  const canvas = document.createElement("canvas");
  canvas.width = 160;
  canvas.height = 90;
  const context = canvas.getContext("2d");
  const frames = [];

  for (let index = 0; index < 9; index += 1) {
    video.currentTime = clamp(Math.min(duration - 0.05, (duration * (index + 0.5)) / 9), 0, duration);
    await waitForVideoEvent(video, "seeked", 4000);
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    frames.push(canvas.toDataURL("image/jpeg", 0.7));
  }

  if (currentFilmstripUrl !== url) return;
  filmFramesEl.innerHTML = "";
  for (const src of frames) {
    const frame = document.createElement("span");
    frame.className = "film-frame";
    frame.style.setProperty("--thumb", `url("${src}")`);
    filmFramesEl.append(frame);
  }
}

function waitForVideoEvent(video, eventName, timeout) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => cleanup(reject), timeout);
    const onEvent = () => cleanup(resolve);
    const onError = () => cleanup(reject);
    const cleanup = (finish) => {
      clearTimeout(timer);
      video.removeEventListener(eventName, onEvent);
      video.removeEventListener("error", onError);
      finish();
    };
    video.addEventListener(eventName, onEvent, { once: true });
    video.addEventListener("error", onError, { once: true });
  });
}

async function loadLibrary() {
  try {
    const clips = await fetchJson("/api/library");
    renderClips(clips);
  } catch (error) {
    setMessage(error.message);
  }
}

function renderClips(clips) {
  clipsEl.innerHTML = "";
  if (!clips.length) {
    clipsEl.innerHTML = '<div class="message">Пока нет сохраненных фрагментов.</div>';
    return;
  }

  for (const clip of clips) {
    const card = document.createElement("article");
    card.className = "clip";
    card.innerHTML = `
      <strong></strong>
      <span></span>
      <div class="clip-actions">
        <a target="_blank" rel="noreferrer">Открыть</a>
        <button type="button">Удалить</button>
      </div>
    `;
    card.querySelector("strong").textContent = clip.title;
    card.querySelector("span").textContent = `${clip.provider} · ${formatTime(clip.start)} - ${formatTime(clip.end)}`;
    card.querySelector("a").href = clip.href;
    card.querySelector("button").addEventListener("click", () => deleteClip(clip.id));
    clipsEl.append(card);
  }
}

async function deleteClip(id) {
  setMessage("Удаляю запись...");
  try {
    await fetchJson(`/api/clips/${encodeURIComponent(id)}`, { method: "DELETE" });
    setMessage("Запись удалена.");
    await loadLibrary();
  } catch (error) {
    setMessage(error.message);
  }
}

function syncRange(source) {
  if (source === "text") {
    startRange.value = clamp(parseTime(startInput.value), 0, sourceDuration);
    endRange.value = clamp(parseTime(endInput.value), 0, sourceDuration);
  }

  let start = Number(startRange.value);
  let end = Number(endRange.value);

  if (end <= start) {
    if (document.activeElement === startRange) {
      start = Math.max(0, end - 0.1);
      startRange.value = start;
    } else {
      end = Math.min(sourceDuration, start + 0.1);
      endRange.value = end;
    }
  }

  startInput.value = formatTime(start);
  endInput.value = formatTime(end);
  durationInput.value = `${(end - start).toFixed(1)} сек`;
  rangeLabel.textContent = `${formatTime(start)} - ${formatTime(end)}`;
  timeBubbleEl.textContent = formatTime(end);

  const left = (start / sourceDuration) * 100;
  const width = ((end - start) / sourceDuration) * 100;
  selectedRange.style.left = `${left}%`;
  selectedRange.style.width = `${width}%`;
  previewSelectedRangeEl.style.left = `${left}%`;
  previewSelectedRangeEl.style.width = `${width}%`;
  if (!previewVideoEl.paused) stopPreviewAtEnd();
}

function startTimelineDrag(event) {
  if (!selectedSourceUrl) return;
  const rect = filmstripEl.getBoundingClientRect();
  const selectedRect = previewSelectedRangeEl.getBoundingClientRect();
  const start = Number(startRange.value);
  const end = Number(endRange.value);
  const pointerTime = positionToTime(event.clientX, rect);
  const edge = event.target.dataset.edge;
  let mode = edge || "move";

  if (!edge && event.target === previewSelectedRangeEl) {
    if (Math.abs(event.clientX - selectedRect.left) < 18) mode = "start";
    if (Math.abs(event.clientX - selectedRect.right) < 18) mode = "end";
  }

  if (!edge && event.target !== previewSelectedRangeEl) {
    const distanceToStart = Math.abs(pointerTime - start);
    const distanceToEnd = Math.abs(pointerTime - end);
    mode = distanceToStart < distanceToEnd ? "start" : "end";
  }

  activeDrag = {
    mode,
    rect,
    pointerStart: pointerTime,
    start,
    end,
    duration: end - start
  };
  filmstripEl.setPointerCapture?.(event.pointerId);
  event.preventDefault();
  moveTimelineDrag(event);
}

function moveTimelineDrag(event) {
  if (!activeDrag) return;
  const time = positionToTime(event.clientX, activeDrag.rect);
  let start = activeDrag.start;
  let end = activeDrag.end;

  if (activeDrag.mode === "start") {
    start = clamp(time, 0, end - 0.1);
  } else if (activeDrag.mode === "end") {
    end = clamp(time, start + 0.1, sourceDuration);
  } else {
    const delta = time - activeDrag.pointerStart;
    start = clamp(activeDrag.start + delta, 0, sourceDuration - activeDrag.duration);
    end = start + activeDrag.duration;
  }

  startRange.value = start;
  endRange.value = end;
  syncRange("range");
}

function stopTimelineDrag() {
  activeDrag = null;
}

function positionToTime(clientX, rect) {
  const ratio = clamp((clientX - rect.left) / rect.width, 0, 1);
  return ratio * sourceDuration;
}

async function playSelectedPreview() {
  if (!selectedSourceUrl) {
    setMessage("Сначала вставьте ссылку и выберите видео.");
    return;
  }

  const previewUrl = await getPreviewSource();
  if (!previewUrl) return;

  const start = Number(startRange.value);
  previewVideoEl.hidden = false;
  if (previewVideoEl.src !== previewUrl) {
    previewVideoEl.src = previewUrl;
  }
  previewVideoEl.currentTime = start;

  try {
    await previewVideoEl.play();
    setMessage(`Предпросмотр: ${startInput.value} - ${endInput.value}`);
  } catch {
    setMessage("Не удалось запустить предпросмотр. Попробуйте сохранить фрагмент или обновить временную ссылку.");
  }
}

async function getPreviewSource() {
  if (selectedPreviewUrl) return selectedPreviewUrl;

  setMessage("Получаю временный поток для предпросмотра...");
  try {
    const data = await fetchJson("/api/preview", {
      method: "POST",
      body: JSON.stringify({ url: selectedSourceUrl })
    });
    selectedPreviewUrl = data.previewUrl || "";
    return selectedPreviewUrl;
  } catch (error) {
    setMessage(error.message);
    return "";
  }
}

function stopPreviewAtEnd() {
  if (previewVideoEl.currentTime >= Number(endRange.value)) {
    previewVideoEl.pause();
  }
}

function resetPreviewVideo() {
  previewVideoEl.pause();
  previewVideoEl.removeAttribute("src");
  previewVideoEl.load();
  previewVideoEl.hidden = true;
}

function directVideoUrl(url) {
  return /^https?:\/\/.+\.(mp4|webm|mov)(\?|$)/i.test(url) ? url : "";
}

function parseTime(value) {
  const clean = String(value).replace(",", ".").trim();
  if (!clean.includes(":")) return Number(clean) || 0;
  return clean.split(":").map(Number).reduce((total, part) => total * 60 + part, 0);
}

function formatTime(seconds) {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds - minutes * 60;
  return `${String(minutes).padStart(2, "0")}:${rest.toFixed(1).padStart(4, "0")}`;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function setMessage(message) {
  messageEl.textContent = message || "";
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...options
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Ошибка запроса");
  return data;
}

function inlinePlaceholder() {
  return "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 160 90'%3E%3Crect width='160' height='90' fill='%2318191c'/%3E%3Cpath d='M68 30l30 15-30 15z' fill='%238b8d96'/%3E%3C/svg%3E";
}
