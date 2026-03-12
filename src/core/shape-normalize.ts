import type { FlashShapeGeometry } from "./ir/types.js";

export interface ShapeSegment {
  start: [number, number];
  end: [number, number];
  control?: [number, number];
}

export function segmentsToGeometry(segments: ShapeSegment[], closed: boolean): FlashShapeGeometry {
  if (segments.length === 0) {
    return {
      vertices: [],
      inTangents: [],
      outTangents: [],
      closed
    };
  }

  const firstSegment = segments[0];
  if (!firstSegment) {
    return {
      vertices: [],
      inTangents: [],
      outTangents: [],
      closed
    };
  }

  const vertices: [number, number][] = [firstSegment.start];
  const inTangents: [number, number][] = [[0, 0]];
  const outTangents: [number, number][] = [[0, 0]];

  for (const segment of segments) {
    const previousIndex = vertices.length - 1;

    if (segment.control) {
      const cubicStartOut: [number, number] = [
        ((segment.control[0] - segment.start[0]) * 2) / 3,
        ((segment.control[1] - segment.start[1]) * 2) / 3
      ];
      const cubicEndIn: [number, number] = [
        ((segment.control[0] - segment.end[0]) * 2) / 3,
        ((segment.control[1] - segment.end[1]) * 2) / 3
      ];

      outTangents[previousIndex] = cubicStartOut;
      vertices.push(segment.end);
      inTangents.push(cubicEndIn);
      outTangents.push([0, 0]);
      continue;
    }

    vertices.push(segment.end);
    inTangents.push([0, 0]);
    outTangents.push([0, 0]);
  }

  if (closed && vertices.length > 1) {
    const closingInTangent = inTangents[inTangents.length - 1];
    if (closingInTangent) {
      inTangents[0] = closingInTangent;
    }
    vertices.pop();
    inTangents.pop();
    outTangents.pop();
  }

  return {
    vertices,
    inTangents,
    outTangents,
    closed
  };
}
