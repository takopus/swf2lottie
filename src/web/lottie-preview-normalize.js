export function prepareAnimationForLottieWeb(animation) {
  const copy = structuredClone(animation);
  normalizeValue(copy);
  return copy;
}

function normalizeValue(value) {
  if (!value || typeof value !== "object") {
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      normalizeValue(item);
    }
    return;
  }

  if (value.ty === "sh" && value.ks) {
    normalizeShapeProperty(value.ks);
  }

  for (const nested of Object.values(value)) {
    normalizeValue(nested);
  }
}

function normalizeShapeProperty(property) {
  const keyframes = property.a === 1 && Array.isArray(property.k) ? property.k : null;
  if (keyframes) {
    for (const keyframe of keyframes) {
      if (Array.isArray(keyframe.s)) {
        for (const shape of keyframe.s) {
          normalizeShapeGeometry(shape);
        }
      }

      if (Array.isArray(keyframe.e)) {
        for (const shape of keyframe.e) {
          normalizeShapeGeometry(shape);
        }
      }
    }
    return;
  }

  if (property.k && typeof property.k === "object") {
    normalizeShapeGeometry(property.k);
  }
}

function normalizeShapeGeometry(shape) {
  if (!shape || typeof shape !== "object" || !Array.isArray(shape.v) || !Array.isArray(shape.i) || !Array.isArray(shape.o)) {
    return;
  }

  for (let index = 0; index < shape.v.length; index += 1) {
    const vertex = shape.v[index];
    const inTangent = shape.i[index];
    const outTangent = shape.o[index];
    if (!Array.isArray(vertex) || !Array.isArray(inTangent) || !Array.isArray(outTangent)) {
      continue;
    }

    shape.i[index] = [vertex[0] + inTangent[0], vertex[1] + inTangent[1]];
    shape.o[index] = [vertex[0] + outTangent[0], vertex[1] + outTangent[1]];
  }
}
