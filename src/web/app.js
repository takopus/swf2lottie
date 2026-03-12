const fileInput = document.getElementById("file-input");
const convertButton = document.getElementById("convert-button");
const status = document.getElementById("status");
const savedOutput = document.getElementById("saved-output");
const preview = document.getElementById("preview");
const issues = document.getElementById("issues");

let selectedFile = null;
let currentAnimation = null;

fileInput.addEventListener("change", () => {
  selectedFile = fileInput.files?.[0] ?? null;
  convertButton.disabled = !selectedFile;
  savedOutput.hidden = true;
  issues.hidden = true;
  issues.textContent = "";

  if (!selectedFile) {
    status.textContent = "No file selected.";
    return;
  }

  status.textContent = `Ready to convert ${selectedFile.name}.`;
});

convertButton.addEventListener("click", async () => {
  if (!selectedFile) {
    return;
  }

  convertButton.disabled = true;
  status.textContent = `Converting ${selectedFile.name}...`;
  savedOutput.hidden = true;
  issues.hidden = true;
  issues.textContent = "";

  try {
    const response = await fetch(`/api/convert?filename=${encodeURIComponent(selectedFile.name)}`, {
      method: "POST",
      body: await selectedFile.arrayBuffer(),
      headers: {
        "content-type": "application/octet-stream"
      }
    });

    const payload = await response.json();
    renderIssues(payload.issues ?? []);

    if (!response.ok || !payload.ok || !payload.animation) {
      destroyAnimation();
      status.textContent = payload.message ?? "Conversion failed.";
      if (payload.output?.error) {
        savedOutput.hidden = false;
        savedOutput.textContent = `Saved diagnostics: ${payload.output.error}`;
      }
      return;
    }

    destroyAnimation();
    currentAnimation = window.lottie.loadAnimation({
      container: preview,
      renderer: "svg",
      loop: true,
      autoplay: true,
      animationData: payload.animation
    });

    status.textContent = `Converted ${selectedFile.name}.`;
    savedOutput.hidden = false;
    savedOutput.textContent = `Saved: ${payload.output.json} and ${payload.output.meta}`;
  } catch (error) {
    destroyAnimation();
    status.textContent = error instanceof Error ? error.message : "Conversion failed.";
  } finally {
    convertButton.disabled = !selectedFile;
  }
});

function destroyAnimation() {
  if (currentAnimation) {
    currentAnimation.destroy();
    currentAnimation = null;
  }

  preview.replaceChildren();
}

function renderIssues(issueList) {
  if (!issueList.length) {
    issues.hidden = true;
    issues.textContent = "";
    return;
  }

  issues.hidden = false;
  issues.textContent = issueList
    .map((issue) => `[${issue.severity}] ${issue.code}: ${issue.message}`)
    .join("\n");
}
