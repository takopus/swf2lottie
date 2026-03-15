const fileInput = document.getElementById("file-input");
const convertButton = document.getElementById("convert-button");
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
const zoomResetButton = document.getElementById("zoom-reset");
const frameReadout = document.getElementById("frame-readout");
const summary = document.getElementById("summary");
const issueCounts = document.getElementById("issue-counts");
const toggleOutput = document.getElementById("toggle-output");
const outputPanel = document.getElementById("output-panel");
const outputJson = document.getElementById("output-json");
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
let currentIssues = [];
let currentZoom = 1;
let currentFrame = 0;
let isPlaying = false;
let activeRecentId = null;

fileInput.addEventListener("change", () => {
  selectedFile = fileInput.files?.[0] ?? null;
  convertButton.disabled = !selectedFile;
  status.textContent = selectedFile
    ? `Ready to convert ${selectedFile.name}.`
    : "No file selected.";

  clearWorkspace();
});

convertButton.addEventListener("click", async () => {
  if (!selectedFile) {
    return;
  }

  convertButton.disabled = true;
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
    activeRecentId = null;
    renderWorkspace();
    status.textContent = `Converted ${selectedFile.name}.`;
  } catch (error) {
    clearWorkspace();
    status.textContent = error instanceof Error ? error.message : "Conversion failed.";
  }
});

toolbarPlay.addEventListener("click", togglePlayback);
firstFrameButton.addEventListener("click", () => goToFrame(0));
prevFrameButton.addEventListener("click", () => goToFrame(Math.max(0, currentFrame - 1)));
nextFrameButton.addEventListener("click", () => goToFrame(currentFrame + 1));
zoomInButton.addEventListener("click", () => setZoom(currentZoom + 0.25));
zoomOutButton.addEventListener("click", () => setZoom(Math.max(0.5, currentZoom - 0.25)));
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
  currentIssues = [];
  currentZoom = 1;
  currentFrame = 0;
  isPlaying = false;
  activeRecentId = null;
  workspace.hidden = true;
  outputPanel.hidden = true;
  outputJson.textContent = "";
  toggleOutput.textContent = "Show output";
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
  currentZoom = 1;
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
  const sourceLabel = currentSourceName ?? "saved animation";

  summary.textContent = `${sourceLabel}: ${currentWorkingAnimation.op - currentWorkingAnimation.ip} frames @ ${formatNumber(currentWorkingAnimation.fr)} fps.`;
  issueCounts.textContent = `${warningCount} warnings, ${errorCount} errors`;
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
    applyZoom();
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
    return;
  }

  const size = computePreviewSize(currentWorkingAnimation.w, currentWorkingAnimation.h);
  previewStage.style.width = `${size.width}px`;
  previewStage.style.height = `${size.height}px`;
}

function computePreviewSize(width, height) {
  if (width <= 0 || height <= 0) {
    return { width: 500, height: 500 };
  }

  const maxHeight = 500;
  const maxWidth = 1000;
  const scale = Math.min(maxHeight / height, maxWidth / width, 1);
  return {
    width: Math.round(width * scale),
    height: Math.round(height * scale)
  };
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
  const payloadText = JSON.stringify(currentWorkingAnimation, null, 2);

  try {
    await saveJsonToUserFile(filename, payloadText);
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : "Save cancelled.";
    return;
  }

  const record = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    name: filename,
    source: currentSourceName ?? filename,
    animation: structuredClone(currentWorkingAnimation),
    issues: structuredClone(currentIssues),
    size: byteSizeOfJson(currentWorkingAnimation)
  };

  recentEntries.unshift(record);
  recentEntries.splice(9);
  activeRecentId = record.id;
  renderRecentGrid();

  savedOutput.hidden = false;
  savedOutput.textContent = "Saved to chosen file.";

  try {
    const response = await fetch(
      `/api/save-json?filename=${encodeURIComponent(filename)}&source=${encodeURIComponent(currentSourceName ?? filename)}&issues=${encodeURIComponent(JSON.stringify(currentIssues))}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: payloadText
      }
    );

    const payload = await response.json();
    if (!response.ok || !payload.ok) {
      status.textContent = payload.message ?? "Save log failed.";
      savedOutput.textContent = "Saved to chosen file. Logging to out/manual failed.";
      return;
    }

    record.size = payload.size ?? record.size;
    renderRecentGrid();
    savedOutput.textContent = `Saved to chosen file and logged at ${payload.output.json}`;
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : "Save log failed.";
    savedOutput.textContent = "Saved to chosen file. Logging to out/manual failed.";
  }
}

function renderRecentGrid() {
  while (recentCardAnimations.length > 0) {
    recentCardAnimations.pop()?.destroy();
  }

  recentGrid.replaceChildren();

  for (const entry of recentEntries) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "recent-card";
    if (entry.id === activeRecentId) {
      button.classList.add("is-active");
    }

    const previewBox = document.createElement("div");
    previewBox.className = "recent-card-preview";
    button.append(previewBox);

    const title = document.createElement("span");
    title.className = "recent-card-title";
    title.textContent = `${entry.name} - ${entry.size} bytes`;
    button.append(title);

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

    button.addEventListener("mouseenter", () => {
      animation.play();
    });
    button.addEventListener("mouseleave", () => {
      animation.goToAndStop(0, true);
    });
    button.addEventListener("click", () => {
      activeRecentId = entry.id;
      currentSourceName = entry.source;
      currentIssues = structuredClone(entry.issues);
      currentBaseAnimation = structuredClone(entry.animation);
      currentWorkingAnimation = structuredClone(entry.animation);
      renderWorkspace();
      renderRecentGrid();
      status.textContent = `Loaded saved animation ${entry.name}.`;
    });

    recentGrid.append(button);
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
    return;
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
}

function byteSizeOfJson(value) {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

function formatNumber(value) {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/\.?0+$/, "");
}
