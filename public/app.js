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
const includeEmbeddedInput = document.querySelector("#includeEmbedded");
const thumbnailEl = document.querySelector("#thumbnail");
const sourceTitleEl = document.querySelector("#sourceTitle");
const sourceMetaEl = document.querySelector("#sourceMeta");
const refreshBtn = document.querySelector("#refreshBtn");
const videoOptionsEl = document.querySelector("#videoOptions");
const qualityInput = document.querySelector("#quality");
const soundEnabledInput = document.querySelector("#soundEnabled");
const tagInput = document.querySelector("#tagInput");
const tagSuggestionsEl = document.querySelector("#tagSuggestions");
const tagChipsEl = document.querySelector("#tagChips");
const qualityOptionEls = [...document.querySelectorAll(".quality-option")];
const hashtagOptionsEl = document.querySelector(".hashtag-options");
const addTagOptionBtn = document.querySelector("#addTagOption");
const filmstripEl = document.querySelector("#filmstrip");
const filmFramesEl = document.querySelector("#filmFrames");
const timeBubbleEl = document.querySelector("#timeBubble");
const previewSelectedRangeEl = document.querySelector("#previewSelectedRange");
const rangeTimeLabelsEl = document.querySelector("#rangeTimeLabels");
const rangeStartLabelEl = document.querySelector("#rangeStartLabel");
const rangeEndLabelEl = document.querySelector("#rangeEndLabel");
const playPreviewBtn = document.querySelector(".play-preview");
const previewVideoEl = document.querySelector("#previewVideo");
const heroImageEl = document.querySelector("#heroImage");
const appShellEl = document.querySelector(".app-shell");
const loadingStateEl = document.querySelector("#loadingState");
const loadingTitleEl = document.querySelector("#loadingTitle");
const loadingDetailEl = document.querySelector("#loadingDetail");
const pasteFromClipboardBtn = document.querySelector("#pasteFromClipboardBtn");
const commandMessageEl = document.querySelector("#commandMessage");
const commandPanelEl = document.querySelector("#introState");
const pasteRowEl = document.querySelector(".paste-row");

let sourceDuration = 30;
let selectedSourceUrl = "";
let selectedPreviewUrl = "";
let selectedPreviewKind = "";
let probeTimer = 0;
let probeToken = 0;
let activeDrag = null;
let currentFilmstripUrl = "";
let canSelectOutputFolder = true;
let configuredTags = ["Motion", "Transition", "Animate", "Flow", "Particles", "Background", "Scenario"];
let selectedTags = ["Transition", "Background"];
let savedTags = [];
let showingAllOptions = false;
let currentOptions = [];
let isSaving = false;
let hlsPlayer = null;
let uiState = "idle";
const isTouchInput = window.matchMedia?.("(pointer: coarse)").matches || navigator.maxTouchPoints > 0;
const prefersNativePaste = isTouchInput
  || navigator.userAgentData?.mobile === true
  || /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

init();

async function init() {
  appShellEl.dataset.nativePaste = prefersNativePaste ? "true" : "false";
  setUiState("idle");
  loadPreferences();
  bindEvents();
  loadSavedTags();
  await loadHashtags();
  renderTags();
  await loadHealth();
  renderClips([]);
  syncRange("range");
}

function bindEvents() {
  startRange.addEventListener("input", () => syncRange("range"));
  endRange.addEventListener("input", () => syncRange("range"));
  startInput.addEventListener("change", () => syncRange("text"));
  endInput.addEventListener("change", () => syncRange("text"));
  startInput.addEventListener("keydown", handleTimeInputKeydown);
  endInput.addEventListener("keydown", handleTimeInputKeydown);
  filmstripEl.addEventListener("pointerdown", startTimelineDrag);
  window.addEventListener("pointermove", moveTimelineDrag);
  window.addEventListener("pointerup", stopTimelineDrag);
  previewVideoEl.addEventListener("timeupdate", stopPreviewAtEnd);
  previewVideoEl.addEventListener("error", () => {
    setMessage("Не удалось открыть предпросмотр. Для некоторых Vimeo/YouTube ссылок временный поток может быть заблокирован браузером.");
  });
  urlInput.addEventListener("input", () => {
    appShellEl.dataset.manualPaste = urlInput.value.trim() ? "false" : appShellEl.dataset.manualPaste;
    probeToken += 1;
    selectedSourceUrl = "";
    selectedPreviewUrl = "";
    selectedPreviewKind = "";
    showingAllOptions = false;
    currentOptions = [];
    videoOptionsEl.hidden = true;
    previewEl.hidden = true;
    if (!urlInput.value.trim()) setUiState("idle");
    scheduleProbe();
  });
  pasteFromClipboardBtn?.addEventListener("click", pasteFromClipboard);
  pasteRowEl?.addEventListener("click", handlePasteRowClick);
  includeEmbeddedInput?.addEventListener("change", () => {
    localStorage.setItem("referenceClipperIncludeEmbedded", includeEmbeddedInput.checked ? "1" : "0");
    if (urlInput.value.trim()) scheduleProbe();
  });
  tagInput?.addEventListener("keydown", handleTagKeydown);
  tagInput?.addEventListener("change", () => addTag(tagInput.value));
  qualityOptionEls.forEach((button) => {
    button.addEventListener("click", () => setQuality(button.dataset.quality));
  });
  addTagOptionBtn?.addEventListener("click", addCustomTag);
  playPreviewBtn.addEventListener("click", playSelectedPreview);
  heroImageEl?.addEventListener("click", playSelectedPreview);
  heroImageEl?.addEventListener("error", () => {
    heroImageEl.src = inlinePlaceholder();
  });
  refreshBtn?.addEventListener("click", () => setMessage("Библиотека отключена: фрагменты сохраняются только на устройство."));
  form.addEventListener("submit", saveClip);
}

function loadPreferences() {
  if (!includeEmbeddedInput) return;
  includeEmbeddedInput.checked = localStorage.getItem("referenceClipperIncludeEmbedded") !== "0";
}

function scheduleProbe() {
  clearTimeout(probeTimer);
  const value = urlInput.value.trim();
  if (!value) {
    setUiState("idle");
    setMessage("");
    return;
  }
  try {
    new URL(value);
  } catch {
    setUiState("idle");
    setMessage("Вставьте полную ссылку.");
    return;
  }
  probeTimer = setTimeout(() => probeSource(), 650);
}

async function pasteFromClipboard(event) {
  event?.preventDefault();
  event?.stopPropagation();
  if (prefersNativePaste && uiState === "idle") {
    focusNativePasteField();
    return;
  }

  if (!navigator.clipboard?.readText) {
    enableManualPasteFallback("Вставьте ссылку вручную.");
    return;
  }

  setMessage("Читаю буфер обмена...");
  try {
    const value = (await readClipboardText()).trim();
    if (!value) {
      setUiState("idle");
      enableManualPasteFallback("Вставьте ссылку в поле.");
      setManualPasteMode(false);
      return;
    }
    setManualPasteMode(false);
    appShellEl.dataset.manualPaste = "false";
    urlInput.value = value;
    await probeSource();
  } catch (error) {
    setUiState("idle");
    enableManualPasteFallback("Вставьте ссылку вручную.");
  }
}

function handlePasteRowClick(event) {
  if (uiState === "loading") return;
  if (event.target === urlInput) return;
  if (prefersNativePaste && uiState === "idle") {
    focusNativePasteField();
    return;
  }
  pasteFromClipboard(event);
}

function readClipboardText() {
  const timeout = new Promise((_, reject) => {
    window.setTimeout(() => reject(new Error("Clipboard timeout")), 8000);
  });
  return Promise.race([navigator.clipboard.readText(), timeout]);
}

function enableManualPasteFallback(message) {
  appShellEl.dataset.manualPaste = "true";
  setMessage(message);
  urlInput.readOnly = false;
  urlInput.placeholder = "Paste URL here";
  urlInput.focus({ preventScroll: true });
}

function focusNativePasteField() {
  appShellEl.dataset.manualPaste = "true";
  setMessage("");
  urlInput.readOnly = false;
  urlInput.placeholder = "Paste from clipboard";
  urlInput.focus({ preventScroll: true });
}

async function chooseOutputFolder() {
  if (!canSelectOutputFolder) return "";
  setMessage("Открываю выбор папки...");
  const data = await fetchJson("/api/select-folder", { method: "POST" });
  if (!data.selected) {
    setMessage("Сохранение отменено: папка не выбрана.");
    return "";
  }
  return data.path;
}

async function loadHealth() {
  const health = await fetchJson("/api/health");
  canSelectOutputFolder = Boolean(health.processing?.canSelectOutputFolder);
  const missing = Object.entries(health.dependencies)
    .filter(([name, ok]) => name !== "node" && !ok)
    .map(([name]) => name);

  if (missing.length) {
    statusEl.textContent = `Нет ${missing.join(", ")}`;
    statusEl.className = "status warning";
  } else {
    statusEl.textContent = "";
    statusEl.className = "status ready";
  }
}

async function probeSource() {
  const token = ++probeToken;
  setUiState("loading", "Загрузка", "Собираю предпросмотр и таймлайн.");
  setMessage("Получаю метаданные...");
  try {
    const data = await fetchJson("/api/probe", {
      method: "POST",
      body: JSON.stringify({
        url: urlInput.value,
        includeEmbedded: includeEmbeddedInput?.checked !== false
      })
    });
    if (token !== probeToken) return;

    renderVideoOptions(data.options?.length ? data.options : [data]);
    await applySource(data);
    setMessage(data.message || "Источник распознан.");
    setUiState("ready");
  } catch (error) {
    setUiState(selectedSourceUrl ? "ready" : "idle");
    setMessage(error.message);
  }
}

async function saveClip(event) {
  event.preventDefault();
  if (isSaving) return;
  isSaving = true;
  setSaveBusy(true);

  try {
    const fileName = suggestedFileName(titleInput.value, selectedTags);
    rememberSelectedTags();
    const fileHandle = await chooseSaveFileHandle(fileName);
    if (fileHandle === null) return;

    setMessage("Готовлю фрагмент...");
    const clip = await fetchJson("/api/clips", {
      method: "POST",
      body: JSON.stringify({
        url: urlInput.value,
        sourceUrl: selectedSourceUrl || urlInput.value,
        title: fileName.replace(/\.mp4$/i, ""),
        start: startInput.value,
        end: endInput.value,
        quality: qualityInput.value,
        includeAudio: soundEnabledInput?.checked !== false
      })
    });
    await saveFileToDevice(clip.downloadUrl || clip.href, fileName, fileHandle);
  } catch (error) {
    setMessage(error.message);
  } finally {
    isSaving = false;
    setSaveBusy(false);
  }
}

function renderVideoOptions(options) {
  currentOptions = options;
  videoOptionsEl.innerHTML = "";
  videoOptionsEl.hidden = !options.length;
  if (!options.length) return;

  const visibleOptions = showingAllOptions ? options : options.slice(0, 5);
  for (const [index, option] of visibleOptions.entries()) {
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
      setUiState("loading", "Переключение", "Обновляю таймлайн.");
      applySource(option)
        .then(() => {
          setUiState("ready");
          setMessage(`Выбрано: ${option.title || option.provider}`);
        })
        .catch((error) => {
          setUiState("ready");
          setMessage(error?.message || `Не удалось переключить источник.`);
        });
    });
    videoOptionsEl.append(item);
  }

  if (options.length > visibleOptions.length) {
    const more = document.createElement("button");
    more.type = "button";
    more.className = "video-option more-option";
    more.textContent = `Показать все видео (${options.length})`;
    more.addEventListener("click", () => {
      showingAllOptions = true;
      renderVideoOptions(currentOptions);
    });
    videoOptionsEl.append(more);
  } else if (options.length > 5) {
    const less = document.createElement("button");
    less.type = "button";
    less.className = "video-option more-option";
    less.textContent = "Свернуть список";
    less.addEventListener("click", () => {
      showingAllOptions = false;
      renderVideoOptions(currentOptions);
    });
    videoOptionsEl.append(less);
  }
}

async function applySource(data) {
  selectedSourceUrl = data.url || urlInput.value;
  selectedPreviewUrl = data.previewUrl || directVideoUrl(selectedSourceUrl);
  selectedPreviewKind = data.previewKind || inferPreviewKind(selectedPreviewUrl);
  sourceDuration = Math.max(1, Number(data.duration || 30));
  startRange.max = sourceDuration;
  endRange.max = sourceDuration;
  startRange.value = 0;
  endRange.value = Math.min(5, sourceDuration);
  titleInput.value = titleInput.value || data.title || "";
  sourceTitleEl.textContent = data.title || data.provider || "Источник";
  sourceMetaEl.textContent = `${data.provider} · ${formatTime(sourceDuration)}`;
  thumbnailEl.src = data.thumbnail || inlinePlaceholder();
  heroImageEl.src = data.thumbnail || inlinePlaceholder();
  renderFilmFrames(data.thumbnail || inlinePlaceholder());
  currentFilmstripUrl = selectedSourceUrl;
  await buildInitialFilmstrip(selectedSourceUrl, sourceDuration, selectedPreviewUrl);
  resetPreviewVideo();
  previewEl.hidden = false;
  syncRange("range");
}

async function buildInitialFilmstrip(sourceUrl, duration, previewUrl) {
  try {
    await buildServerFilmstrip(sourceUrl, duration);
  } catch {
    currentFilmstripUrl = previewUrl;
    if (previewUrl) {
      await buildVideoFilmstrip(previewUrl).catch(() => {});
    }
  }
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
  canvas.width = 640;
  canvas.height = 360;
  const context = canvas.getContext("2d");
  const frames = [];

  for (let index = 0; index < 9; index += 1) {
    video.currentTime = clamp(Math.min(duration - 0.05, (duration * (index + 0.5)) / 9), 0, duration);
    await waitForVideoEvent(video, "seeked", 4000);
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    frames.push(canvas.toDataURL("image/jpeg", 0.88));
  }

  if (currentFilmstripUrl !== url) return;
  updateGeneratedThumbnail(frames[0]);
  filmFramesEl.innerHTML = "";
  for (const src of frames) {
    const frame = document.createElement("span");
    frame.className = "film-frame";
    frame.style.setProperty("--thumb", `url("${src}")`);
    filmFramesEl.append(frame);
  }
}

async function buildServerFilmstrip(url, duration) {
  const filmstripKey = url;
  const data = await fetchJson("/api/frames", {
    method: "POST",
    body: JSON.stringify({ url, duration, count: 9 })
  });
  const frames = Array.isArray(data.frames) ? data.frames.filter(Boolean) : [];
  if (!frames.length || currentFilmstripUrl !== filmstripKey) return;
  renderGeneratedFilmFrames(frames);
}

function renderGeneratedFilmFrames(frames) {
  updateGeneratedThumbnail(frames[0]);
  filmFramesEl.innerHTML = "";
  for (const src of frames) {
    const frame = document.createElement("span");
    frame.className = "film-frame";
    frame.style.setProperty("--thumb", `url("${src}")`);
    filmFramesEl.append(frame);
  }
}

function updateGeneratedThumbnail(src) {
  if (!src) return;
  thumbnailEl.src = src;
  heroImageEl.src = src;
  const activeOptionImage = videoOptionsEl.querySelector(".video-option.active img");
  if (activeOptionImage) activeOptionImage.src = src;
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
    clipsEl.innerHTML = '<div class="message">История не хранится. Каждый фрагмент сохраняется сразу на ваше устройство.</div>';
    return;
  }

  for (const clip of clips) {
    const card = document.createElement("article");
    card.className = "clip";
    card.innerHTML = `
      <strong></strong>
      <span></span>
      <div class="clip-actions">
        <a rel="noreferrer">Скачать</a>
        <button type="button">Удалить</button>
      </div>
    `;
    card.querySelector("strong").textContent = clip.title;
    card.querySelector("span").textContent = `${clip.provider} · ${formatTime(clip.start)} - ${formatTime(clip.end)}`;
    card.querySelector("a").href = `/api/clips/${encodeURIComponent(clip.id)}/file`;
    card.querySelector("a").download = clip.outputName || "reference-clip.mp4";
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
  const right = (end / sourceDuration) * 100;
  const width = ((end - start) / sourceDuration) * 100;
  selectedRange.style.left = `${left}%`;
  selectedRange.style.width = `${width}%`;
  previewSelectedRangeEl.style.left = `${left}%`;
  previewSelectedRangeEl.style.width = `${width}%`;
  rangeTimeLabelsEl.style.setProperty("--range-left", `${left}%`);
  rangeTimeLabelsEl.style.setProperty("--range-right", `${right}%`);
  rangeStartLabelEl.textContent = formatTimeShort(start);
  rangeEndLabelEl.textContent = formatTimeShort(end);
  if (!previewVideoEl.paused) stopPreviewAtEnd();
}

function handleTimeInputKeydown(event) {
  if (event.key !== "Enter") return;
  event.preventDefault();
  syncRange("text");
  event.currentTarget.blur();
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
  await loadPreviewMedia(previewUrl);
  previewVideoEl.hidden = false;
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
    selectedPreviewKind = data.previewKind || inferPreviewKind(selectedPreviewUrl);
    return selectedPreviewUrl;
  } catch (error) {
    setMessage(error.message);
    return "";
  }
}

async function loadPreviewMedia(previewUrl) {
  if (!previewUrl) return;

  const nextKind = selectedPreviewKind || inferPreviewKind(previewUrl);
  teardownPreviewPlayer();

  if (nextKind === "hls") {
    const canPlayNativeHls = previewVideoEl.canPlayType("application/vnd.apple.mpegurl");
    if (canPlayNativeHls) {
      if (previewVideoEl.src !== previewUrl) {
        previewVideoEl.src = previewUrl;
        await waitForPreviewReady();
      }
      return;
    }

    if (window.Hls?.isSupported?.()) {
      hlsPlayer = new window.Hls({
        enableWorker: true,
        lowLatencyMode: false
      });
      hlsPlayer.attachMedia(previewVideoEl);
      await new Promise((resolve, reject) => {
        const onAttached = () => {
          hlsPlayer.off(window.Hls.Events.MEDIA_ATTACHED, onAttached);
          hlsPlayer.loadSource(previewUrl);
        };
        const onManifest = () => {
          hlsPlayer.off(window.Hls.Events.MANIFEST_PARSED, onManifest);
          hlsPlayer.off(window.Hls.Events.ERROR, onError);
          resolve();
        };
        const onError = (_event, data) => {
          if (data?.fatal) {
            hlsPlayer.off(window.Hls.Events.MEDIA_ATTACHED, onAttached);
            hlsPlayer.off(window.Hls.Events.MANIFEST_PARSED, onManifest);
            hlsPlayer.off(window.Hls.Events.ERROR, onError);
            reject(new Error("Не удалось открыть HLS-предпросмотр."));
          }
        };
        hlsPlayer.on(window.Hls.Events.MEDIA_ATTACHED, onAttached);
        hlsPlayer.on(window.Hls.Events.MANIFEST_PARSED, onManifest);
        hlsPlayer.on(window.Hls.Events.ERROR, onError);
      });
      return;
    }

    throw new Error("Этот браузер не поддерживает HLS-предпросмотр.");
  }

  if (previewVideoEl.src !== previewUrl) {
    previewVideoEl.src = previewUrl;
    await waitForPreviewReady();
  }
}

async function waitForPreviewReady() {
  if (previewVideoEl.readyState >= 1) return;
  await waitForVideoEvent(previewVideoEl, "loadedmetadata", 10000);
}

function stopPreviewAtEnd() {
  if (previewVideoEl.currentTime >= Number(endRange.value)) {
    previewVideoEl.pause();
  }
}

function resetPreviewVideo() {
  teardownPreviewPlayer();
  previewVideoEl.pause();
  previewVideoEl.removeAttribute("src");
  previewVideoEl.load();
  previewVideoEl.hidden = true;
}

function teardownPreviewPlayer() {
  if (hlsPlayer) {
    hlsPlayer.destroy();
    hlsPlayer = null;
  }
}

function directVideoUrl(url) {
  return /^https?:\/\/.+\.(mp4|webm|mov)(\?|$)/i.test(url) ? url : "";
}

function inferPreviewKind(url) {
  const value = String(url || "");
  if (!value) return "";
  if (/\.m3u8(\?|$)/i.test(value) || /\/playlist\//i.test(value)) return "hls";
  return "direct";
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

function formatTimeShort(seconds) {
  const minutes = Math.floor(seconds / 60);
  const rest = Math.floor(seconds - minutes * 60);
  return `${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function setMessage(message) {
  messageEl.textContent = message || "";
  commandMessageEl.textContent = message || "";
}

function setSaveBusy(busy) {
  const button = document.querySelector("#saveBtn");
  if (!button) return;
  button.disabled = busy;
  button.innerHTML = busy ? "Preparing..." : '<span aria-hidden="true">↓</span>Export';
}

function setUiState(nextState, title = "", detail = "") {
  const previousState = uiState;
  const applyState = () => {
    uiState = nextState;
    appShellEl.dataset.uiState = nextState;
    if (nextState !== "idle") appShellEl.dataset.manualPaste = "false";
    loadingStateEl.hidden = nextState !== "loading";
    pasteFromClipboardBtn.disabled = nextState === "loading";
    pasteFromClipboardBtn.textContent = "Paste from clipboard";
    urlInput.readOnly = false;

    if (title) {
      loadingTitleEl.textContent = title;
    }
    if (detail) {
      loadingDetailEl.textContent = detail;
    }
  };

  if (document.startViewTransition && previousState !== nextState) {
    document.startViewTransition(applyState);
    return;
  }
  applyState();
}

function setManualPasteMode(enabled) {
  commandPanelEl?.classList.toggle("manual", enabled);
  urlInput.readOnly = false;
}

function setQuality(value) {
  if (!value) return;
  qualityInput.value = value;
  qualityOptionEls.forEach((button) => {
    button.classList.toggle("active", button.dataset.quality === value);
  });
}

function toggleTag(value) {
  const tag = sanitizeTag(value);
  if (!tag) return;
  if (selectedTags.includes(tag)) {
    removeTag(tag);
    return;
  }
  selectedTags.push(tag);
  renderTags();
}

function addCustomTag() {
  const value = window.prompt?.("Tag name");
  if (!value) return;
  const tag = sanitizeTag(value);
  if (!tag) return;
  if (!configuredTags.includes(tag)) {
    configuredTags.push(tag);
    renderHashtagOptions();
  }
  addTag(tag);
}

async function loadHashtags() {
  try {
    const response = await fetch("/hashtags.json", { cache: "no-store" });
    if (!response.ok) throw new Error("Hashtags config not found.");
    const data = await response.json();
    const nextTags = Array.isArray(data.tags) ? data.tags.map(sanitizeTag).filter(Boolean) : [];
    const nextSelected = Array.isArray(data.selected) ? data.selected.map(sanitizeTag).filter(Boolean) : [];
    if (nextTags.length) configuredTags = [...new Set(nextTags)];
    if (nextSelected.length) selectedTags = [...new Set(nextSelected)];
  } catch {
    configuredTags = configuredTags.map(sanitizeTag).filter(Boolean);
  }
  renderHashtagOptions();
}

function renderHashtagOptions() {
  if (!hashtagOptionsEl) return;
  const addButton = addTagOptionBtn;
  hashtagOptionsEl.innerHTML = "";
  for (const tag of configuredTags) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "hashtag-option";
    button.dataset.tag = tag;
    button.textContent = tag;
    button.addEventListener("click", () => toggleTag(tag));
    hashtagOptionsEl.append(button);
  }
  if (addButton) hashtagOptionsEl.append(addButton);
}

async function chooseSaveFileHandle(fileName) {
  if (!("showSaveFilePicker" in window)) return undefined;
  setMessage("Выберите папку и имя файла...");
  try {
    return await window.showSaveFilePicker({
      suggestedName: fileName || "reference-clip.mp4",
      types: [{
        description: "MP4 video",
        accept: { "video/mp4": [".mp4"] }
      }]
    });
  } catch (error) {
    if (error.name === "AbortError") {
      setMessage("Сохранение отменено.");
      return null;
    }
    return undefined;
  }
}

async function saveFileToDevice(url, fileName, fileHandle) {
  if (!url) throw new Error("Сервер не вернул ссылку на готовый фрагмент.");

  if (fileHandle) {
    try {
      setMessage("Скачиваю фрагмент...");
      const response = await fetch(url);
      if (!response.ok) throw new Error("Не удалось скачать готовый фрагмент.");
      const blob = await response.blob();
      const writable = await fileHandle.createWritable();
      try {
        await writable.write(blob);
      } finally {
        await writable.close();
      }
      setMessage("Фрагмент сохранен на устройство.");
      return;
    } catch (error) {
      setMessage("Браузер запретил запись в выбранную папку, запускаю обычное скачивание...");
    }
  }

  triggerDownload(url, fileName);
  setMessage("Фрагмент скачивается на это устройство.");
}

function triggerDownload(url, fileName) {
  if (!url) return;
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName || "reference-clip.mp4";
  link.rel = "noreferrer";
  document.body.append(link);
  link.click();
  link.remove();
}

function suggestedFileName(title, tags = []) {
  const tagPrefix = tags.map(slugFilePart).filter(Boolean).join("_");
  const clean = slugFilePart(title || "reference-clip");
  return `${tagPrefix ? `${tagPrefix}__` : ""}${clean || "reference-clip"}.mp4`;
}

function slugFilePart(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9а-яё]+/giu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 70);
}

function handleTagKeydown(event) {
  if (event.key !== "Enter" && event.key !== ",") return;
  event.preventDefault();
  addTag(tagInput.value);
}

function addTag(value) {
  const tag = sanitizeTag(value);
  if (!tag) return;
  if (!selectedTags.includes(tag)) selectedTags.push(tag);
  tagInput.value = "";
  renderTags();
}

function removeTag(tag) {
  selectedTags = selectedTags.filter((item) => item !== tag);
  renderTags();
}

function renderTags() {
  if (!tagChipsEl) return;
  tagChipsEl.innerHTML = "";
  for (const tag of selectedTags) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = tag;
    button.title = "Убрать тег";
    button.addEventListener("click", () => removeTag(tag));
    tagChipsEl.append(button);
  }
  hashtagOptionsEl?.querySelectorAll(".hashtag-option[data-tag]").forEach((button) => {
    button.classList.toggle("active", selectedTags.includes(sanitizeTag(button.dataset.tag)));
  });

  if (!tagSuggestionsEl) return;
  tagSuggestionsEl.innerHTML = "";
  for (const tag of savedTags) {
    const option = document.createElement("option");
    option.value = tag;
    tagSuggestionsEl.append(option);
  }
}

function loadSavedTags() {
  try {
    savedTags = JSON.parse(localStorage.getItem("referenceClipperTags") || "[]")
      .map(sanitizeTag)
      .filter(Boolean);
  } catch {
    savedTags = [];
  }
}

function rememberSelectedTags() {
  if (!selectedTags.length) return;
  savedTags = [...new Set([...selectedTags, ...savedTags])].slice(0, 40);
  localStorage.setItem("referenceClipperTags", JSON.stringify(savedTags));
  renderTags();
}

function sanitizeTag(value) {
  return String(value || "")
    .trim()
    .replace(/^#+/, "")
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9а-яё_-]+/giu, "")
    .slice(0, 28);
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
