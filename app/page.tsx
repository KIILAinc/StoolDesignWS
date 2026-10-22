"use client";

import NextImageBase, { type ImageProps } from "next/image";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Check, ChevronLeft, ChevronRight, Crosshair, Download, Focus, ImagePlus, Ruler, Settings2, ShieldCheck, SlidersHorizontal, Upload, X } from "lucide-react";
import { buildMortises, closedPathLength, generateSeatDxf, generateSeatGcode, mortiseLayoutOutlines, mortisePocketPath, offsetPolygon, perspectiveCorrect, pointInPolygon, pointOnClosedPath, polygonSelfIntersects, type MortiseLayout, type SeatPoint } from "@/lib/seatCam";
import { extractSeatOutlineWithOpenCV } from "@/lib/opencvContours";

type Step = 1 | 2 | 3;
type TransformDrag =
  | { mode: "move"; pointerId: number; start: SeatPoint; offsetX: number; offsetY: number }
  | { mode: "scale"; pointerId: number; opposite: SeatPoint; diagonal: SeatPoint; center: SeatPoint; scale: number; offsetX: number; offsetY: number };
type BoxCorner = "nw" | "ne" | "se" | "sw";
type TabDrag = { pointerId: number; index: number; startPosition: number; moved: boolean };
type ExportGeometryMode = "seat-with-mortises" | "outline-only" | "mortises-only";
type StaffSettings = {
  threshold: number; gapClosing: number; imageOpacity: number;
  boardWidth: number; boardHeight: number; boardThickness: number;
  exportGeometryMode: ExportGeometryMode; mortiseLayout: MortiseLayout; mortiseWidth: number; mortiseHeight: number; mortiseGapX: number; mortiseGapY: number; mortiseDepth: number;
  bitDiameter: number; stepDown: number; feedRate: number; plungeRate: number; safeZ: number; spindleRpm: number; tabWidth: number; tabHeight: number;
  showToolpath: boolean;
};

function NextImage(props: ImageProps) {
  const src = typeof props.src === "string" && props.src.startsWith("/chairs/") ? `.${props.src}` : props.src;
  return <NextImageBase {...props} src={src} />;
}

const defaultCorners: SeatPoint[] = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
const stepLabels = ["写真をよみこむ", "ざめんの形を決める", "マシンにおくる"];
const staffSettingsKey = "chair-workshop:staff-settings:v1";
const defaultStaffSettings: StaffSettings = {
  threshold: 142, gapClosing: 50, imageOpacity: 24,
  boardWidth: 400, boardHeight: 400, boardThickness: 24,
  exportGeometryMode: "seat-with-mortises", mortiseLayout: "four", mortiseWidth: 24, mortiseHeight: 48, mortiseGapX: 102, mortiseGapY: 102, mortiseDepth: 12,
  bitDiameter: 6, stepDown: 3.2, feedRate: 1000, plungeRate: 300, safeZ: 2, spindleRpm: 18000, tabWidth: 12, tabHeight: 3,
  showToolpath: false,
};

function normalizeStaffSettings(value: unknown): StaffSettings {
  const source = value && typeof value === "object" ? value as Partial<StaffSettings> : {};
  const number = (key: keyof StaffSettings, fallback: number, min: number, max = Number.POSITIVE_INFINITY) => {
    const candidate = source[key];
    return typeof candidate === "number" && Number.isFinite(candidate) ? Math.max(min, Math.min(max, candidate)) : fallback;
  };
  const boardWidth = number("boardWidth", 400, 100);
  const boardHeight = number("boardHeight", 400, 100);
  const boardThickness = number("boardThickness", 24, 3);
  const bitDiameter = number("bitDiameter", 6, 1);
  const mortiseWidth = number("mortiseWidth", 24, bitDiameter);
  const mortiseHeight = number("mortiseHeight", 48, bitDiameter);
  return {
    threshold: number("threshold", 142, 55, 225), gapClosing: number("gapClosing", 50, 0, 100), imageOpacity: number("imageOpacity", 24, 0, 80),
    boardWidth, boardHeight, boardThickness,
    exportGeometryMode: source.exportGeometryMode === "outline-only" ? "outline-only" : source.exportGeometryMode === "mortises-only" ? "mortises-only" : "seat-with-mortises",
    mortiseLayout: source.mortiseLayout === "cross" ? "cross" : "four", mortiseWidth, mortiseHeight,
    mortiseGapX: number("mortiseGapX", 102, 0, Math.max(0, boardWidth - mortiseHeight * 2)),
    mortiseGapY: number("mortiseGapY", 102, 0, Math.max(0, boardHeight - mortiseHeight * 2)),
    mortiseDepth: number("mortiseDepth", 12, .5, boardThickness),
    bitDiameter, stepDown: number("stepDown", 3.2, .1, 3.2), feedRate: number("feedRate", 1000, 50),
    plungeRate: number("plungeRate", 300, 20), safeZ: number("safeZ", 2, .1), spindleRpm: number("spindleRpm", 18000, 1000),
    tabWidth: number("tabWidth", 12, 1), tabHeight: number("tabHeight", 3, .5, boardThickness),
    showToolpath: typeof source.showToolpath === "boolean" ? source.showToolpath : false,
  };
}

function Field({ label, value, unit, min = 0, max, step = 1, onChange }: { label: string; value: number; unit: string; min?: number; max?: number; step?: number; onChange: (value: number) => void }) {
  return <label className="seat-field"><span>{label}</span><span className="seat-input"><input type="number" value={value} min={min} max={max} step={step} onChange={event => { const next = event.currentTarget.valueAsNumber; if (Number.isFinite(next)) onChange(next); }} /><b>{unit}</b></span></label>;
}

function Range({ label, value, min, max, onChange, low, high }: { label: string; value: number; min: number; max: number; onChange: (value: number) => void; low: string; high: string }) {
  return <label className="range-field"><span>{label}<em>{value}</em></span><input aria-label={label} type="range" value={value} min={min} max={max} onChange={event => onChange(Number(event.target.value))} /><small><i>{low}</i><i>{high}</i></small></label>;
}

function StepProgress({ step, enabled, onStep }: { step: Step; enabled: boolean; onStep: (step: Step) => void }) {
  return <nav className="step-progress" aria-label="作業の進み具合">{stepLabels.map((label, index) => {
    const id = (index + 1) as Step;
    return <div className={`step-item ${step === id ? "is-active" : ""} ${step > id ? "is-done" : ""}`} key={label}>
      <button onClick={() => onStep(id)} disabled={id > 1 && !enabled}><span>{step > id ? <Check /> : id}</span><b>{label}</b></button>
      {id < 3 && <i />}
    </div>;
  })}</nav>;
}

function CheckItem({ ok, text }: { ok: boolean; text: string }) {
  return <div className={ok ? "checked" : ""}><span>{ok ? <Check /> : "!"}</span>{text}</div>;
}

function Decorations() {
  return <div className="chair-decorations" aria-hidden="true">
    <NextImage className="chair-decor chair-a" src={chairAsset("image1.png")} width={210} height={221} alt="" />
    <NextImage className="chair-decor chair-b" src={chairAsset("image2.png")} width={190} height={214} alt="" />
    <NextImage className="chair-decor chair-c" src={chairAsset("image5.png")} width={180} height={193} alt="" />
    <NextImage className="chair-decor chair-d" src={chairAsset("image6.png")} width={200} height={208} alt="" />
    <NextImage className="chair-decor chair-e" src={chairAsset("image7.png")} width={170} height={201} alt="" />
    <NextImage className="chair-decor chair-f" src={chairAsset("image8.png")} width={150} height={166} alt="" />
    <NextImage className="chair-decor chair-g" src={chairAsset("image1.png")} width={142} height={150} alt="" />
    <NextImage className="chair-decor chair-h" src={chairAsset("image5.png")} width={138} height={148} alt="" />
    <NextImage className="chair-decor chair-i" src={chairAsset("image2.png")} width={146} height={164} alt="" />
    <NextImage className="chair-decor chair-j" src={chairAsset("image6.png")} width={140} height={145} alt="" />
    <NextImage className="chair-decor chair-k" src={chairAsset("image8.png")} width={132} height={146} alt="" />
    <NextImage className="chair-decor chair-l" src={chairAsset("image7.png")} width={128} height={151} alt="" />
  </div>;
}

function polyline(points: SeatPoint[], height: number) { return points.map(point => `${point.x},${height - point.y}`).join(" "); }
function chairAsset(name: string) { return `./chairs/${name}`; }
function downloadText(text: string, name: string) { const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" })); const anchor = document.createElement("a"); anchor.href = url; anchor.download = name; anchor.click(); URL.revokeObjectURL(url); }

export default function SeatWorkshop() {
  const fileRef = useRef<HTMLInputElement>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const processingRequestRef = useRef(0);
  const transformDragRef = useRef<TransformDrag | null>(null);
  const tabDragRef = useRef<TabDrag | null>(null);
  const suppressTabClickRef = useRef(false);
  const [step, setStep] = useState<Step>(1);
  const [staffOpen, setStaffOpen] = useState(false);
  const [fileName, setFileName] = useState("");
  const [imageUrl, setImageUrl] = useState("");
  const [threshold, setThreshold] = useState(142);
  const [gapClosing, setGapClosing] = useState(50);
  const [smoothing, setSmoothing] = useState(58);
  const [imageOpacity, setImageOpacity] = useState(24);
  const [corners, setCorners] = useState<SeatPoint[]>(defaultCorners);
  const [calibrating, setCalibrating] = useState(false);
  const [pendingCorners, setPendingCorners] = useState<SeatPoint[]>([]);
  const [rawOutline, setRawOutline] = useState<SeatPoint[]>([]);
  const [pathScale, setPathScale] = useState(100);
  const [pathOffsetX, setPathOffsetX] = useState(0);
  const [pathOffsetY, setPathOffsetY] = useState(0);
  const [transforming, setTransforming] = useState(false);
  const [extractMessage, setExtractMessage] = useState("");
  const [confidence, setConfidence] = useState<"good" | "fair" | "poor">("poor");
  const [processing, setProcessing] = useState(false);
  const [boardWidth, setBoardWidth] = useState(400);
  const [boardHeight, setBoardHeight] = useState(400);
  const [boardThickness, setBoardThickness] = useState(24);
  const [exportGeometryMode, setExportGeometryMode] = useState<ExportGeometryMode>("seat-with-mortises");
  const [mortiseLayout, setMortiseLayout] = useState<MortiseLayout>("four");
  const [mortiseWidth, setMortiseWidth] = useState(24);
  const [mortiseHeight, setMortiseHeight] = useState(48);
  const [mortiseGapX, setMortiseGapX] = useState(102);
  const [mortiseGapY, setMortiseGapY] = useState(102);
  const [mortiseDepth, setMortiseDepth] = useState(12);
  const [bitDiameter, setBitDiameter] = useState(6);
  const [stepDown, setStepDown] = useState(3.2);
  const [feedRate, setFeedRate] = useState(1000);
  const [plungeRate, setPlungeRate] = useState(300);
  const [safeZ, setSafeZ] = useState(2);
  const [spindleRpm, setSpindleRpm] = useState(18000);
  const [tabWidth, setTabWidth] = useState(12);
  const [tabHeight, setTabHeight] = useState(3);
  const [tabs, setTabs] = useState<number[]>([]);
  const [tabEditing, setTabEditing] = useState(false);
  const [showToolpath, setShowToolpath] = useState(false);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [savedStaffSignature, setSavedStaffSignature] = useState(JSON.stringify(defaultStaffSettings));

  const staffSettings = useMemo<StaffSettings>(() => ({
    threshold, gapClosing, imageOpacity, boardWidth, boardHeight, boardThickness,
    exportGeometryMode, mortiseLayout, mortiseWidth, mortiseHeight, mortiseGapX, mortiseGapY, mortiseDepth,
    bitDiameter, stepDown, feedRate, plungeRate, safeZ, spindleRpm, tabWidth, tabHeight, showToolpath,
  }), [threshold, gapClosing, imageOpacity, boardWidth, boardHeight, boardThickness, exportGeometryMode, mortiseLayout, mortiseWidth, mortiseHeight, mortiseGapX, mortiseGapY, mortiseDepth, bitDiameter, stepDown, feedRate, plungeRate, safeZ, spindleRpm, tabWidth, tabHeight, showToolpath]);
  const staffSignature = JSON.stringify(staffSettings);
  const staffSettingsDirty = settingsLoaded && staffSignature !== savedStaffSignature;

  useEffect(() => {
    let saved: StaffSettings | null = null;
    try {
      const raw = window.localStorage.getItem(staffSettingsKey);
      if (raw) saved = normalizeStaffSettings(JSON.parse(raw));
    } catch {
      window.localStorage.removeItem(staffSettingsKey);
    }
    const frame = window.requestAnimationFrame(() => {
      if (saved) {
        setThreshold(saved.threshold); setGapClosing(saved.gapClosing); setImageOpacity(saved.imageOpacity);
        setBoardWidth(saved.boardWidth); setBoardHeight(saved.boardHeight); setBoardThickness(saved.boardThickness);
        setExportGeometryMode(saved.exportGeometryMode); setMortiseLayout(saved.mortiseLayout); setMortiseWidth(saved.mortiseWidth); setMortiseHeight(saved.mortiseHeight); setMortiseGapX(saved.mortiseGapX); setMortiseGapY(saved.mortiseGapY); setMortiseDepth(saved.mortiseDepth);
        setBitDiameter(saved.bitDiameter); setStepDown(saved.stepDown); setFeedRate(saved.feedRate); setPlungeRate(saved.plungeRate); setSafeZ(saved.safeZ); setSpindleRpm(saved.spindleRpm); setTabWidth(saved.tabWidth); setTabHeight(saved.tabHeight); setShowToolpath(saved.showToolpath);
        setSavedStaffSignature(JSON.stringify(saved));
      }
      setSettingsLoaded(true);
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  const saveStaffSettings = () => {
    window.localStorage.setItem(staffSettingsKey, staffSignature);
    setSavedStaffSignature(staffSignature);
  };

  const corrected = useMemo(() => {
    const normalized = perspectiveCorrect(rawOutline, corners).filter(point => Number.isFinite(point.x) && Number.isFinite(point.y));
    if (!normalized.length) return [];
    const placed = normalized.map(point => ({ x: point.x * boardWidth, y: (1 - point.y) * boardHeight }));
    const xs = placed.map(point => point.x), ys = placed.map(point => point.y);
    const centerX = (Math.min(...xs) + Math.max(...xs)) / 2, centerY = (Math.min(...ys) + Math.max(...ys)) / 2;
    const scale = pathScale / 100;
    return placed.map(point => ({ x: centerX + (point.x - centerX) * scale + pathOffsetX, y: centerY + (point.y - centerY) * scale + pathOffsetY }));
  }, [rawOutline, corners, boardWidth, boardHeight, pathScale, pathOffsetX, pathOffsetY]);

  const outlineBox = useMemo(() => {
    if (corrected.length < 3) return null;
    const xs = corrected.map(point => point.x), ys = corrected.map(point => boardHeight - point.y);
    const x = Math.min(...xs), y = Math.min(...ys);
    return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
  }, [corrected, boardHeight]);
  const outside = useMemo(() => offsetPolygon(corrected, bitDiameter / 2), [corrected, bitDiameter]);
  const mortises = useMemo(() => buildMortises(boardWidth, boardHeight, mortiseWidth, mortiseHeight, mortiseGapX, mortiseGapY, mortiseLayout), [boardWidth, boardHeight, mortiseWidth, mortiseHeight, mortiseGapX, mortiseGapY, mortiseLayout]);
  const mortiseOutlines = useMemo(() => mortiseLayoutOutlines(mortises, mortiseLayout, bitDiameter), [mortises, mortiseLayout, bitDiameter]);
  const includeOutlineInExport = exportGeometryMode !== "mortises-only";
  const exportedMortises = exportGeometryMode === "outline-only" ? [] : mortises;
  const exportedMortiseOutlines = exportGeometryMode === "outline-only" ? [] : mortiseOutlines;
  const outsideLength = useMemo(() => closedPathLength(outside), [outside]);
  const tabMarkers = useMemo(() => tabs.map((position, index) => ({
    index, position,
    center: pointOnClosedPath(outside, position),
    start: pointOnClosedPath(outside, position - (outsideLength > 0 ? tabWidth / outsideLength / 2 : 0)),
    end: pointOnClosedPath(outside, position + (outsideLength > 0 ? tabWidth / outsideLength / 2 : 0)),
  })), [tabs, outside, outsideLength, tabWidth]);
  const mortisesWithinBoard = useMemo(() => mortises.every(mortise => {
    const pad = bitDiameter;
    return mortise.x - mortise.width / 2 - pad >= 0 && mortise.x + mortise.width / 2 + pad <= boardWidth
      && mortise.y - mortise.height / 2 - pad >= 0 && mortise.y + mortise.height / 2 + pad <= boardHeight;
  }), [mortises, bitDiameter, boardWidth, boardHeight]);
  const mortisesInside = useMemo(() => exportGeometryMode === "outline-only" ? true : exportGeometryMode === "mortises-only" ? mortisesWithinBoard : (corrected.length > 2 && mortises.every(mortise => {
    const pad = bitDiameter;
    return [{ x: mortise.x - mortise.width / 2 - pad, y: mortise.y - mortise.height / 2 - pad }, { x: mortise.x + mortise.width / 2 + pad, y: mortise.y - mortise.height / 2 - pad }, { x: mortise.x + mortise.width / 2 + pad, y: mortise.y + mortise.height / 2 + pad }, { x: mortise.x - mortise.width / 2 - pad, y: mortise.y + mortise.height / 2 + pad }].every(point => pointInPolygon(point, corrected));
  })), [corrected, mortises, bitDiameter, exportGeometryMode, mortisesWithinBoard]);
  const outlineInsideBoard = corrected.length > 2 && corrected.every(point => point.x >= 0 && point.x <= boardWidth && point.y >= 0 && point.y <= boardHeight);
  const outlineSafe = corrected.length > 2 && !polygonSelfIntersects(corrected) && !polygonSelfIntersects(outside);
  const cuttingSettingsValid = Number.isFinite(stepDown) && stepDown > 0 && stepDown <= 3.2 + 1e-6
    && Number.isFinite(mortiseDepth) && mortiseDepth > 0 && mortiseDepth <= boardThickness + 1e-6
    && Number.isFinite(safeZ) && safeZ > 0
    && Number.isFinite(tabWidth) && tabWidth > 0
    && Number.isFinite(tabHeight) && tabHeight > 0 && tabHeight <= boardThickness;
  const outlineChecksPass = exportGeometryMode === "mortises-only" || (corrected.length > 2 && outlineInsideBoard && outlineSafe);
  const shapeReadyForNext = exportGeometryMode === "mortises-only" ? mortisesWithinBoard : outlineInsideBoard && outlineSafe;
  const ready = outlineChecksPass && mortisesInside && cuttingSettingsValid;

  const processImage = useCallback(async () => {
    const image = imageRef.current;
    if (!image) return;
    const requestId = ++processingRequestRef.current;
    setProcessing(true);
    const maxPixels = 420, canvasScale = maxPixels / Math.max(boardWidth, boardHeight), canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(boardWidth * canvasScale));
    canvas.height = Math.max(1, Math.round(boardHeight * canvasScale));
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) { setProcessing(false); return; }
    context.fillStyle = "white";
    context.fillRect(0, 0, canvas.width, canvas.height);
    const sourceWidth = image.naturalWidth || image.width, sourceHeight = image.naturalHeight || image.height;
    const fit = Math.min(canvas.width / sourceWidth, canvas.height / sourceHeight), drawWidth = sourceWidth * fit, drawHeight = sourceHeight * fit;
    context.drawImage(image, (canvas.width - drawWidth) / 2, (canvas.height - drawHeight) / 2, drawWidth, drawHeight);
    try {
      const result = await extractSeatOutlineWithOpenCV(context.getImageData(0, 0, canvas.width, canvas.height), threshold, smoothing, gapClosing, corners);
      if (requestId !== processingRequestRef.current) return;
      setRawOutline(result.points); setConfidence(result.confidence); setExtractMessage(result.confidence === "good" ? "きれいな形が見つかりました！" : result.confidence === "fair" ? "形が見つかりました。つぎの画面で整えられます" : "形をうまく見つけられませんでした。スタッフと確認してください");
    } catch {
      if (requestId !== processingRequestRef.current) return;
      setRawOutline([]); setConfidence("poor"); setExtractMessage("写真から形を見つけられませんでした。スタッフと確認してください");
    } finally { if (requestId === processingRequestRef.current) setProcessing(false); }
  }, [threshold, smoothing, gapClosing, corners, boardWidth, boardHeight]);
  useEffect(() => { const timer = window.setTimeout(() => void processImage(), 100); return () => window.clearTimeout(timer); }, [processImage, imageUrl]);

  const resetPathTransform = () => { setPathScale(100); setPathOffsetX(0); setPathOffsetY(0); };
  const loadFile = (file?: File) => {
    if (!file || !file.type.startsWith("image/")) return;
    const reader = new FileReader();
    reader.onload = () => { const image = new Image(); image.onload = () => { imageRef.current = image; setImageUrl(String(reader.result)); }; image.src = String(reader.result); };
    reader.readAsDataURL(file); setFileName(file.name); setCorners(defaultCorners); resetPathTransform(); setTabs([]); setTabEditing(false); setStep(1);
  };
  const nearestPathPosition = (points: SeatPoint[], target: SeatPoint) => {
    const total = closedPathLength(points);
    let travelled = 0, bestDistance = Number.POSITIVE_INFINITY, bestPosition = 0;
    points.forEach((start, index) => {
      const end = points[(index + 1) % points.length];
      const dx = end.x - start.x, dy = end.y - start.y, lengthSquared = dx * dx + dy * dy;
      const ratio = lengthSquared > 0 ? Math.max(0, Math.min(1, ((target.x - start.x) * dx + (target.y - start.y) * dy) / lengthSquared)) : 0;
      const projected = { x: start.x + dx * ratio, y: start.y + dy * ratio };
      const distance = Math.hypot(target.x - projected.x, target.y - projected.y);
      const segmentLength = Math.sqrt(lengthSquared);
      if (distance < bestDistance) { bestDistance = distance; bestPosition = total > 0 ? (travelled + segmentLength * ratio) / total : 0; }
      travelled += segmentLength;
    });
    return { position: bestPosition, distance: bestDistance };
  };
  const handlePreviewClick = (event: React.MouseEvent<SVGSVGElement>) => {
    const svgPoint = event.currentTarget.createSVGPoint(); svgPoint.x = event.clientX; svgPoint.y = event.clientY;
    const matrix = event.currentTarget.getScreenCTM(); if (!matrix) return;
    const local = svgPoint.matrixTransform(matrix.inverse());
    if (tabEditing) {
      if (suppressTabClickRef.current) { suppressTabClickRef.current = false; return; }
      const nearest = nearestPathPosition(outside, { x: local.x, y: boardHeight - local.y });
      if (nearest.distance <= Math.max(18, bitDiameter * 2)) setTabs(current => [...current, nearest.position]);
      return;
    }
    if (!calibrating) return;
    const point = { x: Math.max(0, Math.min(1, local.x / boardWidth)), y: Math.max(0, Math.min(1, local.y / boardHeight)) }, next = [...pendingCorners, point];
    if (next.length === 4) { setCorners(next); setPendingCorners([]); setCalibrating(false); } else setPendingCorners(next);
  };
  const pointerInPreview = (svg: SVGSVGElement, clientX: number, clientY: number) => { const point = svg.createSVGPoint(); point.x = clientX; point.y = clientY; const matrix = svg.getScreenCTM(); return matrix ? point.matrixTransform(matrix.inverse()) : null; };
  const startMove = (event: React.PointerEvent<SVGRectElement>) => {
    if (calibrating) return; const svg = event.currentTarget.ownerSVGElement, point = svg && pointerInPreview(svg, event.clientX, event.clientY); if (!point) return;
    event.preventDefault(); event.stopPropagation(); event.currentTarget.setPointerCapture(event.pointerId); transformDragRef.current = { mode: "move", pointerId: event.pointerId, start: { x: point.x, y: point.y }, offsetX: pathOffsetX, offsetY: pathOffsetY }; setTransforming(true);
  };
  const startScale = (event: React.PointerEvent<SVGCircleElement>, corner: BoxCorner) => {
    if (calibrating || !outlineBox) return;
    const left = outlineBox.x, right = outlineBox.x + outlineBox.width, top = outlineBox.y, bottom = outlineBox.y + outlineBox.height;
    const handles = { nw: { x: left, y: top }, ne: { x: right, y: top }, se: { x: right, y: bottom }, sw: { x: left, y: bottom } }, opposites = { nw: handles.se, ne: handles.sw, se: handles.nw, sw: handles.ne }, handle = handles[corner], opposite = opposites[corner];
    event.preventDefault(); event.stopPropagation(); event.currentTarget.setPointerCapture(event.pointerId); transformDragRef.current = { mode: "scale", pointerId: event.pointerId, opposite, diagonal: { x: handle.x - opposite.x, y: handle.y - opposite.y }, center: { x: (left + right) / 2, y: (top + bottom) / 2 }, scale: pathScale, offsetX: pathOffsetX, offsetY: pathOffsetY }; setTransforming(true);
  };
  const startTabDrag = (event: React.PointerEvent<SVGCircleElement>, index: number) => {
    if (!tabEditing) return;
    event.preventDefault(); event.stopPropagation(); event.currentTarget.setPointerCapture(event.pointerId);
    tabDragRef.current = { pointerId: event.pointerId, index, startPosition: tabs[index], moved: false };
  };
  const updateTransform = (event: React.PointerEvent<SVGSVGElement>) => {
    const tabDrag = tabDragRef.current;
    if (tabDrag?.pointerId === event.pointerId) {
      const point = pointerInPreview(event.currentTarget, event.clientX, event.clientY); if (!point) return;
      const nearest = nearestPathPosition(outside, { x: point.x, y: boardHeight - point.y });
      if (Math.abs(nearest.position - tabDrag.startPosition) > .001) tabDrag.moved = true;
      setTabs(current => current.map((position, index) => index === tabDrag.index ? nearest.position : position));
      event.preventDefault(); return;
    }
    const drag = transformDragRef.current; if (!drag || drag.pointerId !== event.pointerId) return;
    const point = pointerInPreview(event.currentTarget, event.clientX, event.clientY); if (!point) return; event.preventDefault();
    if (drag.mode === "move") { setPathOffsetX(Math.round((drag.offsetX + point.x - drag.start.x) * 10) / 10); setPathOffsetY(Math.round((drag.offsetY - (point.y - drag.start.y)) * 10) / 10); return; }
    const lengthSquared = drag.diagonal.x ** 2 + drag.diagonal.y ** 2; if (lengthSquared < 1e-6) return;
    const projected = ((point.x - drag.opposite.x) * drag.diagonal.x + (point.y - drag.opposite.y) * drag.diagonal.y) / lengthSquared, nextScale = Math.round(Math.max(25, Math.min(200, drag.scale * projected))), factor = nextScale / drag.scale, nextCenter = { x: drag.opposite.x + (drag.center.x - drag.opposite.x) * factor, y: drag.opposite.y + (drag.center.y - drag.opposite.y) * factor };
    setPathScale(nextScale); setPathOffsetX(Math.round((drag.offsetX + nextCenter.x - drag.center.x) * 10) / 10); setPathOffsetY(Math.round((drag.offsetY - (nextCenter.y - drag.center.y)) * 10) / 10);
  };
  const endTransform = (event: React.PointerEvent<SVGSVGElement>) => {
    if (tabDragRef.current?.pointerId === event.pointerId) { suppressTabClickRef.current = tabDragRef.current.moved; tabDragRef.current = null; return; }
    if (transformDragRef.current?.pointerId !== event.pointerId) return; transformDragRef.current = null; setTransforming(false);
  };
  const exportGcode = () => { if (!ready) return; const code = generateSeatGcode(corrected, exportedMortises, { boardWidth, boardHeight, boardThickness, mortiseDepth, bitDiameter, stepDown, stepover: .42, feedRate, plungeRate, rapidFeed: 2400, safeZ, spindleRpm, tabs, tabWidth, tabHeight }, fileName || "seat-workshop", { includeOutline: includeOutlineInExport }); const base = (fileName || "seat-workshop").replace(/\.[^.]+$/, "").replace(/[^\w\-\u3040-\u30ff\u3400-\u9fff]+/g, "_"); const suffix = exportGeometryMode === "outline-only" ? "_輪郭のみ" : exportGeometryMode === "mortises-only" ? "_ほぞ穴のみ" : ""; downloadText(code, `${base}${suffix}_加工データ.gcode`); };
  const exportDxf = () => { if (!ready) return; const code = generateSeatDxf(corrected, exportedMortises, bitDiameter, mortiseLayout, { includeOutline: includeOutlineInExport }); const base = (fileName || "seat-workshop").replace(/\.[^.]+$/, "").replace(/[^\w\-\u3040-\u30ff\u3400-\u9fff]+/g, "_"); const suffix = exportGeometryMode === "outline-only" ? "_輪郭のみ" : exportGeometryMode === "mortises-only" ? "_ほぞ穴のみ" : ""; downloadText(code, `${base}${suffix}_図面.dxf`); };

  const seatCanvas = <div className="board-stage"><svg className={`seat-canvas ${calibrating ? "is-calibrating" : ""} ${tabEditing ? "is-tab-editing" : ""} ${outlineBox && !calibrating && !tabEditing ? "has-transform-box" : ""} ${transforming ? "is-transforming" : ""}`} viewBox={`0 0 ${boardWidth} ${boardHeight}`} style={{ aspectRatio: `${boardWidth} / ${boardHeight}` }} onClick={handlePreviewClick} onPointerMove={updateTransform} onPointerUp={endTransform} onPointerCancel={endTransform}>
    <rect x="1.5" y="1.5" width={boardWidth - 3} height={boardHeight - 3} rx="5" fill="#f4d7a1" stroke="#d6a45d" strokeWidth="3" />
    {imageUrl && <image href={imageUrl} x="10" y="10" width={boardWidth - 20} height={boardHeight - 20} preserveAspectRatio="xMidYMid meet" opacity={imageOpacity / 100} />}{corrected.length > 2 && <polygon points={polyline(corrected, boardHeight)} className="seat-shape" />}{includeOutlineInExport && (showToolpath || tabEditing) && outside.length > 2 && <polygon points={polyline(outside, boardHeight)} className="outside-path" />}
    <g className="mortise">{exportedMortiseOutlines.map((outline, index) => <polygon key={`mortise-outline-${index}`} points={polyline(outline, boardHeight)} />)}<title>{mortiseLayout === "cross" ? "十字のほぞ穴" : "4つのほぞ穴"}</title></g>
    {showToolpath && exportedMortises.map(mortise => <polyline key={`pocket-path-${mortise.id}`} points={polyline(mortisePocketPath(mortise, bitDiameter, .42), boardHeight)} className="pocket-path" />)}
    <g className={`profile-tabs ${tabEditing ? "is-editing" : ""}`}>{tabMarkers.map(marker => <g key={`tab-${marker.index}`}><line x1={marker.start.x} y1={boardHeight - marker.start.y} x2={marker.end.x} y2={boardHeight - marker.end.y} /><circle cx={marker.center.x} cy={boardHeight - marker.center.y} r="7" onPointerDown={event => startTabDrag(event, marker.index)} onClick={event => { event.stopPropagation(); if (suppressTabClickRef.current) { suppressTabClickRef.current = false; return; } if (tabEditing) setTabs(current => current.filter((_, index) => index !== marker.index)); }} /><text x={marker.center.x} y={boardHeight - marker.center.y + 3}>{marker.index + 1}</text></g>)}</g>
    {calibrating && pendingCorners.map((corner, index) => <g key={index} className="calibration-point"><circle cx={corner.x * boardWidth} cy={corner.y * boardHeight} r="7" /><text x={corner.x * boardWidth} y={corner.y * boardHeight + 3}>{index + 1}</text></g>)}
    {outlineBox && !calibrating && !tabEditing && <g className="outline-transform"><rect className="transform-hit-area" x={outlineBox.x} y={outlineBox.y} width={outlineBox.width} height={outlineBox.height} onPointerDown={startMove} /><rect className="transform-frame" x={outlineBox.x} y={outlineBox.y} width={outlineBox.width} height={outlineBox.height} />{([['nw', outlineBox.x, outlineBox.y], ['ne', outlineBox.x + outlineBox.width, outlineBox.y], ['se', outlineBox.x + outlineBox.width, outlineBox.y + outlineBox.height], ['sw', outlineBox.x, outlineBox.y + outlineBox.height]] as const).map(([corner, x, y]) => <circle key={corner} className="transform-handle" cx={x} cy={y} r="7" onPointerDown={event => startScale(event, corner)} />)}</g>}
  </svg>{calibrating && <div className="calibration-hint"><Crosshair /><b>{pendingCorners.length + 1}/4</b> {['左上', '右上', '右下', '左下'][pendingCorners.length]}をクリック</div>}{tabEditing && <div className="tab-edit-panel"><span>輪郭をクリックして追加・丸をドラッグして移動・丸をクリックして削除</span><div><button type="button" disabled={!tabs.length} onClick={() => setTabs([])}>すべて削除</button><button type="button" onClick={() => setTabEditing(false)}>完了</button></div></div>}</div>;

  return <main className={`workshop-app step-${step}`}><Decorations /><input ref={fileRef} className="visually-hidden" type="file" accept="image/*" onChange={event => loadFile(event.target.files?.[0])} />
    <header className="workshop-header"><h1><NextImage src={chairAsset("workshop-logo.png")} width={1774} height={887} priority alt="みんなでイスをつくろう" /></h1><button className="staff-button" onClick={() => setStaffOpen(true)}><Settings2 />スタッフ設定</button><StepProgress step={step} enabled={corrected.length > 2} onStep={setStep} /></header>

    {step === 1 && <section className="step-page photo-step"><div className="page-heading"><i /><h2>デザインの写真をよみこもう</h2><i /></div><div className="photo-layout"><button className={`big-photo-button ${imageUrl ? "has-photo" : ""}`} onClick={() => fileRef.current?.click()} onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); loadFile(event.dataTransfer.files[0]); }}>{imageUrl ? <><svg className="photo-preview-svg" role="img" aria-label="よみこんだデザイン"><image href={imageUrl} width="100%" height="100%" preserveAspectRatio="xMidYMid meet" /></svg><span className="change-photo"><ImagePlus />写真をかえる</span></> : <><NextImage className="upload-chair" src="/chairs/image8.png" width={1193} height={1318} alt="" /><strong><Upload />写真をえらぶ</strong></>}</button></div>{imageUrl && <div className={`scan-status ${confidence}`}>{processing ? <NextImage className="chair-loader" src="/chairs/image7.png" width={1153} height={1364} alt="" /> : corrected.length ? <Check /> : <AlertTriangle />}<span>{processing ? "写真から形をさがしています…" : extractMessage}</span></div>}<div className="page-actions single"><button className="big-primary" disabled={!corrected.length || processing} onClick={() => setStep(2)}>つぎへ<ChevronRight /></button></div></section>}

    {step === 2 && <section className="step-page shape-step"><div className="page-heading"><i /><h2>ざめんの形を決めよう</h2><i /></div><div className="shape-layout"><aside className="kid-controls"><div className="kid-card smooth-card"><h3><span>〜</span>線をきれいに</h3><Range label="なめらかさ" value={smoothing} min={0} max={100} onChange={setSmoothing} low="手がきの感じ" high="なめらか" /></div></aside><div className="board-card">{seatCanvas}</div><aside className={`kid-warning ${mortisesInside && shapeReadyForNext ? "is-ok" : ""}`}><span>{mortisesInside && shapeReadyForNext ? <Check /> : <AlertTriangle />}</span><p>{exportGeometryMode === "mortises-only" ? (mortisesWithinBoard ? "ほぞ穴だけを書き出すモードです" : "ほぞ穴が材料からはみ出しています") : !outlineInsideBoard ? "形が板からはみ出しています" : !outlineSafe ? "輪郭に鋭い折り返しがあります。なめらかさを調整してください" : exportGeometryMode === "outline-only" ? "輪郭だけを書き出すモードです" : !mortisesInside ? "脚をつける場所に重なっています。DXFはそのまま保存できます" : "脚をつける場所もだいじょうぶ！"}</p></aside></div><div className="page-actions"><button className="big-secondary" onClick={() => fileRef.current?.click()}><ImagePlus />写真をえらび直す</button><button className="big-primary" disabled={!shapeReadyForNext} onClick={() => setStep(3)}>この形でOK<ChevronRight /></button></div></section>}

    {step === 3 && <section className="step-page send-step"><div className="page-heading"><i /><h2>マシンにおくる準備</h2><i /></div><div className="finish-layout"><div className="finish-board"><h3>できあがりの形</h3><svg viewBox={`0 0 ${boardWidth} ${boardHeight}`}><rect width={boardWidth} height={boardHeight} rx="8" fill="#f7d9a3" />{includeOutlineInExport && corrected.length > 2 && <polygon points={polyline(corrected, boardHeight)} fill="#fff5e4" stroke="#18a6a5" strokeWidth="4" />}{exportedMortiseOutlines.map((outline, index) => <polygon key={`finish-mortise-${index}`} points={polyline(outline, boardHeight)} fill="#b47a3a" />)}{includeOutlineInExport && <g className="profile-tabs">{tabMarkers.map(marker => <line key={`finish-tab-${marker.index}`} x1={marker.start.x} y1={boardHeight - marker.start.y} x2={marker.end.x} y2={boardHeight - marker.end.y} />)}</g>}</svg></div><div className="finish-card"><h3><ShieldCheck />スタッフといっしょに確認</h3><div className="friendly-checks"><CheckItem ok={includeOutlineInExport ? corrected.length > 2 && outlineSafe : mortisesWithinBoard} text={includeOutlineInExport ? "輪郭が安全につながっている" : "ほぞ穴が材料の中に入っている"} /><CheckItem ok={includeOutlineInExport ? outlineInsideBoard : true} text={includeOutlineInExport ? "形が板の中に入っている" : "外周加工を含まない"} /><CheckItem ok={mortisesInside} text={exportGeometryMode === "outline-only" ? "輪郭だけを書き出す" : exportGeometryMode === "mortises-only" ? "ほぞ穴だけを書き出す" : "脚をつける場所と重なっていない"} /><CheckItem ok={cuttingSettingsValid} text="スタッフの準備ができている" /></div></div></div><div className={`ready-message ${ready ? "is-ready" : ""}`}>{ready ? <><Check /><b>準備できました</b></> : includeOutlineInExport && !outlineInsideBoard ? <><AlertTriangle /><b>形が板からはみ出しています</b><span>形を板の中へ移動してください</span></> : includeOutlineInExport && !outlineSafe ? <><AlertTriangle /><b>輪郭に鋭い折り返しがあります</b><span>なめらかさを調整してください</span></> : !mortisesInside ? <><AlertTriangle /><b>{exportGeometryMode === "mortises-only" ? "ほぞ穴が材料からはみ出しています" : "DXFは保存できます"}</b><span>{exportGeometryMode === "mortises-only" ? "ほぞ穴の寸法と間隔を確認してください" : "ほぞ穴と重なっているため、加工データの保存は無効です"}</span></> : !cuttingSettingsValid ? <><AlertTriangle /><b>スタッフ設定を確認してください</b><span>ポケット深さと1回の切削深さを確認します</span></> : <><AlertTriangle /><b>形を確認してください</b></>}</div><div className="page-actions export-actions"><button className="big-secondary action-back" onClick={() => setStep(2)}><ChevronLeft />形を直す</button><button className="big-secondary" disabled={!ready} onClick={exportDxf}><Download />図面（DXF）を保存</button><button className="big-primary download-button" disabled={!ready} onClick={exportGcode}><Download />加工データを保存</button></div></section>}

    {staffOpen && <div className="staff-layer">
      <button className="staff-scrim" aria-label="スタッフ設定を閉じる" onClick={() => setStaffOpen(false)} />
      <aside className="staff-panel" role="dialog" aria-modal="true" aria-label="スタッフ設定">
        <header><div><small>STAFF ONLY</small><h2><Settings2 />スタッフ設定</h2></div><button aria-label="閉じる" onClick={() => setStaffOpen(false)}><X /></button></header>
        <section><h3><SlidersHorizontal />写真の読み取り</h3><Range label="線の抽出しきい値" value={threshold} min={55} max={225} onChange={setThreshold} low="濃い線だけ" high="薄い線も" /><Range label="線の切れ目補正" value={gapClosing} min={0} max={100} onChange={setGapClosing} low="小さい切れ目" high="大きい切れ目" /><Range label="写真の濃さ" value={imageOpacity} min={0} max={80} onChange={setImageOpacity} low="薄く" high="濃く" /><button className="staff-outline-button" disabled={!imageUrl} onClick={() => { setStaffOpen(false); setStep(2); setCalibrating(true); setPendingCorners([]); }}><Focus />用紙の四隅を指定</button></section>
        <section><h3><Ruler />材料とほぞ穴</h3><div className="field-grid">
          <div className="mortise-layout-field"><span>書き出し内容</span><div role="group" aria-label="書き出し内容"><button type="button" className={exportGeometryMode === "seat-with-mortises" ? "is-active" : ""} aria-pressed={exportGeometryMode === "seat-with-mortises"} onClick={() => setExportGeometryMode("seat-with-mortises")}>輪郭＋ほぞ穴</button><button type="button" className={exportGeometryMode === "outline-only" ? "is-active" : ""} aria-pressed={exportGeometryMode === "outline-only"} onClick={() => setExportGeometryMode("outline-only")}>輪郭のみ</button><button type="button" className={exportGeometryMode === "mortises-only" ? "is-active" : ""} aria-pressed={exportGeometryMode === "mortises-only"} onClick={() => setExportGeometryMode("mortises-only")}>ほぞ穴のみ</button></div></div>
          <Field label="材料の幅" value={boardWidth} unit="mm" min={100} onChange={setBoardWidth} />
          <Field label="材料の奥行き" value={boardHeight} unit="mm" min={100} onChange={setBoardHeight} />
          <Field label="板厚" value={boardThickness} unit="mm" min={3} step={.5} onChange={value => { setBoardThickness(value); setMortiseDepth(current => Math.min(current, value)); setTabHeight(current => Math.min(current, value)); }} />
          {exportGeometryMode !== "outline-only" && <><div className="mortise-layout-field"><span>ほぞ穴の形状</span><div role="group" aria-label="ほぞ穴の形状"><button type="button" className={mortiseLayout === "four" ? "is-active" : ""} aria-pressed={mortiseLayout === "four"} onClick={() => setMortiseLayout("four")}>4つのほぞ穴</button><button type="button" className={mortiseLayout === "cross" ? "is-active" : ""} aria-pressed={mortiseLayout === "cross"} onClick={() => setMortiseLayout("cross")}>十字の形状</button></div></div><Field label="穴の幅" value={mortiseWidth} unit="mm" min={bitDiameter} onChange={setMortiseWidth} /><Field label="穴の長さ" value={mortiseHeight} unit="mm" min={bitDiameter} onChange={setMortiseHeight} /><Field label={mortiseLayout === "cross" ? "十字の横：中央の長さ" : "左右の穴：内側の間隔"} value={mortiseGapX} unit="mm" min={0} max={Math.max(0, boardWidth - mortiseHeight * 2)} onChange={value => setMortiseGapX(Math.max(0, Math.min(value, boardWidth - mortiseHeight * 2)))} /><Field label={mortiseLayout === "cross" ? "十字の縦：中央の長さ" : "上下の穴：内側の間隔"} value={mortiseGapY} unit="mm" min={0} max={Math.max(0, boardHeight - mortiseHeight * 2)} onChange={value => setMortiseGapY(Math.max(0, Math.min(value, boardHeight - mortiseHeight * 2)))} /><Field label="ポケット深さ" value={mortiseDepth} unit="mm" min={.5} max={boardThickness} step={.5} onChange={value => setMortiseDepth(Math.max(.5, Math.min(value, boardThickness)))} /></>}
        </div></section>
        <section><h3><Settings2 />切削条件</h3>
          <div className="field-grid"><Field label="ビット径" value={bitDiameter} unit="mm" min={1} step={.1} onChange={setBitDiameter} /><Field label="1回の切削深さ" value={stepDown} unit="mm" min={.1} max={3.2} step={.1} onChange={value => setStepDown(Math.max(.1, Math.min(3.2, value)))} /><Field label="XY送り速度" value={feedRate} unit="mm/min" min={50} onChange={setFeedRate} /><Field label="Z送り速度" value={plungeRate} unit="mm/min" min={20} onChange={setPlungeRate} /><Field label="パス間退避高さ" value={safeZ} unit="mm" min={.1} step={.5} onChange={value => setSafeZ(Math.max(.1, value))} /><Field label="回転数の目安" value={spindleRpm} unit="rpm" min={1000} step={500} onChange={setSpindleRpm} /><Field label="タブの幅" value={tabWidth} unit="mm" min={1} step={1} onChange={value => setTabWidth(Math.max(1, value))} /><Field label="タブの高さ" value={tabHeight} unit="mm" min={.5} max={boardThickness} step={.5} onChange={value => setTabHeight(Math.max(.5, Math.min(value, boardThickness)))} /></div>
          {includeOutlineInExport && <button className="staff-outline-button" disabled={corrected.length < 3} onClick={() => { setStaffOpen(false); setStep(2); setTabEditing(true); setCalibrating(false); }}>{tabs.length ? `タブ位置を編集（${tabs.length}か所）` : "タブ位置を編集"}</button>}
          <p className="staff-note">パス間退避の初期値はZ2.000 mmです。設定値を変更しても、XY移動とZ切込みは必ず分離します。</p>
          <p className="staff-note">ドッグボーンはビット径に合わせて最小限で自動追加されます。</p>
          <label className="toolpath-toggle"><input type="checkbox" checked={showToolpath} onChange={event => setShowToolpath(event.target.checked)} /><span />加工パスを表示</label>
        </section>
        {settingsLoaded && <footer className={`staff-savebar ${staffSettingsDirty ? "is-dirty" : ""}`} aria-live="polite">
          <span>{staffSettingsDirty ? "変更はまだ保存されていません" : <><Check />設定は保存済みです</>}</span>
          {staffSettingsDirty && <button type="button" onClick={saveStaffSettings}>設定を保存</button>}
        </footer>}
      </aside>
    </div>}
  </main>;
}
