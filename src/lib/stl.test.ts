import { describe, expect, it } from "vitest";
import { bounds, parseStl } from "./stl";

/** One triangle in the XY plane, wound counter-clockwise so +Z is out. */
const TRIANGLE = [0, 0, 0, 1, 0, 0, 0, 1, 0];

function binaryStl(triangles: number[][], header = "binary exporter"): ArrayBuffer {
  const buffer = new ArrayBuffer(84 + triangles.length * 50);
  const view = new DataView(buffer);
  new Uint8Array(buffer).set(new TextEncoder().encode(header.padEnd(80, " ")).slice(0, 80));
  view.setUint32(80, triangles.length, true);

  let offset = 84;
  for (const triangle of triangles) {
    // A deliberately wrong facet normal, to prove it is ignored.
    for (const value of [9, 9, 9]) {
      view.setFloat32(offset, value, true);
      offset += 4;
    }
    for (const value of triangle) {
      view.setFloat32(offset, value, true);
      offset += 4;
    }
    view.setUint16(offset, 0, true);
    offset += 2;
  }
  return buffer;
}

function asciiStl(): ArrayBuffer {
  const text = `solid thing
  facet normal 0 0 0
    outer loop
      vertex 0 0 0
      vertex 1 0 0
      vertex 0 1 0
    endloop
  endfacet
endsolid thing
`;
  return new TextEncoder().encode(text).buffer as ArrayBuffer;
}

describe("parseStl", () => {
  it("reads a binary mesh", () => {
    const mesh = parseStl(binaryStl([TRIANGLE]));
    expect(mesh.triangles).toBe(1);
    expect(Array.from(mesh.positions)).toEqual(TRIANGLE);
  });

  it("reads an ASCII mesh", () => {
    const mesh = parseStl(asciiStl());
    expect(mesh.triangles).toBe(1);
    expect(Array.from(mesh.positions)).toEqual(TRIANGLE);
  });

  it("does not mistake a binary file whose header says 'solid' for ASCII", () => {
    // The exact trap: plenty of exporters write "solid" into the binary header.
    const mesh = parseStl(binaryStl([TRIANGLE], "solid created by some exporter"));
    expect(mesh.triangles).toBe(1);
    expect(Array.from(mesh.positions)).toEqual(TRIANGLE);
  });

  it("computes the facet normal rather than believing the file", () => {
    const mesh = parseStl(binaryStl([TRIANGLE]));
    // The file claimed (9, 9, 9); the geometry says +Z.
    expect(Array.from(mesh.normals.slice(0, 3))).toEqual([0, 0, 1]);
  });

  it("gives every vertex of a facet the same normal", () => {
    const mesh = parseStl(binaryStl([TRIANGLE]));
    expect(Array.from(mesh.normals.slice(0, 3))).toEqual(Array.from(mesh.normals.slice(6, 9)));
  });

  it("survives a degenerate triangle without producing NaN", () => {
    const mesh = parseStl(binaryStl([[0, 0, 0, 0, 0, 0, 0, 0, 0]]));
    expect(Array.from(mesh.normals).every(Number.isFinite)).toBe(true);
  });

  it("drops a trailing partial triangle in ASCII rather than reading past it", () => {
    const text = "solid s\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nvertex 5 5 5\nendsolid";
    const mesh = parseStl(new TextEncoder().encode(text).buffer as ArrayBuffer);
    expect(mesh.triangles).toBe(1);
    expect(mesh.positions.length).toBe(9);
  });

  it("handles an empty mesh", () => {
    const mesh = parseStl(binaryStl([]));
    expect(mesh.triangles).toBe(0);
  });

  it("reads scientific notation in ASCII", () => {
    const text = "solid s\nvertex 1e-3 0 0\nvertex 1 0 0\nvertex 0 1 0\nendsolid";
    const mesh = parseStl(new TextEncoder().encode(text).buffer as ArrayBuffer);
    expect(mesh.positions[0]).toBeCloseTo(0.001);
  });
});

describe("bounds", () => {
  it("finds the centre and the largest span", () => {
    const mesh = parseStl(binaryStl([[0, 0, 0, 4, 0, 0, 0, 2, 0]]));
    const box = bounds(mesh.positions);
    expect(box.center).toEqual([2, 1, 0]);
    expect(box.size).toBe(4);
  });

  it("gives a usable answer for an empty mesh", () => {
    const box = bounds(new Float32Array(0));
    expect(box.size).toBeGreaterThan(0);
  });
});
