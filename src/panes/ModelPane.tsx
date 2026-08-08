/**
 * An STL viewer.
 *
 * Three.js is imported dynamically and nowhere else in the app, so a session
 * that never opens a mesh never pays for it — it is by far the largest thing
 * this application can load.
 *
 * The orbit controls are written here rather than pulled from `three/examples`:
 * they are forty lines for the three gestures a model viewer needs, against an
 * add-on with its own event model to reconcile with the pane's. Rotation is
 * kept in spherical coordinates about the model's centre, which is what makes
 * "the model stays where I put it" true no matter where the geometry sits
 * relative to the origin.
 */

import { useEffect, useRef, useState } from "react";
import { assetUrl } from "@/lib/ipc";
import { bounds, parseStl } from "@/lib/stl";
import { fileName } from "@/lib/filetypes";
import type { ModelPaneState } from "@/state/workspace";
import type { PaneProps } from "./types";

export function ModelPane({ pane, onFocus }: PaneProps<ModelPaneState>) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "failed">("loading");
  const [detail, setDetail] = useState<string | null>(null);
  const [triangles, setTriangles] = useState(0);

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    let disposed = false;
    let cleanup: (() => void) | null = null;

    void (async () => {
      try {
        setStatus("loading");
        const [three, url] = await Promise.all([import("three"), assetUrl(pane.path)]);
        const response = await fetch(url);
        if (!response.ok) throw new Error(`could not read the file (${response.status})`);
        const mesh = parseStl(await response.arrayBuffer());
        if (disposed) return;
        if (mesh.triangles === 0) throw new Error("no triangles in this file");

        setTriangles(mesh.triangles);
        cleanup = mount(three, host, mesh);
        setStatus("ready");
      } catch (cause) {
        if (disposed) return;
        setDetail(cause instanceof Error ? cause.message : String(cause));
        setStatus("failed");
      }
    })();

    return () => {
      disposed = true;
      cleanup?.();
    };
  }, [pane.path]);

  return (
    <div className="flex h-full w-full flex-col bg-surface-0" onMouseDown={onFocus}>
      <div className="flex h-7 shrink-0 items-center gap-2 border-b border-border bg-surface-1 px-2">
        <span className="min-w-0 flex-1 truncate font-mono text-[length:var(--fs-10)] text-ink-3">
          {pane.path}
        </span>
        {status === "ready" ? (
          <span className="shrink-0 font-mono text-[length:var(--fs-10)] text-ink-4">
            {triangles.toLocaleString()} triangles · drag to rotate, scroll to zoom
          </span>
        ) : null}
      </div>

      <div className="relative min-h-0 flex-1">
        <div ref={hostRef} className="h-full w-full" />
        {status !== "ready" ? (
          <p className="absolute inset-0 flex items-center justify-center p-4 text-center font-mono text-[length:var(--fs-11)] text-ink-3">
            {status === "loading"
              ? `Reading ${fileName(pane.path)}…`
              : `${fileName(pane.path)} could not be shown — ${detail}`}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/** Build the scene and wire the gestures. Returns a teardown. */
function mount(
  three: typeof import("three"),
  host: HTMLDivElement,
  mesh: { positions: Float32Array; normals: Float32Array },
): () => void {
  const box = bounds(mesh.positions);

  const scene = new three.Scene();
  const renderer = new three.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  host.appendChild(renderer.domElement);
  renderer.domElement.style.display = "block";
  renderer.domElement.style.touchAction = "none";

  const geometry = new three.BufferGeometry();
  geometry.setAttribute("position", new three.BufferAttribute(mesh.positions, 3));
  geometry.setAttribute("normal", new three.BufferAttribute(mesh.normals, 3));

  const model = new three.Mesh(
    geometry,
    new three.MeshStandardMaterial({
      color: 0xc8c8cc,
      roughness: 0.55,
      metalness: 0.05,
      // STL says nothing about winding consistency, and plenty of files are
      // wrong. Drawing both sides is cheaper than showing holes.
      side: three.DoubleSide,
    }),
  );
  // Centred on the origin so the camera has something predictable to orbit.
  model.position.set(-box.center[0], -box.center[1], -box.center[2]);
  scene.add(model);

  scene.add(new three.HemisphereLight(0xffffff, 0x202024, 1.1));
  const key = new three.DirectionalLight(0xffffff, 1.5);
  key.position.set(1, 1.4, 1);
  scene.add(key);

  const camera = new three.PerspectiveCamera(45, 1, box.size / 500, box.size * 100);

  // Spherical camera position: distance, and two angles.
  let radius = box.size * 2.2;
  let theta = Math.PI * 0.25;
  let phi = Math.PI * 0.35;

  const place = () => {
    // Clamped just inside the poles, where the up vector degenerates and the
    // view flips.
    phi = Math.min(Math.PI - 0.01, Math.max(0.01, phi));
    camera.position.set(
      radius * Math.sin(phi) * Math.sin(theta),
      radius * Math.cos(phi),
      radius * Math.sin(phi) * Math.cos(theta),
    );
    camera.lookAt(0, 0, 0);
  };

  let frame = 0;
  const draw = () => {
    frame = 0;
    renderer.render(scene, camera);
  };
  const invalidate = () => {
    // Rendered on demand rather than in a permanent animation loop: a static
    // model has no reason to keep a GPU busy behind an inactive tab.
    if (frame === 0) frame = requestAnimationFrame(draw);
  };

  const resize = () => {
    const width = host.clientWidth;
    const height = host.clientHeight;
    if (width < 2 || height < 2) return;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    invalidate();
  };
  const observer = new ResizeObserver(resize);
  observer.observe(host);
  resize();
  place();
  invalidate();

  let dragging = false;
  let lastX = 0;
  let lastY = 0;

  const onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0) return;
    dragging = true;
    lastX = event.clientX;
    lastY = event.clientY;
    renderer.domElement.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: PointerEvent) => {
    if (!dragging) return;
    theta -= (event.clientX - lastX) * 0.008;
    phi -= (event.clientY - lastY) * 0.008;
    lastX = event.clientX;
    lastY = event.clientY;
    place();
    invalidate();
  };
  const onPointerUp = (event: PointerEvent) => {
    dragging = false;
    if (renderer.domElement.hasPointerCapture(event.pointerId)) {
      renderer.domElement.releasePointerCapture(event.pointerId);
    }
  };
  const onWheel = (event: WheelEvent) => {
    event.preventDefault();
    radius = Math.min(box.size * 20, Math.max(box.size * 0.2, radius * (1 + event.deltaY * 0.001)));
    place();
    invalidate();
  };

  renderer.domElement.addEventListener("pointerdown", onPointerDown);
  renderer.domElement.addEventListener("pointermove", onPointerMove);
  renderer.domElement.addEventListener("pointerup", onPointerUp);
  renderer.domElement.addEventListener("pointercancel", onPointerUp);
  renderer.domElement.addEventListener("wheel", onWheel, { passive: false });

  return () => {
    cancelAnimationFrame(frame);
    observer.disconnect();
    renderer.domElement.removeEventListener("pointerdown", onPointerDown);
    renderer.domElement.removeEventListener("pointermove", onPointerMove);
    renderer.domElement.removeEventListener("pointerup", onPointerUp);
    renderer.domElement.removeEventListener("pointercancel", onPointerUp);
    renderer.domElement.removeEventListener("wheel", onWheel);
    geometry.dispose();
    model.material.dispose();
    // Releases the GPU context; without it every reopened mesh leaks one, and
    // browsers cap how many a page may hold.
    renderer.dispose();
    renderer.domElement.remove();
  };
}
