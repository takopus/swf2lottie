const fileInput = document.getElementById("file-input");
const status = document.getElementById("status");
const workspace = document.getElementById("workspace");
const previewStage = document.getElementById("preview-stage");
const preview = document.getElementById("preview");
const toolbarPlay = document.getElementById("toolbar-play");
const firstFrameButton = document.getElementById("first-frame");
const prevFrameButton = document.getElementById("prev-frame");
const nextFrameButton = document.getElementById("next-frame");
const zoomInButton = document.getElementById("zoom-in");
const zoomOutButton = document.getElementById("zoom-out");
const zoomFitButton = document.getElementById("zoom-fit");
const zoomResetButton = document.getElementById("zoom-reset");
const frameReadout = document.getElementById("frame-readout");
const summary = document.getElementById("summary");
const issueCounts = document.getElementById("issue-counts");
const toggleOutput = document.getElementById("toggle-output");
const outputPanel = document.getElementById("output-panel");
const outputJson = document.getElementById("output-json");
const bitmapStorageInput = document.getElementById("bitmap-storage");
const fpsInput = document.getElementById("fps-input");
const widthInput = document.getElementById("width-input");
const heightInput = document.getElementById("height-input");
const updatePreviewButton = document.getElementById("update-preview");
const saveJsonButton = document.getElementById("save-json");
const savedOutput = document.getElementById("saved-output");
const recentGrid = document.getElementById("recent-grid");

const recentEntries = [];
const recentCardAnimations = [];

let selectedFile = null;
let currentAnimationInstance = null;
let currentSourceName = null;
let currentBaseAnimation = null;
let currentWorkingAnimation = null;
let currentBitmapAssets = [];
let currentIssues = [];
let currentZoom = 1;
let currentFrame = 0;
let isPlaying = false;

window.addEventListener("pageshow", () => {
  clearWorkspace();
});

fileInput.addEventListener("change", () => {
  selectedFile = fileInput.files?.[0] ?? null;
  clearWorkspace();

  if (!selectedFile) {
    status.textContent = "No file selected.";
    return;
  }

  void convertSelectedFile();
});

async function convertSelectedFile() {
  if (!selectedFile) {
    return;
  }

  status.textContent = `Converting ${selectedFile.name}...`;
  savedOutput.hidden = true;

  try {
    const response = await fetch(`/api/convert?filename=${encodeURIComponent(selectedFile.name)}`, {
      method: "POST",
      body: await selectedFile.arrayBuffer(),
      headers: {
        "content-type": "application/octet-stream"
      }
    });

    const payload = await response.json();
    if (!response.ok || !payload.ok || !payload.animation) {
      destroyPreviewAnimation();
      workspace.hidden = true;
      outputPanel.hidden = true;
      status.textContent = payload.message ?? "Conversion failed.";
      return;
    }

    currentSourceName = selectedFile.name;
    currentIssues = payload.issues ?? [];
    currentBaseAnimation = structuredClone(payload.animation);
    currentWorkingAnimation = structuredClone(payload.animation);
    currentBitmapAssets = Array.isArray(payload.bitmapAssets) ? structuredClone(payload.bitmapAssets) : [];
    renderWorkspace();
    status.textContent = `Converted ${selectedFile.name}.`;
  } catch (error) {
    clearWorkspace();
    status.textContent = error instanceof Error ? error.message : "Conversion failed.";
  }
}

toolbarPlay.addEventListener("click", togglePlayback);
firstFrameButton.addEventListener("click", () => goToFrame(0));
prevFrameButton.addEventListener("click", () => goToFrame(Math.max(0, currentFrame - 1)));
nextFrameButton.addEventListener("click", () => goToFrame(currentFrame + 1));
zoomInButton.addEventListener("click", () => setZoom(currentZoom + 0.25));
zoomOutButton.addEventListener("click", () => setZoom(Math.max(0.5, currentZoom - 0.25)));
zoomFitButton.addEventListener("click", fitZoom);
zoomResetButton.addEventListener("click", () => setZoom(1));

toggleOutput.addEventListener("click", () => {
  const visible = outputPanel.hidden;
  outputPanel.hidden = !visible;
  toggleOutput.textContent = visible ? "Hide output" : "Show output";
});

fpsInput.addEventListener("input", markDirty);
widthInput.addEventListener("input", markDirty);
heightInput.addEventListener("input", markDirty);
updatePreviewButton.addEventListener("click", applyPreviewEdits);
saveJsonButton.addEventListener("click", saveCurrentAnimation);

function clearWorkspace() {
  destroyPreviewAnimation();
  currentSourceName = null;
  currentBaseAnimation = null;
  currentWorkingAnimation = null;
  currentBitmapAssets = [];
  currentIssues = [];
  currentZoom = 1;
  currentFrame = 0;
  isPlaying = false;
  workspace.hidden = true;
  outputPanel.hidden = true;
  outputJson.textContent = "";
  toggleOutput.hidden = true;
  toggleOutput.textContent = "Show output";
  bitmapStorageInput.value = "inline";
  fpsInput.value = "";
  widthInput.value = "";
  heightInput.value = "";
  updatePreviewButton.disabled = true;
  saveJsonButton.disabled = true;
  savedOutput.hidden = true;
  savedOutput.textContent = "";
  summary.textContent = "No converted file selected.";
  issueCounts.textContent = "0 warnings, 0 errors";
  frameReadout.textContent = "Frame 0";
  previewStage.style.width = "";
  previewStage.style.height = "";
  preview.style.width = "";
  preview.style.height = "";
  preview.style.transform = "";
}

function renderWorkspace() {
  if (!currentWorkingAnimation) {
    clearWorkspace();
    return;
  }

  workspace.hidden = false;
  outputJson.textContent = JSON.stringify(currentWorkingAnimation, null, 2);
  fpsInput.value = formatNumber(currentWorkingAnimation.fr);
  widthInput.value = String(currentWorkingAnimation.w);
  heightInput.value = String(currentWorkingAnimation.h);
  updatePreviewButton.disabled = true;
  saveJsonButton.disabled = false;
  savedOutput.hidden = true;
  renderSummary();
  updateStageSize();
  renderPreviewAnimation();
}

function renderSummary() {
  if (!currentWorkingAnimation) {
    return;
  }

  const warningCount = currentIssues.filter((issue) => issue.severity === "warning").length;
  const errorCount = currentIssues.filter((issue) => issue.severity === "error").length;
  const hasIssues = warningCount + errorCount > 0;
  const sourceLabel = currentSourceName ?? "saved animation";

  summary.textContent = `${sourceLabel}: ${currentWorkingAnimation.op - currentWorkingAnimation.ip} frames @ ${formatNumber(currentWorkingAnimation.fr)} fps.`;
  issueCounts.textContent = `${warningCount} warnings, ${errorCount} errors`;
  toggleOutput.hidden = !hasIssues;
  if (!hasIssues) {
    outputPanel.hidden = true;
    toggleOutput.textContent = "Show output";
    outputJson.textContent = "";
    return;
  }

  outputJson.textContent = formatIssues(currentIssues);
}

function renderPreviewAnimation() {
  destroyPreviewAnimation();
  if (!currentWorkingAnimation) {
    return;
  }

  currentAnimationInstance = window.lottie.loadAnimation({
    container: preview,
    renderer: "svg",
    loop: true,
    autoplay: false,
    animationData: currentWorkingAnimation
  });

  currentAnimationInstance.addEventListener("DOMLoaded", () => {
    fitZoom();
    goToFrame(0);
    setPlayback(false);
  });

  currentAnimationInstance.addEventListener("enterFrame", () => {
    if (!currentAnimationInstance) {
      return;
    }

    currentFrame = Math.round(currentAnimationInstance.currentFrame);
    updatePlaybackUi();
  });
}

function destroyPreviewAnimation() {
  if (currentAnimationInstance) {
    currentAnimationInstance.destroy();
    currentAnimationInstance = null;
  }

  preview.replaceChildren();
}

function updateStageSize() {
  if (!currentWorkingAnimation) {
    previewStage.style.width = "";
    previewStage.style.height = "";
    preview.style.width = "";
    preview.style.height = "";
    return;
  }

  preview.style.width = `${currentWorkingAnimation.w}px`;
  preview.style.height = `${currentWorkingAnimation.h}px`;
}

function setPlayback(playing) {
  isPlaying = playing;
  if (currentAnimationInstance) {
    if (playing) {
      currentAnimationInstance.play();
    } else {
      currentAnimationInstance.pause();
      currentAnimationInstance.goToAndStop(currentFrame, true);
    }
  }
  updatePlaybackUi();
}

function togglePlayback() {
  if (!currentAnimationInstance) {
    return;
  }

  setPlayback(!isPlaying);
}

function goToFrame(frame) {
  if (!currentAnimationInstance || !currentWorkingAnimation) {
    return;
  }

  const maxFrame = Math.max(0, Math.round(currentWorkingAnimation.op - currentWorkingAnimation.ip - 1));
  currentFrame = Math.max(0, Math.min(Math.round(frame), maxFrame));
  currentAnimationInstance.goToAndStop(currentFrame, true);
  isPlaying = false;
  updatePlaybackUi();
}

function updatePlaybackUi() {
  const frameNumber = currentFrame + 1;
  frameReadout.textContent = `Frame ${frameNumber}`;
  toolbarPlay.textContent = isPlaying ? "Pause" : "Play";
}

function setZoom(nextZoom) {
  currentZoom = Math.min(4, Math.max(0.5, nextZoom));
  applyZoom();
}

function fitZoom() {
  if (!currentWorkingAnimation) {
    return;
  }

  const stageWidth = previewStage.clientWidth;
  const stageHeight = previewStage.clientHeight;
  const contentWidth = preview.offsetWidth || stageWidth;
  const contentHeight = preview.offsetHeight || stageHeight;
  if (stageWidth <= 0 || stageHeight <= 0 || contentWidth <= 0 || contentHeight <= 0) {
    currentZoom = 1;
    applyZoom();
    return;
  }

  const fitScale = Math.min(stageWidth / contentWidth, stageHeight / contentHeight);
  currentZoom = Math.min(4, Math.max(0.5, fitScale));
  applyZoom();
}

function applyZoom() {
  preview.style.transform = `scale(${currentZoom})`;
}

function markDirty() {
  if (!currentWorkingAnimation) {
    return;
  }

  const dirty = Number(fpsInput.value) !== Number(currentWorkingAnimation.fr) ||
    Number(widthInput.value) !== Number(currentWorkingAnimation.w) ||
    Number(heightInput.value) !== Number(currentWorkingAnimation.h);

  updatePreviewButton.disabled = !dirty;
}

function applyPreviewEdits() {
  if (!currentWorkingAnimation) {
    return;
  }

  currentWorkingAnimation = {
    ...structuredClone(currentWorkingAnimation),
    fr: sanitizePositiveNumber(fpsInput.value, currentWorkingAnimation.fr),
    w: sanitizePositiveInteger(widthInput.value, currentWorkingAnimation.w),
    h: sanitizePositiveInteger(heightInput.value, currentWorkingAnimation.h)
  };

  updatePreviewButton.disabled = true;
  outputJson.textContent = JSON.stringify(currentWorkingAnimation, null, 2);
  renderSummary();
  updateStageSize();
  renderPreviewAnimation();
}

async function saveCurrentAnimation() {
  if (!currentWorkingAnimation) {
    return;
  }

  const filename = toJsonFilename(currentSourceName ?? `saved-${Date.now()}.json`);
  const bitmapStorageMode = currentBitmapAssets.length > 0 ? bitmapStorageInput.value : "inline";
  const savePackage = bitmapStorageMode === "external"
    ? createExternalBitmapSavePackage(currentWorkingAnimation, currentBitmapAssets, filename)
    : {
        animation: structuredClone(currentWorkingAnimation),
        externalAssets: []
      };
  const payloadText = JSON.stringify(savePackage.animation, null, 2);

  let saveResult;
  try {
    saveResult = savePackage.externalAssets.length > 0
      ? await saveExternalPackageToUserFiles(filename, payloadText, savePackage.externalAssets)
      : await saveJsonToUserFile(filename, payloadText);
  } catch (error) {
    saveResult = {
      confirmed: false,
      filename,
      cancelled: true
    };
  }

  const savedFilename = saveResult.filename ?? filename;
  const record = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    name: savedFilename,
    source: currentSourceName ?? savedFilename,
    animation: structuredClone(savePackage.animation),
    issues: structuredClone(currentIssues),
    size: byteSizeOfJson(savePackage.animation)
  };

  recentEntries.unshift(record);
  recentEntries.splice(12);
  renderRecentGrid();

  if (saveResult.cancelled) {
    status.textContent = "Save cancelled.";
    savedOutput.hidden = false;
    savedOutput.textContent = "Save cancelled. Preview was added to recent saves.";
    return;
  }

  try {
    const response = await fetch(
      `/api/save-json?filename=${encodeURIComponent(savedFilename)}&source=${encodeURIComponent(currentSourceName ?? savedFilename)}&issues=${encodeURIComponent(JSON.stringify(currentIssues))}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          animation: savePackage.animation,
          externalAssets: savePackage.externalAssets
        })
      }
    );

    const payload = await response.json();
    if (!response.ok || !payload.ok) {
      status.textContent = payload.message ?? "Save log failed.";
      savedOutput.hidden = false;
      savedOutput.textContent = "Saved to chosen file. Logging to out/manual failed.";
      return;
    }

    record.size = payload.size ?? record.size;
    renderRecentGrid();

    savedOutput.hidden = false;
    savedOutput.textContent = saveResult.confirmed
      ? `Saved to chosen file and logged at ${payload.output.json}`
      : `File download started and logged at ${payload.output.json}. Preview was added to recent saves.`;
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : "Save log failed.";
    savedOutput.hidden = false;
    savedOutput.textContent = "Saved to chosen file. Logging to out/manual failed.";
  }
}

function renderRecentGrid() {
  while (recentCardAnimations.length > 0) {
    recentCardAnimations.pop()?.destroy();
  }

  recentGrid.replaceChildren();

  for (const entry of recentEntries) {
    const card = document.createElement("div");
    card.className = "recent-card";

    const previewBox = document.createElement("div");
    previewBox.className = "recent-card-preview";
    card.append(previewBox);

    const title = document.createElement("span");
    title.className = "recent-card-title";
    title.textContent = `${entry.name} - ${entry.size} bytes`;
    card.append(title);

    const animation = window.lottie.loadAnimation({
      container: previewBox,
      renderer: "svg",
      loop: true,
      autoplay: false,
      animationData: entry.animation
    });

    animation.addEventListener("DOMLoaded", () => {
      animation.goToAndStop(0, true);
    });
    recentCardAnimations.push(animation);

    card.addEventListener("mouseenter", () => {
      animation.play();
    });
    card.addEventListener("mouseleave", () => {
      animation.goToAndStop(0, true);
    });

    recentGrid.append(card);
  }
}

function sanitizePositiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function sanitizePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function toJsonFilename(name) {
  const stem = name.replace(/\.swf$/i, "").replace(/[^A-Za-z0-9._-]/g, "_");
  return `${stem}.json`;
}

async function saveJsonToUserFile(filename, payloadText) {
  if ("showSaveFilePicker" in window) {
    const handle = await window.showSaveFilePicker({
      suggestedName: filename,
      types: [
        {
          description: "Lottie JSON",
          accept: {
            "application/json": [".json"]
          }
        }
      ]
    });
    const writable = await handle.createWritable();
    await writable.write(payloadText);
    await writable.close();
    return { confirmed: true, filename: handle.name };
  }

  const blob = new Blob([payloadText], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  return { confirmed: false, filename };
}

async function saveExternalPackageToUserFiles(filename, payloadText, externalAssets) {
  if ("showDirectoryPicker" in window) {
    const directoryHandle = await window.showDirectoryPicker({ mode: "readwrite" });
    await writeTextFileToDirectory(directoryHandle, filename, payloadText);
    for (const asset of externalAssets) {
      await writeBinaryFileToDirectory(directoryHandle, asset.filename, base64ToBytes(asset.dataBase64));
    }
    return { confirmed: true, filename };
  }

  triggerFileDownload(filename, new Blob([payloadText], { type: "application/json;charset=utf-8" }));
  for (const asset of externalAssets) {
    triggerFileDownload(asset.filename, new Blob([base64ToBytes(asset.dataBase64)], { type: asset.mimeType }));
  }
  return { confirmed: false, filename };
}

function createExternalBitmapSavePackage(animation, bitmapAssets, filename) {
  const clonedAnimation = structuredClone(animation);
  const stem = filename.replace(/\.json$/i, "").replace(/[^A-Za-z0-9._-]/g, "_");
  const externalAssets = bitmapAssets.map((asset) => ({
    ...asset,
    filename: `${stem}__${asset.filename}`
  }));
  const assetMap = new Map(externalAssets.map((asset) => [asset.assetId, asset]));

  if (Array.isArray(clonedAnimation.assets)) {
    clonedAnimation.assets = clonedAnimation.assets.map((asset) => {
      if (!asset || typeof asset !== "object") {
        return asset;
      }

      const matchedAsset = assetMap.get(asset.id);
      if (!matchedAsset) {
        return asset;
      }

      return {
        id: matchedAsset.assetId,
        w: matchedAsset.width,
        h: matchedAsset.height,
        u: "",
        p: matchedAsset.filename
      };
    });
  }

  return {
    animation: clonedAnimation,
    externalAssets
  };
}

async function writeTextFileToDirectory(directoryHandle, filename, text) {
  const fileHandle = await directoryHandle.getFileHandle(filename, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(text);
  await writable.close();
}

async function writeBinaryFileToDirectory(directoryHandle, filename, bytes) {
  const fileHandle = await directoryHandle.getFileHandle(filename, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(bytes);
  await writable.close();
}

function triggerFileDownload(filename, blob) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function base64ToBytes(base64) {
  const binary = window.atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function byteSizeOfJson(value) {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

function formatIssues(issues) {
  if (!issues.length) {
    return "";
  }

  return issues
    .map((issue, index) => {
      const parts = [`${index + 1}. [${issue.severity}] ${issue.code}: ${issue.message}`];
      if (issue.path) {
        parts.push(`path: ${issue.path}`);
      }
      if (issue.details) {
        parts.push(`details: ${JSON.stringify(issue.details)}`);
      }
      return parts.join("\n");
    })
    .join("\n\n");
}

function formatNumber(value) {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/\.?0+$/, "");
}

clearWorkspace();
