import assert from "node:assert/strict";
import test from "node:test";
import {
  buildMortises,
  generateSeatGcode,
  mortisePocketPath,
  mortisePocketPaths,
  validateGordixGcode,
} from "../lib/seatCam.ts";

const toolDiameter = 6;
const settings = {
  boardWidth: 400, boardHeight: 400, boardThickness: 24,
  mortiseDepth: 12, bitDiameter: toolDiameter, stepDown: 3.2,
  stepover: .42, feedRate: 1000, plungeRate: 300,
  rapidFeed: 2400, safeZ: 2, spindleRpm: 12000,
};

function distanceToSegment(point, start, end) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  const position = lengthSquared ? Math.max(0, Math.min(1,
    ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared)) : 0;
  return Math.hypot(point.x - start.x - position * dx, point.y - start.y - position * dy);
}

function pathLength(points) {
  return points.slice(1).reduce((length, point, index) =>
    length + Math.hypot(point.x - points[index].x, point.y - points[index].y), 0);
}

function assertPocketCovered(mortises, paths) {
  const left = Math.floor(Math.min(...mortises.map(m => m.x - m.width / 2)));
  const right = Math.ceil(Math.max(...mortises.map(m => m.x + m.width / 2)));
  const bottom = Math.floor(Math.min(...mortises.map(m => m.y - m.height / 2)));
  const top = Math.ceil(Math.max(...mortises.map(m => m.y + m.height / 2)));
  const segments = paths.flatMap(path => path.slice(1).map((end, index) => [path[index], end]));
  for (let x = left; x <= right; x += 1) for (let y = bottom; y <= top; y += 1) {
    const inside = mortises.some(m => Math.abs(x - m.x) <= m.width / 2 && Math.abs(y - m.y) <= m.height / 2);
    if (!inside) continue;
    const distance = Math.min(...segments.map(([start, end]) => distanceToSegment({ x, y }, start, end)));
    assert.ok(distance <= toolDiameter / 2 + .02, `Uncleared material at (${x}, ${y}): ${distance.toFixed(3)} mm`);
  }
}

test("four separate mortises are fully cleared with a shorter center-out path", () => {
  const mortises = buildMortises(400, 400, 24, 48, 102, 102, "four");
  const paths = mortisePocketPaths(mortises, toolDiameter, .42);
  assert.equal(paths.length, 4);
  paths.forEach((path, index) => assertPocketCovered([mortises[index]], [path]));
  assert.ok(pathLength(paths[0]) < 500); // Prior raster and individual corner trips: about 538 mm.
});

test("cross pocket clears both arms without repeating the central rectangle", () => {
  const mortises = buildMortises(400, 400, 24, 48, 102, 102, "cross");
  const paths = mortisePocketPaths(mortises, toolDiameter, .42);
  assert.equal(paths.length, 3);
  assertPocketCovered(mortises, paths);
  const [bottom, horizontal, top] = paths;
  const armCenter = mortises[0].y;
  assert.ok(bottom.every(point => point.y <= armCenter));
  assert.ok(top.every(point => point.y >= armCenter));
  assert.ok(horizontal.length > bottom.length);
});

test("GORDIX travel and plunge commands remain separate across pocket depths", () => {
  for (const layout of ["four", "cross"]) {
    const mortises = buildMortises(400, 400, 24, 48, 102, 102, layout);
    const code = generateSeatGcode([], mortises, settings, "pocket test", { includeOutline: false });
    assert.deepEqual(validateGordixGcode(code, settings.safeZ), []);
    const comments = code.split("\n").filter(line => line.startsWith("; MORTISE "));
    assert.equal(comments.length, (layout === "four" ? 4 : 3) * 4);
    assert.ok(comments.slice(0, 4).every(line => line.startsWith("; MORTISE 1 PASS ")));
    assert.match(code, /G0 Z2\.000\nG0 X[-\d.]+ Y[-\d.]+ F2400\.000\nG1 Z-3\.200 F300\.000/);
    assert.doesNotMatch(code, /G0[^\n]*\bZ-\d/);
    assert.doesNotMatch(code, /G0[^\n]*\bX[^\n]*\bZ|G0[^\n]*\bZ[^\n]*\bX/);
  }
});

test("combined pocket and outside job uses the requested retract height and machining order", () => {
  const outline = [
    { x: 40, y: 40 }, { x: 360, y: 40 },
    { x: 360, y: 360 }, { x: 40, y: 360 },
  ];
  const mortises = buildMortises(400, 400, 24, 48, 102, 102, "four");
  const code = generateSeatGcode(outline, mortises, { ...settings, safeZ: 5 }, "combined test");
  assert.deepEqual(validateGordixGcode(code, 5), []);
  assert.ok(code.indexOf("; MORTISE 1 PASS 1") < code.indexOf("; OUTSIDE PROFILE PASS 1"));
  assert.doesNotMatch(code, /G0 Z2\.000/);
  assert.doesNotMatch(code, /G0 Z5\.000\nG0 Z5\.000/);
});

test("invalid cutter and depth settings stop export", () => {
  const mortises = buildMortises(400, 400, 24, 48, 102, 102, "four");
  assert.deepEqual(mortisePocketPath({ id: "tiny", x: 200, y: 200, width: 5, height: 20 }, 6, .42), []);
  assert.throws(() => generateSeatGcode([], mortises, { ...settings, bitDiameter: 25 }, "invalid", { includeOutline: false }), /工具径より小さい/);
  assert.throws(() => generateSeatGcode([], mortises, { ...settings, stepover: 0 }, "invalid", { includeOutline: false }), /横送り率/);
  assert.throws(() => generateSeatGcode([], mortises, { ...settings, stepDown: 0 }, "invalid", { includeOutline: false }), /1回の切削深さ/);
  const invalidCross = buildMortises(400, 400, 48, 12, 0, 0, "cross");
  assert.deepEqual(mortisePocketPaths(invalidCross, toolDiameter, .42), []);
  assert.throws(() => generateSeatGcode([], invalidCross, settings, "invalid", { includeOutline: false }), /ポケット経路を生成できません/);
});
