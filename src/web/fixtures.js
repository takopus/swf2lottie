import { BUILD_LABEL } from "./build-info.js";

const gallery = document.getElementById("gallery");
const buildBadge = document.getElementById("build-badge");

if (buildBadge) {
  buildBadge.textContent = BUILD_LABEL;
}

loadFixtures().catch((error) => {
  gallery.replaceChildren(renderMessage(error instanceof Error ? error.message : "Failed to load fixture gallery."));
});

async function loadFixtures() {
  const response = await fetch("/api/fixtures");
  if (!response.ok) {
    throw new Error("Failed to load fixture list.");
  }

  const payload = await response.json();
  const fixtures = Array.isArray(payload.fixtures) ? payload.fixtures : [];

  if (fixtures.length === 0) {
    gallery.replaceChildren(renderMessage("No exported fixture JSON files were found in out/."));
    return;
  }

  const cards = await Promise.all(fixtures.map(createFixtureCard));
  gallery.replaceChildren(...cards);
}

async function createFixtureCard(fixture) {
  const card = document.createElement("article");
  card.className = "card";

  const stage = document.createElement("div");
  stage.className = "stage";

  const name = document.createElement("p");
  name.className = "name";
  name.textContent = fixture.name;

  const meta = document.createElement("p");
  meta.className = "meta";
  meta.textContent = `${fixture.size} bytes`;

  card.append(stage, name, meta);

  const response = await fetch(fixture.href);
  if (!response.ok) {
    stage.replaceChildren(renderMessage(`Failed to load ${fixture.name}.`));
    return card;
  }

  const animationData = await response.json();
  const animation = window.lottie.loadAnimation({
    container: stage,
    renderer: "svg",
    loop: true,
    autoplay: false,
    animationData
  });

  animation.addEventListener("DOMLoaded", () => {
    animation.goToAndStop(0, true);
  });

  card.addEventListener("mouseenter", () => {
    animation.play();
  });

  card.addEventListener("mouseleave", () => {
    animation.goToAndStop(0, true);
  });

  return card;
}

function renderMessage(text) {
  const node = document.createElement("p");
  node.className = "message";
  node.textContent = text;
  return node;
}
