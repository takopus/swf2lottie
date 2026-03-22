export function prepareAnimationForPreview(animation) {
  const copy = structuredClone(animation);
  completeData(copy);
  return copy;
}

function completeData(animation) {
  if (!animation || typeof animation !== "object") {
    return;
  }

  if (animation.__complete) {
    return;
  }

  if (Array.isArray(animation.layers)) {
    completeLayers(animation.layers, animation.assets ?? []);
  }

  animation.__complete = true;
}

function completeLayers(layers, assets) {
  for (const layer of layers) {
    if (!layer || typeof layer !== "object" || layer.completed) {
      continue;
    }

    layer.completed = true;

    if (layer.hasMask && Array.isArray(layer.masksProperties)) {
      for (const mask of layer.masksProperties) {
        completeShapeProperty(mask?.pt);
      }
    }

    if (layer.ty === 0) {
      const refLayers = getAssetLayers(layer.refId, assets);
      if (Array.isArray(refLayers)) {
        completeLayers(refLayers, assets);
      }
      continue;
    }

    if (layer.ty === 4 && Array.isArray(layer.shapes)) {
      completeShapes(layer.shapes);
    }
  }
}

function getAssetLayers(refId, assets) {
  const asset = assets.find((entry) => entry && entry.id === refId);
  if (!asset || !Array.isArray(asset.layers)) {
    return null;
  }
  return asset.layers;
}

function completeShapes(items) {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (!item || typeof item !== "object") {
      continue;
    }

    if (item.ty === "sh") {
      completeShapeProperty(item.ks);
      continue;
    }

    if (item.ty === "gr" && Array.isArray(item.it)) {
      completeShapes(item.it);
    }
  }
}

function completeShapeProperty(property) {
  if (!property || typeof property !== "object") {
    return;
  }

  if (property.k && property.k.i) {
    completeShape(property.k);
    return;
  }

  if (!Array.isArray(property.k)) {
    return;
  }

  for (const keyframe of property.k) {
    if (Array.isArray(keyframe?.s) && keyframe.s[0]) {
      completeShape(keyframe.s[0]);
    }
    if (Array.isArray(keyframe?.e) && keyframe.e[0]) {
      completeShape(keyframe.e[0]);
    }
  }
}

function completeShape(shape) {
  if (!shape || typeof shape !== "object" || !Array.isArray(shape.v) || !Array.isArray(shape.i) || !Array.isArray(shape.o)) {
    return;
  }

  for (let index = 0; index < shape.i.length; index += 1) {
    shape.i[index][0] += shape.v[index][0];
    shape.i[index][1] += shape.v[index][1];
    shape.o[index][0] += shape.v[index][0];
    shape.o[index][1] += shape.v[index][1];
  }
}
