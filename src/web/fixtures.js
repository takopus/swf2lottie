import { BUILD_LABEL } from "./build-info.js";
import { prepareAnimationForPreview } from "./lottie-preview-normalize.js";

const gallery = document.getElementById("gallery");
const buildBadge = document.getElementById("build-badge");

if (buildBadge) {
  buildBadge.textContent = BUILD_LABEL;
}

loadFixtures().catch((error) => {
  gallery.replaceChildren(renderMessage(error instanceof Error ? error.message : "Failed to load fixture comparison gallery."));
});

async function loadFixtures() {
  const [outPayload, webPayload] = await Promise.all([
    loadFixtureManifest("./fixtures-manifest.json", "/api/fixtures", "Failed to load out fixture list."),
    loadFixtureManifest("./fixtures-web-manifest.json", "/api/fixtures-web", "Failed to load out-web fixture list.")
  ]);

  const outFixtures = Array.isArray(outPayload.fixtures) ? outPayload.fixtures : [];
  const webFixtures = Array.isArray(webPayload.fixtures) ? webPayload.fixtures : [];
  const rows = buildFixtureRows(outFixtures, webFixtures);

  if (rows.length === 0) {
    gallery.replaceChildren(renderMessage("No exported fixture JSON files were found in out/ or out-web/."));
    return;
  }

  const cards = await Promise.all(rows.map(createComparisonRow));
  gallery.replaceChildren(...cards);
}

async function loadFixtureManifest(staticPath, apiPath, errorMessage) {
  const staticResponse = await fetch(staticPath);
  if (staticResponse.ok) {
    return await staticResponse.json();
  }

  const apiResponse = await fetch(apiPath);
  if (!apiResponse.ok) {
    throw new Error(errorMessage);
  }

  return await apiResponse.json();
}

function buildFixtureRows(outFixtures, webFixtures) {
  const outMap = new Map(outFixtures.map((fixture) => [fixture.name, fixture]));
  const webMap = new Map(webFixtures.map((fixture) => [fixture.name, fixture]));
  const names = [...new Set([...outMap.keys(), ...webMap.keys()])];
  names.sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));

  return names.map((name) => ({
    name,
    out: outMap.get(name) ?? null,
    web: webMap.get(name) ?? null
  }));
}

async function createComparisonRow(row) {
  const article = document.createElement("article");
  article.className = "compare-row";

  const name = document.createElement("div");
  name.className = "compare-name";
  name.textContent = row.name;

  const left = await createFixtureCell(row.out, "out");
  const right = await createFixtureCell(row.web, "out-web");

  article.append(name, left, right);
  return article;
}

async function createFixtureCell(fixture, kindLabel) {
  const cell = document.createElement("section");
  cell.className = "compare-cell";

  if (!fixture) {
    cell.classList.add("is-missing");
    cell.append(renderMessage(`Missing in ${kindLabel}.`));
    return cell;
  }

  const stage = document.createElement("div");
  stage.className = "stage";

  const meta = document.createElement("p");
  meta.className = "meta";
  meta.textContent = `${fixture.size} bytes`;

  cell.append(stage, meta);

  const response = await fetch(fixture.href);
  if (!response.ok) {
    stage.replaceChildren(renderMessage(`Failed to load ${fixture.name}.`));
    return cell;
  }

  const animationData = await response.json();
  const animation = window.lottie.loadAnimation({
    container: stage,
    renderer: "svg",
    loop: true,
    autoplay: false,
    animationData: prepareAnimationForPreview(animationData)
  });

  animation.addEventListener("DOMLoaded", () => {
    animation.goToAndStop(0, true);
  });

  cell.addEventListener("mouseenter", () => {
    animation.play();
  });

  cell.addEventListener("mouseleave", () => {
    animation.goToAndStop(0, true);
  });

  return cell;
}

function renderMessage(text) {
  const node = document.createElement("p");
  node.className = "message";
  node.textContent = text;
  return node;
}
