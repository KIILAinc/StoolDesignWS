import openCvUrl from "@techstark/opencv-js/dist/opencv.js?url";
import type { ExtractResult, SeatPoint } from "./seatCam";

type CvRuntime = typeof import("@techstark/opencv-js");
type RuntimeCandidate = CvRuntime & { Mat?: CvRuntime["Mat"]; onRuntimeInitialized?: () => void };

let openCvReady: Promise<CvRuntime> | null = null;

async function resolveRuntime(candidateValue: unknown) {
  const candidate = await Promise.resolve(candidateValue) as RuntimeCandidate;
  if (candidate?.Mat) return candidate as CvRuntime;
  return new Promise<CvRuntime>((resolve, reject) => {
    const timeout = window.setTimeout(() => reject(new Error("OpenCV.jsの起動がタイムアウトしました。")), 20000);
    candidate.onRuntimeInitialized = () => { window.clearTimeout(timeout); resolve(candidate as CvRuntime); };
  });
}

function getOpenCv() {
  if (openCvReady) return openCvReady;
  openCvReady = new Promise<CvRuntime>((resolve, reject) => {
    const browserWindow = window as Window & { cv?: unknown };
    if (browserWindow.cv) { void resolveRuntime(browserWindow.cv).then(resolve, reject); return; }
    const script = document.createElement("script");
    script.src = openCvUrl;
    script.async = true;
    script.dataset.gordixOpenCv = "true";
    script.onload = () => void resolveRuntime(browserWindow.cv).then(resolve, reject);
    script.onerror = () => reject(new Error("OpenCV.jsを読み込めませんでした。"));
    document.head.appendChild(script);
  });
  return openCvReady;
}

function distance(a: SeatPoint, b: SeatPoint) {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function quadraticPoint(a: SeatPoint, control: SeatPoint, b: SeatPoint, t: number): SeatPoint {
  const inverse = 1 - t;
  return {
    x: inverse * inverse * a.x + 2 * inverse * t * control.x + t * t * b.x,
    y: inverse * inverse * a.y + 2 * inverse * t * control.y + t * t * b.y,
  };
}

function turnAngle(points: SeatPoint[], index: number) {
  const point = points[index];
  const before = points[(index - 1 + points.length) % points.length];
  const after = points[(index + 1) % points.length];
  const incomingLength = distance(before, point);
  const outgoingLength = distance(point, after);
  if (incomingLength < 1e-7 || outgoingLength < 1e-7) return 0;
  const dot = ((point.x - before.x) * (after.x - point.x)
    + (point.y - before.y) * (after.y - point.y)) / (incomingLength * outgoingLength);
  return Math.acos(Math.max(-1, Math.min(1, dot))) * 180 / Math.PI;
}

function polygonSelfIntersects(points: SeatPoint[]) {
  const cross = (a: SeatPoint, b: SeatPoint, c: SeatPoint) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const intersects = (a: SeatPoint, b: SeatPoint, c: SeatPoint, d: SeatPoint) => {
    const abC = cross(a, b, c), abD = cross(a, b, d), cdA = cross(c, d, a), cdB = cross(c, d, b);
    return ((abC > 1e-9 && abD < -1e-9) || (abC < -1e-9 && abD > 1e-9))
      && ((cdA > 1e-9 && cdB < -1e-9) || (cdA < -1e-9 && cdB > 1e-9));
  };
  for (let first = 0; first < points.length; first += 1) {
    const firstNext = (first + 1) % points.length;
    for (let second = first + 1; second < points.length; second += 1) {
      const secondNext = (second + 1) % points.length;
      if (first === second || firstNext === second || secondNext === first) continue;
      if (intersects(points[first], points[firstNext], points[second], points[secondNext])) return true;
    }
  }
  return false;
}

/**
 * Round only gentle vertices with quadratic curves contained inside the two
 * adjacent segments. Unlike the previous cubic tangents, this construction
 * cannot overshoot a sparse contour and create a loop or needle-like spike.
 * Collinear runs remain exactly collinear and intentional hard corners remain.
 */
export function smoothHybridClosed(points: SeatPoint[], smoothing: number) {
  if (points.length < 4 || smoothing <= 0) return points;

  const cornerThreshold = 48;
  const corners = points.map((_, index) => turnAngle(points, index) >= cornerThreshold);
  const trimRatio = .08 + smoothing / 100 * .2;
  const targetSpacing = .012 - smoothing / 100 * .006;
  const output: SeatPoint[] = [];

  for (let index = 0; index < points.length; index += 1) {
    const before = points[(index - 1 + points.length) % points.length];
    const point = points[index];
    const after = points[(index + 1) % points.length];
    if (corners[index]) { output.push(point); continue; }
    const beforeLength = distance(before, point) || 1;
    const afterLength = distance(point, after) || 1;
    const trim = Math.min(beforeLength, afterLength) * trimRatio;
    const incoming = { x: point.x + (before.x - point.x) / beforeLength * trim, y: point.y + (before.y - point.y) / beforeLength * trim };
    const outgoing = { x: point.x + (after.x - point.x) / afterLength * trim, y: point.y + (after.y - point.y) / afterLength * trim };
    output.push(incoming);
    const samples = Math.max(2, Math.min(12, Math.ceil((trim * 2) / targetSpacing)));
    for (let sample = 1; sample <= samples; sample += 1) output.push(quadraticPoint(incoming, point, outgoing, sample / samples));
  }

  return polygonSelfIntersects(output) ? points : output;
}

function pointInsideQuad(x: number, y: number, corners: SeatPoint[]) {
  let inside = false;
  for (let index = 0, before = corners.length - 1; index < corners.length; before = index++) {
    const a = corners[index];
    const b = corners[before];
    if ((a.y > y) !== (b.y > y) && x < (b.x - a.x) * (y - a.y) / (b.y - a.y || 1e-9) + a.x) inside = !inside;
  }
  return inside;
}

function maskOutsidePaper(
  mat: { rows: number; cols: number; data: Uint8Array },
  corners: SeatPoint[],
  border: number,
) {
  const thickness = Math.max(2, border);
  for (let y = 0; y < mat.rows; y += 1) {
    for (let x = 0; x < mat.cols; x += 1) {
      const normalizedX = x / Math.max(1, mat.cols - 1);
      const normalizedY = y / Math.max(1, mat.rows - 1);
      if (!pointInsideQuad(normalizedX, normalizedY, corners)
        || x < thickness || y < thickness || x >= mat.cols - thickness || y >= mat.rows - thickness) {
        mat.data[y * mat.cols + x] = 0;
      }
    }
  }
}

export async function extractSeatOutlineWithOpenCV(
  imageData: ImageData,
  threshold: number,
  smoothing: number,
  gapClosing: number,
  paperCorners: SeatPoint[],
): Promise<ExtractResult> {
  const cv = await getOpenCv();
  const width = imageData.width;
  const height = imageData.height;
  const imageArea = width * height;
  const src = cv.matFromImageData(imageData);
  const gray = new cv.Mat();
  const blurred = new cv.Mat();
  const blackHat = new cv.Mat();
  const binary = new cv.Mat();
  const thickened = new cv.Mat();
  const illuminationSize = Math.max(21, Math.round(Math.min(width, height) * .085) | 1);
  const illuminationKernel = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(illuminationSize, illuminationSize));
  const penKernel = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(3, 3));
  const activeCorners = paperCorners.length === 4 ? paperCorners : [{x:0,y:0},{x:1,y:0},{x:1,y:1},{x:0,y:1}];

  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, blurred, new cv.Size(3, 3), 0, 0, cv.BORDER_DEFAULT);

    // Black-hat emphasizes thin dark pen strokes while suppressing broad paper shadows.
    cv.morphologyEx(blurred, blackHat, cv.MORPH_BLACKHAT, illuminationKernel);
    const penThreshold = 44 - (Math.max(55, Math.min(225, threshold)) - 55) / 170 * 39;
    cv.threshold(blackHat, binary, penThreshold, 255, cv.THRESH_BINARY);
    cv.dilate(binary, thickened, penKernel);
    maskOutsidePaper(thickened, activeCorners, Math.round(Math.min(width, height) * .012));

    const requestedSize = Math.max(3, Math.round(3 + gapClosing / 100 * 18));
    const baseSize = requestedSize % 2 === 0 ? requestedSize + 1 : requestedSize;
    const attemptSizes = [baseSize, Math.min(27, baseSize + 4), Math.min(31, baseSize + 8)]
      .filter((value, index, values) => values.indexOf(value) === index);

    let selected: InstanceType<CvRuntime["Mat"]> | null = null;
    let selectedArea = 0;
    let usedCloseSize = baseSize;
    let rejectedAtBorder = 0;

    for (const closeSize of attemptSizes) {
      const closed = new cv.Mat();
      const contours = new cv.MatVector();
      const hierarchy = new cv.Mat();
      const closeKernel = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(closeSize, closeSize));
      try {
        cv.morphologyEx(thickened, closed, cv.MORPH_CLOSE, closeKernel);
        cv.findContours(closed, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
        let bestIndex = -1;
        let bestScore = -Infinity;
        let bestArea = 0;
        const margin = Math.min(width, height) * .018;

        for (let index = 0; index < contours.size(); index += 1) {
          const contour = contours.get(index);
          try {
            const area = Math.abs(cv.contourArea(contour, false));
            const areaRatio = area / imageArea;
            if (areaRatio < .055 || areaRatio > .92) continue;
            const rect = cv.boundingRect(contour);
            const touchesBorder = rect.x <= margin || rect.y <= margin
              || rect.x + rect.width >= width - margin || rect.y + rect.height >= height - margin;
            if (touchesBorder) { rejectedAtBorder += 1; continue; }
            const containsCenter = cv.pointPolygonTest(contour, new cv.Point(width / 2, height / 2), false) >= 0;
            const centerX = rect.x + rect.width / 2;
            const centerY = rect.y + rect.height / 2;
            const centerDistance = Math.hypot((centerX - width / 2) / width, (centerY - height / 2) / height);
            const score = area * (containsCenter ? 1.5 : .45) * Math.max(.5, 1 - centerDistance);
            if (score > bestScore) { bestIndex = index; bestScore = score; bestArea = area; }
          } finally {
            contour.delete();
          }
        }

        if (bestIndex >= 0) {
          selected = contours.get(bestIndex).clone();
          selectedArea = bestArea;
          usedCloseSize = closeSize;
          break;
        }
      } finally {
        closed.delete();
        contours.delete();
        hierarchy.delete();
        closeKernel.delete();
      }
    }

    if (!selected) {
      const edgeNote = rejectedAtBorder ? "用紙の端や影とつながった輪郭は除外しました。" : "";
      return { points: [], confidence: "poor", message: `閉じた座面輪郭を見つけられません。${edgeNote}「線の切れ目補正」を上げてください。` };
    }

    const filled = cv.Mat.zeros(height, width, cv.CV_8UC1);
    const selectedVector = new cv.MatVector();
    const filledContours = new cv.MatVector();
    const filledHierarchy = new cv.Mat();
    const approximated = new cv.Mat();
    try {
      selectedVector.push_back(selected);
      cv.drawContours(filled, selectedVector, 0, new cv.Scalar(255), cv.FILLED);
      cv.findContours(filled, filledContours, filledHierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_NONE);
      if (!filledContours.size()) return { points: [], confidence: "poor", message: "座面の内側領域を作成できませんでした。" };
      const interior = filledContours.get(0);
      try {
        const perimeter = cv.arcLength(interior, true);
        const epsilon = perimeter * (.00055 + smoothing * .000025);
        cv.approxPolyDP(interior, approximated, epsilon, true);
      } finally {
        interior.delete();
      }

      const points: SeatPoint[] = [];
      for (let index = 0; index + 1 < approximated.data32S.length; index += 2) {
        points.push({ x: approximated.data32S[index] / width, y: approximated.data32S[index + 1] / height });
      }
      if (points.length < 4) return { points: [], confidence: "poor", message: "輪郭の点が少なすぎます。なめらかさを少し下げてください。" };

      const areaRatio = selectedArea / imageArea;
      const autoClosed = usedCloseSize > baseSize;
      const confidence = areaRatio >= .12 && areaRatio <= .88 ? "good" : "fair";
      const smoothedCandidate = smoothHybridClosed(points, smoothing);
      const smoothingFallback = smoothedCandidate === points;
      const smoothed = smoothedCandidate;
      const closeMessage = autoClosed ? `切れ目を自動で接続（補正 ${usedCloseSize}px）。` : "";
      const borderMessage = rejectedAtBorder ? `端の誤輪郭${rejectedAtBorder}件を除外。` : "";
      return {
        points: smoothed,
        confidence,
        message: `OpenCVで輪郭を抽出（基準点${points.length}点）。${smoothingFallback ? "自己交差を検知したため安全な元輪郭を使用。" : "直線を保ち、曲線部だけを安全に丸めました。"}${closeMessage}${borderMessage}`,
      };
    } finally {
      selected.delete();
      filled.delete();
      selectedVector.delete();
      filledContours.delete();
      filledHierarchy.delete();
      approximated.delete();
    }
  } finally {
    src.delete();
    gray.delete();
    blurred.delete();
    blackHat.delete();
    binary.delete();
    thickened.delete();
    illuminationKernel.delete();
    penKernel.delete();
  }
}
