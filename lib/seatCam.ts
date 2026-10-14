export type SeatPoint = { x: number; y: number };
export type Mortise = { id: string; x: number; y: number; width: number; height: number };
export type MortiseLayout = "four" | "cross";
export type ExtractResult = { points: SeatPoint[]; confidence: "good" | "fair" | "poor"; message: string };
export type SeatJobSettings = {
  boardWidth: number; boardHeight: number; boardThickness: number; mortiseDepth: number;
  bitDiameter: number; stepDown: number; stepover: number; feedRate: number;
  plungeRate: number; rapidFeed: number; safeZ: number; spindleRpm: number;
  tabs?: number[]; tabWidth?: number; tabHeight?: number;
};

export const GORDIX_RETRACT_Z = 2;

const key = (x: number, y: number) => `${x},${y}`;

function pointArea(points: SeatPoint[]) {
  return points.reduce((sum, point, index) => {
    const next = points[(index + 1) % points.length];
    return sum + point.x * next.y - next.x * point.y;
  }, 0) / 2;
}

function perpendicularDistance(point: SeatPoint, start: SeatPoint, end: SeatPoint) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (dx === 0 && dy === 0) return Math.hypot(point.x - start.x, point.y - start.y);
  const t = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(point.x - (start.x + t * dx), point.y - (start.y + t * dy));
}

function simplifyOpen(points: SeatPoint[], tolerance: number): SeatPoint[] {
  if (points.length <= 2) return points;
  let furthest = 0;
  let index = 0;
  for (let i = 1; i < points.length - 1; i += 1) {
    const distance = perpendicularDistance(points[i], points[0], points[points.length - 1]);
    if (distance > furthest) { furthest = distance; index = i; }
  }
  if (furthest <= tolerance) return [points[0], points[points.length - 1]];
  const left = simplifyOpen(points.slice(0, index + 1), tolerance);
  const right = simplifyOpen(points.slice(index), tolerance);
  return [...left.slice(0, -1), ...right];
}

function simplifyClosed(points: SeatPoint[], tolerance: number) {
  if (points.length < 5) return points;
  const half = Math.floor(points.length / 2);
  const first = simplifyOpen(points.slice(0, half + 1), tolerance);
  const second = simplifyOpen([...points.slice(half), points[0]], tolerance);
  return [...first.slice(0, -1), ...second.slice(0, -1)];
}

function chaikin(points: SeatPoint[], passes: number) {
  let current = points;
  for (let pass = 0; pass < passes; pass += 1) {
    const next: SeatPoint[] = [];
    current.forEach((point, index) => {
      const after = current[(index + 1) % current.length];
      next.push(
        { x: point.x * .75 + after.x * .25, y: point.y * .75 + after.y * .25 },
        { x: point.x * .25 + after.x * .75, y: point.y * .25 + after.y * .75 },
      );
    });
    current = next;
  }
  return current;
}

function morphClose(source: Uint8Array, width: number, height: number, radius: number) {
  if (radius <= 0) return source;
  const dilated = new Uint8Array(source.length);
  const output = new Uint8Array(source.length);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    let found = 0;
    for (let yy = Math.max(0, y - radius); yy <= Math.min(height - 1, y + radius) && !found; yy += 1) {
      for (let xx = Math.max(0, x - radius); xx <= Math.min(width - 1, x + radius); xx += 1) {
        if (source[yy * width + xx]) { found = 1; break; }
      }
    }
    dilated[y * width + x] = found;
  }
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    let full = 1;
    for (let yy = Math.max(0, y - radius); yy <= Math.min(height - 1, y + radius) && full; yy += 1) {
      for (let xx = Math.max(0, x - radius); xx <= Math.min(width - 1, x + radius); xx += 1) {
        if (!dilated[yy * width + xx]) { full = 0; break; }
      }
    }
    output[y * width + x] = full;
  }
  return output;
}

function largestEnclosedRegion(dark: Uint8Array, width: number, height: number) {
  const outside = new Uint8Array(dark.length);
  const queue = new Int32Array(dark.length);
  let head = 0;
  let tail = 0;
  const enqueue = (index: number) => {
    if (index < 0 || index >= dark.length || dark[index] || outside[index]) return;
    outside[index] = 1; queue[tail++] = index;
  };
  for (let x = 0; x < width; x += 1) { enqueue(x); enqueue((height - 1) * width + x); }
  for (let y = 0; y < height; y += 1) { enqueue(y * width); enqueue(y * width + width - 1); }
  while (head < tail) {
    const index = queue[head++];
    const x = index % width;
    if (x > 0) enqueue(index - 1);
    if (x < width - 1) enqueue(index + 1);
    if (index >= width) enqueue(index - width);
    if (index < dark.length - width) enqueue(index + width);
  }
  const candidate = new Uint8Array(dark.length);
  for (let i = 0; i < dark.length; i += 1) candidate[i] = outside[i] ? 0 : 1;
  const visited = new Uint8Array(dark.length);
  let largest: number[] = [];
  for (let start = 0; start < candidate.length; start += 1) {
    if (!candidate[start] || visited[start]) continue;
    const component: number[] = [];
    const pending = [start]; visited[start] = 1;
    while (pending.length) {
      const index = pending.pop()!;
      component.push(index);
      const x = index % width;
      [x > 0 ? index - 1 : -1, x < width - 1 ? index + 1 : -1, index - width, index + width].forEach((next) => {
        if (next >= 0 && next < candidate.length && candidate[next] && !visited[next]) { visited[next] = 1; pending.push(next); }
      });
    }
    if (component.length > largest.length) largest = component;
  }
  const mask = new Uint8Array(dark.length);
  largest.forEach((index) => { mask[index] = 1; });
  return mask;
}

function traceBoundary(mask: Uint8Array, width: number, height: number) {
  const edges = new Map<string, SeatPoint[]>();
  const add = (a: SeatPoint, b: SeatPoint) => { const list = edges.get(key(a.x, a.y)) ?? []; list.push(b); edges.set(key(a.x, a.y), list); };
  const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < width && y < height && Boolean(mask[y * width + x]);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    if (!inside(x, y)) continue;
    if (!inside(x, y - 1)) add({ x, y }, { x: x + 1, y });
    if (!inside(x + 1, y)) add({ x: x + 1, y }, { x: x + 1, y: y + 1 });
    if (!inside(x, y + 1)) add({ x: x + 1, y: y + 1 }, { x, y: y + 1 });
    if (!inside(x - 1, y)) add({ x, y: y + 1 }, { x, y });
  }
  const loops: SeatPoint[][] = [];
  while (edges.size) {
    const firstKey = edges.keys().next().value as string;
    const [sx, sy] = firstKey.split(",").map(Number);
    const start = { x: sx, y: sy };
    const loop = [start];
    let current = start;
    for (let guard = 0; guard < width * height * 4; guard += 1) {
      const list = edges.get(key(current.x, current.y));
      if (!list?.length) break;
      const next = list.pop()!;
      if (!list.length) edges.delete(key(current.x, current.y));
      if (next.x === start.x && next.y === start.y) break;
      loop.push(next); current = next;
    }
    if (loop.length > 8) loops.push(loop);
  }
  return loops.sort((a, b) => Math.abs(pointArea(b)) - Math.abs(pointArea(a)))[0] ?? [];
}

export function extractSeatOutline(pixels: Uint8ClampedArray, width: number, height: number, threshold: number, smoothing: number): ExtractResult {
  const dark = new Uint8Array(width * height);
  let darkCount = 0;
  for (let i = 0; i < dark.length; i += 1) {
    const offset = i * 4;
    const luminance = pixels[offset] * .299 + pixels[offset + 1] * .587 + pixels[offset + 2] * .114;
    if (pixels[offset + 3] > 30 && luminance < threshold) { dark[i] = 1; darkCount += 1; }
  }
  const region = largestEnclosedRegion(morphClose(dark, width, height, smoothing >= 70 ? 2 : 1), width, height);
  const boundary = traceBoundary(region, width, height);
  if (boundary.length < 12) return { points: [], confidence: "poor", message: "閉じた輪郭を見つけられません。線を濃くするか、しきい値を上げてください。" };
  const normalized = boundary.map((point) => ({ x: point.x / width, y: point.y / height }));
  const simplified = simplifyClosed(normalized, .0015 + smoothing / 12000);
  const smoothed = chaikin(simplified, smoothing < 25 ? 0 : smoothing < 70 ? 1 : 2);
  const area = Math.abs(pointArea(smoothed));
  const darkRatio = darkCount / dark.length;
  const confidence = area > .12 && area < .9 && darkRatio < .35 ? "good" : area > .05 ? "fair" : "poor";
  return { points: smoothed, confidence, message: confidence === "good" ? "輪郭をきれいに抽出できています。" : "輪郭は抽出できました。線の抜けや余計な影がないか確認してください。" };
}

function solveLinear(matrix: number[][], vector: number[]) {
  const n = vector.length;
  const a = matrix.map((row, i) => [...row, vector[i]]);
  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let row = col + 1; row < n; row += 1) if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row;
    [a[col], a[pivot]] = [a[pivot], a[col]];
    const divisor = a[col][col] || 1e-12;
    for (let j = col; j <= n; j += 1) a[col][j] /= divisor;
    for (let row = 0; row < n; row += 1) if (row !== col) { const factor = a[row][col]; for (let j = col; j <= n; j += 1) a[row][j] -= factor * a[col][j]; }
  }
  return a.map((row) => row[n]);
}

export function perspectiveCorrect(points: SeatPoint[], corners: SeatPoint[]) {
  if (corners.length !== 4) return points;
  const targets: SeatPoint[] = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
  const matrix: number[][] = [];
  const vector: number[] = [];
  corners.forEach((source, index) => {
    const target = targets[index];
    matrix.push([source.x, source.y, 1, 0, 0, 0, -target.x * source.x, -target.x * source.y]); vector.push(target.x);
    matrix.push([0, 0, 0, source.x, source.y, 1, -target.y * source.x, -target.y * source.y]); vector.push(target.y);
  });
  const h = solveLinear(matrix, vector);
  return points.map((point) => { const d = h[6] * point.x + h[7] * point.y + 1; return { x: (h[0] * point.x + h[1] * point.y + h[2]) / d, y: (h[3] * point.x + h[4] * point.y + h[5]) / d }; });
}

export function offsetPolygon(points: SeatPoint[], distance: number) {
  if (points.length < 3) return points;
  const orientation = Math.sign(pointArea(points)) || 1;
  return points.map((point, index) => {
    const before = points[(index - 1 + points.length) % points.length];
    const after = points[(index + 1) % points.length];
    const a = { x: point.x - before.x, y: point.y - before.y };
    const b = { x: after.x - point.x, y: after.y - point.y };
    const la = Math.hypot(a.x, a.y) || 1; const lb = Math.hypot(b.x, b.y) || 1;
    const na = { x: orientation * a.y / la, y: -orientation * a.x / la };
    const nb = { x: orientation * b.y / lb, y: -orientation * b.x / lb };
    const bisector = { x: na.x + nb.x, y: na.y + nb.y };
    const length = Math.hypot(bisector.x, bisector.y) || 1;
    const dot = Math.max(.25, bisector.x / length * na.x + bisector.y / length * na.y);
    const miter = Math.min(distance * 3, distance / dot);
    return { x: point.x + bisector.x / length * miter, y: point.y + bisector.y / length * miter };
  });
}

export function pointInPolygon(point: SeatPoint, polygon: SeatPoint[]) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]; const b = polygon[j];
    if (((a.y > point.y) !== (b.y > point.y)) && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y || 1e-12) + a.x) inside = !inside;
  }
  return inside;
}

export function polygonSelfIntersects(points: SeatPoint[]) {
  const cross = (a: SeatPoint, b: SeatPoint, c: SeatPoint) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const intersects = (a: SeatPoint, b: SeatPoint, c: SeatPoint, d: SeatPoint) => {
    const abC = cross(a, b, c), abD = cross(a, b, d), cdA = cross(c, d, a), cdB = cross(c, d, b);
    return ((abC > 1e-7 && abD < -1e-7) || (abC < -1e-7 && abD > 1e-7))
      && ((cdA > 1e-7 && cdB < -1e-7) || (cdA < -1e-7 && cdB > 1e-7));
  };
  for (let first = 0; first < points.length; first += 1) {
    const firstNext = (first + 1) % points.length;
    for (let second = first + 1; second < points.length; second += 1) {
      const secondNext = (second + 1) % points.length;
      if (firstNext === second || secondNext === first) continue;
      if (intersects(points[first], points[firstNext], points[second], points[secondNext])) return true;
    }
  }
  return false;
}

/**
 * Place the four mortises symmetrically about the material centre.
 * gapX/gapY are the clear edge-to-edge distances between opposing mortises.
 */
export function buildMortises(boardWidth: number, boardHeight: number, width: number, height: number, gapX: number, gapY: number, layout: MortiseLayout = "four"): Mortise[] {
  const centerX = boardWidth / 2;
  const centerY = boardHeight / 2;
  if (layout === "cross") {
    return [
      { id: "cross-horizontal", x: centerX, y: centerY, width: Math.max(0, gapX) + height * 2, height: width },
      { id: "cross-vertical", x: centerX, y: centerY, width, height: Math.max(0, gapY) + height * 2 },
    ];
  }
  const horizontalOffset = Math.max(0, gapX) / 2 + height / 2;
  const verticalOffset = Math.max(0, gapY) / 2 + height / 2;
  return [
    { x: centerX, y: centerY + verticalOffset, width, height },
    { x: centerX + horizontalOffset, y: centerY, width: height, height: width },
    { x: centerX, y: centerY - verticalOffset, width, height },
    { x: centerX - horizontalOffset, y: centerY, width: height, height: width },
  ].map((mortise, index) => ({ id: `mortise-${index + 1}`, ...mortise }));
}

/**
 * Actual pocket boundary with a compact dog-bone at each corner.
 * The relief-circle centre is r/sqrt(2) from both adjacent edges. This is the
 * smallest 45-degree relief that lets a round cutter clear the nominal corner.
 */
export function mortiseDogboneOutline(mortise: Mortise, bitDiameter: number, arcSegments = 6) {
  const radius = Math.max(0, bitDiameter / 2);
  const left = mortise.x - mortise.width / 2;
  const right = mortise.x + mortise.width / 2;
  const bottom = mortise.y - mortise.height / 2;
  const top = mortise.y + mortise.height / 2;
  if (radius <= 0) return [{ x: left, y: bottom }, { x: right, y: bottom }, { x: right, y: top }, { x: left, y: top }];

  const inset = radius / Math.SQRT2;
  const tangent = inset * 2;
  const segments = Math.max(2, Math.round(arcSegments));
  const points: SeatPoint[] = [{ x: left + tangent, y: bottom }, { x: right - tangent, y: bottom }];
  const appendArc = (center: SeatPoint, startDegrees: number) => {
    for (let index = 1; index <= segments; index += 1) {
      const angle = (startDegrees + 180 * index / segments) * Math.PI / 180;
      points.push({ x: center.x + Math.cos(angle) * radius, y: center.y + Math.sin(angle) * radius });
    }
  };
  appendArc({ x: right - inset, y: bottom + inset }, -135);
  points.push({ x: right, y: top - tangent });
  appendArc({ x: right - inset, y: top - inset }, -45);
  points.push({ x: left + tangent, y: top });
  appendArc({ x: left + inset, y: top - inset }, 45);
  points.push({ x: left, y: bottom + tangent });
  appendArc({ x: left + inset, y: bottom + inset }, 135);
  return points;
}

/** One closed outline for the union of the horizontal and vertical cross pockets. */
export function crossMortiseDogboneOutline(mortises: Mortise[], bitDiameter: number, arcSegments = 6) {
  const horizontal = mortises.find(mortise => mortise.width >= mortise.height);
  const vertical = mortises.find(mortise => mortise.height > mortise.width);
  if (!horizontal || !vertical) return mortises[0] ? mortiseDogboneOutline(mortises[0], bitDiameter, arcSegments) : [];

  const centerX = (horizontal.x + vertical.x) / 2;
  const centerY = (horizontal.y + vertical.y) / 2;
  const halfX = horizontal.width / 2;
  const halfY = vertical.height / 2;
  const halfArm = Math.min(horizontal.height, vertical.width) / 2;
  const nominal = [
    { x: centerX - halfArm, y: centerY - halfY }, { x: centerX + halfArm, y: centerY - halfY },
    { x: centerX + halfArm, y: centerY - halfArm }, { x: centerX + halfX, y: centerY - halfArm },
    { x: centerX + halfX, y: centerY + halfArm }, { x: centerX + halfArm, y: centerY + halfArm },
    { x: centerX + halfArm, y: centerY + halfY }, { x: centerX - halfArm, y: centerY + halfY },
    { x: centerX - halfArm, y: centerY + halfArm }, { x: centerX - halfX, y: centerY + halfArm },
    { x: centerX - halfX, y: centerY - halfArm }, { x: centerX - halfArm, y: centerY - halfArm },
  ];
  const radius = Math.max(0, bitDiameter / 2);
  if (radius <= 0) return nominal;

  const inset = radius / Math.SQRT2;
  const tangent = inset * 2;
  const segments = Math.max(2, Math.round(arcSegments));
  const outline: SeatPoint[] = [];
  nominal.forEach((corner, index) => {
    const before = nominal[(index - 1 + nominal.length) % nominal.length];
    const after = nominal[(index + 1) % nominal.length];
    const incoming = { x: corner.x - before.x, y: corner.y - before.y };
    const outgoing = { x: after.x - corner.x, y: after.y - corner.y };
    const cross = incoming.x * outgoing.y - incoming.y * outgoing.x;
    if (cross <= 0) { outline.push(corner); return; }
    const toBeforeLength = Math.hypot(before.x - corner.x, before.y - corner.y) || 1;
    const toAfterLength = Math.hypot(after.x - corner.x, after.y - corner.y) || 1;
    const toBefore = { x: (before.x - corner.x) / toBeforeLength, y: (before.y - corner.y) / toBeforeLength };
    const toAfter = { x: (after.x - corner.x) / toAfterLength, y: (after.y - corner.y) / toAfterLength };
    const start = { x: corner.x + toBefore.x * tangent, y: corner.y + toBefore.y * tangent };
    const center = { x: corner.x + (toBefore.x + toAfter.x) * inset, y: corner.y + (toBefore.y + toAfter.y) * inset };
    const startAngle = Math.atan2(start.y - center.y, start.x - center.x);
    outline.push(start);
    for (let segment = 1; segment <= segments; segment += 1) {
      const angle = startAngle + Math.PI * segment / segments;
      outline.push({ x: center.x + Math.cos(angle) * radius, y: center.y + Math.sin(angle) * radius });
    }
  });
  return outline;
}

export function mortiseLayoutOutlines(mortises: Mortise[], layout: MortiseLayout, bitDiameter: number, arcSegments = 6) {
  return layout === "cross"
    ? [crossMortiseDogboneOutline(mortises, bitDiameter, arcSegments)]
    : mortises.map(mortise => mortiseDogboneOutline(mortise, bitDiameter, arcSegments));
}

export function mortisePocketPath(mortise: Mortise, bitDiameter: number, stepover: number) {
  const radius = bitDiameter / 2;
  const left = mortise.x - mortise.width / 2; const right = mortise.x + mortise.width / 2;
  const bottom = mortise.y - mortise.height / 2; const top = mortise.y + mortise.height / 2;
  const minX = left + radius; const maxX = right - radius;
  const minY = bottom + radius; const maxY = top - radius;
  if (minX > maxX || minY > maxY) return [];
  const step = Math.max(.2, bitDiameter * stepover);
  const rows = Math.max(1, Math.ceil((maxY - minY) / step));
  const points: SeatPoint[] = [];
  for (let row = 0; row <= rows; row += 1) { const y = minY + (maxY - minY) * row / rows; points.push(...(row % 2 ? [{ x: maxX, y }, { x: minX, y }] : [{ x: minX, y }, { x: maxX, y }])); }
  const reliefInset = radius / Math.SQRT2;
  const bottomLeft = { x: left + reliefInset, y: bottom + reliefInset };
  const bottomRight = { x: right - reliefInset, y: bottom + reliefInset };
  const topRight = { x: right - reliefInset, y: top - reliefInset };
  const topLeft = { x: left + reliefInset, y: top - reliefInset };
  points.push(
    { x: minX, y: minY }, bottomLeft, { x: minX, y: minY },
    { x: maxX, y: minY }, bottomRight, { x: maxX, y: minY },
    { x: maxX, y: maxY }, topRight, { x: maxX, y: maxY },
    { x: minX, y: maxY }, topLeft, { x: minX, y: maxY },
    { x: minX, y: minY },
  );
  return points;
}

export function closedPathLength(points: SeatPoint[]) {
  if (points.length < 2) return 0;
  return points.reduce((total, point, index) => {
    const next = points[(index + 1) % points.length];
    return total + Math.hypot(next.x - point.x, next.y - point.y);
  }, 0);
}

export function pointOnClosedPath(points: SeatPoint[], position: number) {
  const total = closedPathLength(points);
  if (!points.length || total <= 0) return points[0] ?? { x: 0, y: 0 };
  let target = ((position % 1) + 1) % 1 * total;
  for (let index = 0; index < points.length; index += 1) {
    const start = points[index];
    const end = points[(index + 1) % points.length];
    const length = Math.hypot(end.x - start.x, end.y - start.y);
    if (target <= length || index === points.length - 1) {
      const ratio = length > 0 ? Math.max(0, Math.min(1, target / length)) : 0;
      return { x: start.x + (end.x - start.x) * ratio, y: start.y + (end.y - start.y) * ratio };
    }
    target -= length;
  }
  return points[0];
}

function pathSlice(points: SeatPoint[], startDistance: number, endDistance: number, total: number) {
  const positionAt = (distance: number) => pointOnClosedPath(points, distance / total);
  const result = [positionAt(startDistance)];
  let travelled = 0;
  points.forEach((point, index) => {
    const next = points[(index + 1) % points.length];
    travelled += Math.hypot(next.x - point.x, next.y - point.y);
    if (travelled > startDistance + 1e-6 && travelled < endDistance - 1e-6) result.push(next);
  });
  result.push(positionAt(endDistance));
  return result;
}

/** Split a closed profile into cuttable spans, leaving the requested tab widths uncut. */
export function splitClosedPathAtTabs(points: SeatPoint[], tabs: number[], tabWidth: number) {
  const total = closedPathLength(points);
  if (points.length < 3 || total <= 0 || !tabs.length || tabWidth <= 0) return points.length ? [[...points, points[0]]] : [];
  const half = Math.min(tabWidth, total) / 2;
  const blocked: Array<[number, number]> = [];
  tabs.forEach(position => {
    const center = (((position % 1) + 1) % 1) * total;
    const start = center - half;
    const end = center + half;
    if (start < 0) blocked.push([0, end], [total + start, total]);
    else if (end > total) blocked.push([start, total], [0, end - total]);
    else blocked.push([start, end]);
  });
  const merged = blocked.sort((a, b) => a[0] - b[0]).reduce<Array<[number, number]>>((ranges, range) => {
    const previous = ranges[ranges.length - 1];
    if (previous && range[0] <= previous[1] + 1e-6) previous[1] = Math.max(previous[1], range[1]);
    else ranges.push([...range]);
    return ranges;
  }, []);
  const allowed: Array<[number, number]> = [];
  let cursor = 0;
  merged.forEach(range => {
    if (range[0] > cursor + 1e-6) allowed.push([cursor, range[0]]);
    cursor = Math.max(cursor, range[1]);
  });
  if (cursor < total - 1e-6) allowed.push([cursor, total]);
  return allowed.map(([start, end]) => pathSlice(points, start, end, total)).filter(path => path.length >= 2);
}

const fmt = (value: number) => (Math.abs(value) < .0005 ? 0 : value).toFixed(3);
function depths(finalDepth: number, stepDown: number) { const step = Math.min(3.2, Math.max(.1, stepDown)); return Array.from({length: Math.ceil(finalDepth / step)}, (_, index) => Math.min(finalDepth, (index + 1) * step)); }
function emitPath(lines: string[], points: SeatPoint[], depth: number, settings: SeatJobSettings, retractFirst: boolean) {
  if (points.length < 2) return false;
  if (retractFirst) lines.push(`G0 Z${fmt(settings.safeZ)}`);
  lines.push(`G0 X${fmt(points[0].x)} Y${fmt(points[0].y)} F${fmt(settings.rapidFeed)}`, `G1 Z-${fmt(depth)} F${fmt(settings.plungeRate)}`);
  points.slice(1).forEach((point, index) => lines.push(`G1 X${fmt(point.x)} Y${fmt(point.y)}${index === 0 ? ` F${fmt(settings.feedRate)}` : ""}`));
  return true;
}

function isRetractCommand(command: string, retractZ: number) {
  const match = command.match(/^G0\s+Z(-?(?:\d+(?:\.\d*)?|\.\d+))(?:\s|$)/);
  return Boolean(match && Math.abs(Number(match[1]) - retractZ) <= .0005);
}

/** Check the machine-specific safety rules before offering a G-code download. */
export function validateGordixGcode(code: string, retractZ = GORDIX_RETRACT_Z) {
  const issues: string[] = [];
  const commands = code.split(/\r?\n/).map((line, index) => ({
    line: index + 1,
    text: line.replace(/;.*/, "").trim().toUpperCase(),
  })).filter(command => command.text);
  let firstPlungeIndex = -1;
  const plungeIndices: number[] = [];

  commands.forEach((command, index) => {
    const isRapid = /^G0(?:\s|$)/.test(command.text);
    const isFeed = /^G1(?:\s|$)/.test(command.text);
    const hasXy = /(?:^|\s)[XY]-?(?:\d+(?:\.\d*)?|\.\d+)/.test(command.text);
    const zMatch = command.text.match(/(?:^|\s)Z(-?(?:\d+(?:\.\d*)?|\.\d+))/);
    const z = zMatch ? Number(zMatch[1]) : null;
    if (isRapid && hasXy && z !== null) issues.push(`L${command.line}: G0にXYとZが同居しています`);
    if (isRapid && z !== null && z < 0) issues.push(`L${command.line}: 負のZへのG0は使用できません`);
    if (isFeed && hasXy && z !== null) issues.push(`L${command.line}: 切込みZとXYを同一ブロックに出力できません`);
    if (isFeed && z !== null && z < 0) {
      if (firstPlungeIndex < 0) firstPlungeIndex = index;
      plungeIndices.push(index);
      if (!/(?:^|\s)F(?:\d+(?:\.\d*)?|\.\d+)/.test(command.text)) issues.push(`L${command.line}: Z切込みにF値がありません`);
    }
    if (isRapid && z !== null && z >= 0 && Math.abs(z - retractZ) > .0005) issues.push(`L${command.line}: 退避高さは設定値Z${fmt(retractZ)}と一致していません`);
  });

  if (firstPlungeIndex > 0) {
    commands.slice(0, firstPlungeIndex).forEach((command) => {
      if (/^G0(?:\s|$)/.test(command.text) && /(?:^|\s)Z/.test(command.text)) issues.push(`L${command.line}: 初回切削前の不要なZ退避です`);
    });
  }

  plungeIndices.forEach((index, plungeNumber) => {
    const xy = commands[index - 1]?.text ?? "";
    if (!/^G0(?:\s|$)/.test(xy) || !/(?:^|\s)[XY]/.test(xy) || /(?:^|\s)Z/.test(xy)) issues.push(`L${commands[index].line}: Z切込み前のXY早送りが分離されていません`);
    if (plungeNumber > 0) {
      const retract = commands[index - 2]?.text ?? "";
      if (!isRetractCommand(retract, retractZ)) issues.push(`L${commands[index].line}: パス間のZ${fmt(retractZ)}退避がありません`);
    }
  });

  const retractIndices = commands.flatMap((command, index) => isRetractCommand(command.text, retractZ) ? [index] : []);
  retractIndices.forEach((index) => {
    const xy = commands[index + 1]?.text ?? "";
    const plunge = commands[index + 2]?.text ?? "";
    if (!/^G0(?:\s|$)/.test(xy) || !/(?:^|\s)[XY]/.test(xy) || /(?:^|\s)Z/.test(xy)) issues.push(`L${commands[index].line}: Z退避の次にXY早送りがありません`);
    const finalReturn = /^G0\s+X0(?:\.0+)?\s+Y0(?:\.0+)?(?:\s|$)/.test(xy) && /^M5(?:\s|$)/.test(plunge);
    if (!finalReturn && (!/^G1(?:\s|$)/.test(plunge) || !/(?:^|\s)Z-/.test(plunge) || !/(?:^|\s)F/.test(plunge))) issues.push(`L${commands[index].line}: XY移動の次に送り付きZ切込みがありません`);
  });
  return [...new Set(issues)];
}

export function generateSeatGcode(outline: SeatPoint[], mortises: Mortise[], settings: SeatJobSettings, jobName: string, options: { includeOutline?: boolean } = {}) {
  const includeOutline = options.includeOutline !== false;
  if (includeOutline && outline.length < 3) throw new Error("座面の輪郭を先に読み込んでください。");
  if (!includeOutline && !mortises.length) throw new Error("書き出す加工形状がありません。");
  if (includeOutline && polygonSelfIntersects(outline)) throw new Error("座面輪郭に交差があります。なめらかさを調整してください。");
  if (settings.stepDown > 3.2) throw new Error("一回の切削深さは3.2 mm以下にしてください。");
  if (!Number.isFinite(settings.safeZ) || settings.safeZ <= 0) throw new Error("退避高さは0 mmより大きくしてください。");
  const tabs = (settings.tabs ?? []).filter(position => Number.isFinite(position));
  const tabWidth = Math.max(0, settings.tabWidth ?? 0);
  const tabHeight = Math.max(0, Math.min(settings.boardThickness, settings.tabHeight ?? 0));
  const toMachineOrigin = (point: SeatPoint) => ({
    x: point.x - settings.boardWidth / 2,
    y: point.y - settings.boardHeight / 2,
  });
  const outside = includeOutline ? offsetPolygon(outline, settings.bitDiameter / 2).map(toMachineOrigin) : [];
  if (includeOutline && polygonSelfIntersects(outside)) throw new Error("工具径補正後の外周パスに交差があります。輪郭を調整してください。");
  const order = includeOutline ? (mortises.length ? "; Order: mortise pockets, then outside profile" : "; Order: outside profile only") : "; Order: mortise pockets only";
  const lines = ["; CHAIR WORKSHOP / GORDIX", `; Job: ${jobName.replace(/[^\x20-\x7e]/g, "_")}`, `; Board: ${fmt(settings.boardWidth)} x ${fmt(settings.boardHeight)} x ${fmt(settings.boardThickness)} mm`, `; Tool: straight bit D${fmt(settings.bitDiameter)} mm`, `; Spindle reference: ${Math.round(settings.spindleRpm)} RPM`, "; XY0: material center / Z0: material top", `; Path retract: Z${fmt(settings.safeZ)} mm`, ...(includeOutline ? [`; Profile tabs: ${tabs.length} / width ${fmt(tabWidth)} / height ${fmt(tabHeight)} mm`] : []), order, "; Start the router manually and position Z above the material before cycle start.", "G21", "G90", `G0 X0.000 Y0.000 F${fmt(settings.rapidFeed)}`];
  const pockets = mortises.map((mortise) => mortisePocketPath(mortise, settings.bitDiameter, settings.stepover).map(toMachineOrigin));
  let cuttingStarted = false;
  const appendPath = (path: SeatPoint[], depth: number) => { if (emitPath(lines, path, depth, settings, cuttingStarted)) cuttingStarted = true; };
  if (pockets.length) depths(settings.mortiseDepth, settings.stepDown).forEach((depth, pass) => { lines.push(`; MORTISE PASS ${pass + 1} Z-${fmt(depth)}`); pockets.forEach((path) => appendPath(path, depth)); });
  if (includeOutline) {
    const closedOutside = [...outside, outside[0]];
    const tabFloorDepth = settings.boardThickness - tabHeight;
    const profileDepths = depths(settings.boardThickness, settings.stepDown);
    if (tabs.length && tabWidth > 0 && tabHeight > 0 && tabFloorDepth > 0 && !profileDepths.some(depth => Math.abs(depth - tabFloorDepth) <= .0005)) profileDepths.push(tabFloorDepth);
    profileDepths.sort((a, b) => a - b).forEach((depth, pass) => {
      const tabPass = tabs.length > 0 && tabWidth > 0 && tabHeight > 0 && depth > tabFloorDepth + .0005;
      lines.push(`; OUTSIDE PROFILE PASS ${pass + 1} Z-${fmt(depth)}${tabPass ? " WITH TABS" : ""}`);
      const paths = tabPass ? splitClosedPathAtTabs(outside, tabs, tabWidth) : [closedOutside];
      paths.forEach(path => appendPath(path, depth));
    });
  }
  if (cuttingStarted) lines.push(`G0 Z${fmt(settings.safeZ)}`);
  lines.push("G0 X0.000 Y0.000", "M5", "");
  const code = lines.join("\n");
  const issues = validateGordixGcode(code, settings.safeZ);
  if (issues.length) throw new Error(`GORDIX用G-codeの安全検査に失敗しました:\n${issues.join("\n")}`);
  return code;
}

function dxfPolyline(layer: string, points: SeatPoint[]) {
  // Classic POLYLINE/VERTEX entities are intentionally used for broad R12
  // importer compatibility, including Open Design Alliance based mobile apps.
  const lines = ["0", "POLYLINE", "8", layer, "66", "1", "70", "1", "10", "0.000", "20", "0.000", "30", "0.000"];
  points.forEach(point => lines.push("0", "VERTEX", "8", layer, "10", fmt(point.x), "20", fmt(point.y), "30", "0.000", "70", "0"));
  lines.push("0", "SEQEND", "8", layer);
  return lines;
}

/** Export the adjusted seat outline and dog-bone mortise geometry as closed mm polylines. */
export function generateSeatDxf(outline: SeatPoint[], mortises: Mortise[], bitDiameter: number, mortiseLayout: MortiseLayout = "four", options: { includeOutline?: boolean } = {}) {
  const includeOutline = options.includeOutline !== false;
  if (includeOutline && outline.length < 3) throw new Error("座面の輪郭を先に読み込んでください。");
  if (!includeOutline && !mortises.length) throw new Error("書き出す形状がありません。");
  if (includeOutline && polygonSelfIntersects(outline)) throw new Error("座面輪郭に交差があります。なめらかさを調整してください。");
  const entities = includeOutline ? [...dxfPolyline("SEAT_OUTLINE", outline)] : [];
  const extentPoints = includeOutline ? [...outline] : [];
  mortiseLayoutOutlines(mortises, mortiseLayout, bitDiameter, 8).forEach(dogbone => {
    extentPoints.push(...dogbone);
    entities.push(...dxfPolyline("MORTISES", dogbone));
  });
  const minX = Math.min(...extentPoints.map(point => point.x)), minY = Math.min(...extentPoints.map(point => point.y));
  const maxX = Math.max(...extentPoints.map(point => point.x)), maxY = Math.max(...extentPoints.map(point => point.y));
  return [
    "0", "SECTION", "2", "HEADER",
    "9", "$ACADVER", "1", "AC1009",
    "9", "$INSUNITS", "70", "4",
    "9", "$MEASUREMENT", "70", "1",
    "9", "$LUNITS", "70", "2",
    "9", "$EXTMIN", "10", fmt(minX), "20", fmt(minY), "30", "0.000",
    "9", "$EXTMAX", "10", fmt(maxX), "20", fmt(maxY), "30", "0.000",
    "0", "ENDSEC",
    "0", "SECTION", "2", "TABLES",
    "0", "TABLE", "2", "LTYPE", "70", "1",
    "0", "LTYPE", "2", "CONTINUOUS", "70", "0", "3", "Solid line", "72", "65", "73", "0", "40", "0.000",
    "0", "ENDTAB",
    "0", "TABLE", "2", "LAYER", "70", "2",
    "0", "LAYER", "2", "SEAT_OUTLINE", "70", "0", "62", "7", "6", "CONTINUOUS",
    "0", "LAYER", "2", "MORTISES", "70", "0", "62", "1", "6", "CONTINUOUS",
    "0", "ENDTAB",
    "0", "TABLE", "2", "STYLE", "70", "1",
    "0", "STYLE", "2", "STANDARD", "70", "0", "40", "0.000", "41", "1.000", "50", "0.000", "71", "0", "42", "2.500", "3", "txt", "4", "",
    "0", "ENDTAB", "0", "ENDSEC",
    "0", "SECTION", "2", "BLOCKS", "0", "ENDSEC",
    "0", "SECTION", "2", "ENTITIES", ...entities, "0", "ENDSEC", "0", "EOF", "",
  ].join("\n");
}
