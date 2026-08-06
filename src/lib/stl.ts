/**
 * Reading STL meshes.
 *
 * STL comes in two formats that share an extension and, awkwardly, can share a
 * first word: the ASCII form begins with `solid`, and plenty of binary
 * exporters write `solid` into their 80-byte header too. Sniffing the text is
 * therefore not reliable, and the check used here is arithmetic instead — a
 * binary file's length is exactly `84 + 50 × triangles`, which a text file will
 * essentially never satisfy by accident.
 *
 * Normals are recomputed rather than trusted. Many exporters write zeroed or
 * inconsistent facet normals, and a viewer that believes them renders a model
 * that is lit from nowhere.
 */

export interface Mesh {
  /** Three vertices per triangle, three floats per vertex. */
  positions: Float32Array;
  normals: Float32Array;
  triangles: number;
}

const HEADER_BYTES = 80;
const TRIANGLE_BYTES = 50;

export function parseStl(buffer: ArrayBuffer): Mesh {
  return isBinary(buffer) ? parseBinary(buffer) : parseAscii(new TextDecoder().decode(buffer));
}

function isBinary(buffer: ArrayBuffer): boolean {
  if (buffer.byteLength < HEADER_BYTES + 4) return false;
  const count = new DataView(buffer).getUint32(HEADER_BYTES, true);
  return buffer.byteLength === HEADER_BYTES + 4 + count * TRIANGLE_BYTES;
}

function parseBinary(buffer: ArrayBuffer): Mesh {
  const view = new DataView(buffer);
  const triangles = view.getUint32(HEADER_BYTES, true);
  const positions = new Float32Array(triangles * 9);

  let offset = HEADER_BYTES + 4;
  for (let index = 0; index < triangles; index += 1) {
    // The facet normal occupies the first twelve bytes and is skipped; see the
    // note above on why it is not trusted.
    offset += 12;
    for (let vertex = 0; vertex < 9; vertex += 1) {
      positions[index * 9 + vertex] = view.getFloat32(offset, true);
      offset += 4;
    }
    // Two-byte attribute count, used by some tools for colour. Ignored.
    offset += 2;
  }

  return { positions, normals: faceNormals(positions), triangles };
}

function parseAscii(text: string): Mesh {
  const values: number[] = [];
  // Matching `vertex x y z` directly rather than walking the grammar: the rest
  // of the format carries nothing this viewer needs, and exporters differ in
  // how they lay it out.
  const pattern = /vertex\s+(-?[\d.eE+-]+)\s+(-?[\d.eE+-]+)\s+(-?[\d.eE+-]+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    values.push(Number(match[1]), Number(match[2]), Number(match[3]));
  }

  // Anything not a whole triangle is trailing damage; drop it rather than
  // rendering a facet with an undefined vertex.
  const triangles = Math.floor(values.length / 9);
  const positions = new Float32Array(values.slice(0, triangles * 9));
  return { positions, normals: faceNormals(positions), triangles };
}

/** Flat shading: every vertex of a facet gets that facet's own normal. */
function faceNormals(positions: Float32Array): Float32Array {
  const normals = new Float32Array(positions.length);

  for (let index = 0; index < positions.length; index += 9) {
    const ax = positions[index], ay = positions[index + 1], az = positions[index + 2];
    const bx = positions[index + 3], by = positions[index + 4], bz = positions[index + 5];
    const cx = positions[index + 6], cy = positions[index + 7], cz = positions[index + 8];

    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;

    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;

    const length = Math.hypot(nx, ny, nz);
    // A degenerate triangle has no normal to speak of; leaving it at zero is
    // better than dividing by zero and shading it with NaN.
    if (length > 0) {
      nx /= length;
      ny /= length;
      nz /= length;
    }

    for (let vertex = 0; vertex < 3; vertex += 1) {
      normals[index + vertex * 3] = nx;
      normals[index + vertex * 3 + 1] = ny;
      normals[index + vertex * 3 + 2] = nz;
    }
  }

  return normals;
}

/** Axis-aligned bounds, for framing the camera on load. */
export function bounds(positions: Float32Array) {
  if (positions.length === 0) {
    return { center: [0, 0, 0] as const, size: 1 };
  }
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

  for (let index = 0; index < positions.length; index += 3) {
    minX = Math.min(minX, positions[index]);
    maxX = Math.max(maxX, positions[index]);
    minY = Math.min(minY, positions[index + 1]);
    maxY = Math.max(maxY, positions[index + 1]);
    minZ = Math.min(minZ, positions[index + 2]);
    maxZ = Math.max(maxZ, positions[index + 2]);
  }

  return {
    center: [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2] as const,
    size: Math.max(maxX - minX, maxY - minY, maxZ - minZ, 1e-6),
  };
}
