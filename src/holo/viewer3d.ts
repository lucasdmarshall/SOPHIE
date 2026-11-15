import * as THREE from 'three';
import { convertFileSrc } from '@tauri-apps/api/core';
import { HOLO_FRAGMENT, HOLO_VERTEX } from './scene';

export interface ViewerColors {
  primary: string;
  secondary: string;
  accent: string;
}

export type ModelMode = 'holo' | 'wire' | 'solid';

/** Longest frame budget for a viewer window; it shares the GPU with hand tracking. */
const FRAME_MS = 1000 / 40;
/** Idle time before a model starts turning on its own again. */
const AUTO_SPIN_AFTER_MS = 2500;

/**
 * A small 3D stage inside a holo window: drag to turn, wheel (or the scroll gesture)
 * to zoom, double-click to reset. Rendering pauses while the window is hidden.
 */
export class Viewer3D {
  readonly canvas = document.createElement('canvas');
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(40, 1, 0.01, 200);
  private readonly pivot = new THREE.Group();
  private readonly lights = new THREE.Group();
  private readonly resizer: ResizeObserver;
  private readonly time = { value: 0 };
  private readonly flicker = { value: 1 };
  private yaw = 0.6;
  private pitch = 0.25;
  private distance = 6;
  private lastInteraction = -Infinity;
  private lastFrame = 0;
  private frameId = 0;
  private disposed = false;
  /** Set when the canvas needs a redraw even though the window is in the background. */
  private dirty = true;
  /** Called every rendered frame, for overlays that follow the scene. */
  onFrame: (() => void) | null = null;

  constructor(
    private readonly host: HTMLElement,
    private readonly colors: () => ViewerColors,
    private readonly reduced: () => boolean,
  ) {
    this.canvas.className = 'viewer-3d';
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    this.renderer.setClearColor(0x000000, 0);
    this.scene.add(this.pivot, this.lights);
    this.lights.add(new THREE.HemisphereLight(0xdff6ff, 0x1a2030, 1.4));
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(3, 5, 4);
    this.lights.add(key);
    host.append(this.canvas);
    this.resizer = new ResizeObserver(() => this.resize());
    this.resizer.observe(host);
    this.bind();
    this.frameId = requestAnimationFrame(this.frame);
  }

  get stage(): THREE.Group {
    return this.pivot;
  }

  get perspective(): THREE.PerspectiveCamera {
    return this.camera;
  }

  /** A holo surface material tied to this viewer's clock. */
  holoMaterial(color: string, extent: number, world = false, center = new THREE.Vector3()): THREE.ShaderMaterial {
    this.flicker.value = this.reduced() ? 0 : 1;
    return new THREE.ShaderMaterial({
      vertexShader: HOLO_VERTEX,
      fragmentShader: HOLO_FRAGMENT,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      uniforms: {
        uColor: { value: new THREE.Color(color) },
        uTime: this.time,
        uFlicker: this.flicker,
        uBuild: { value: 1 },
        uSeed: { value: Math.random() },
        uExtent: { value: extent },
        uOpacity: { value: 0.55 },
        uWorld: { value: world ? 1 : 0 },
        uCenter: { value: center },
      },
    });
  }

  /** Frame the stage's contents so the whole object is in view. */
  fit(radius: number): void {
    const fov = THREE.MathUtils.degToRad(this.camera.fov);
    this.distance = (radius / Math.sin(fov / 2)) * 1.08;
    this.camera.near = this.distance / 100;
    this.camera.far = this.distance * 10;
    this.camera.updateProjectionMatrix();
  }

  reset(yaw = 0.6, pitch = 0.25): void {
    this.yaw = yaw;
    this.pitch = pitch;
    this.lastInteraction = -Infinity;
  }

  setLit(lit: boolean): void {
    this.lights.visible = lit;
  }

  private bind(): void {
    let last: { x: number; y: number } | null = null;
    this.canvas.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      this.canvas.setPointerCapture(event.pointerId);
      last = { x: event.clientX, y: event.clientY };
      this.lastInteraction = performance.now();
    });
    this.canvas.addEventListener('pointermove', (event) => {
      if (!last) return;
      this.yaw += (event.clientX - last.x) * 0.01;
      this.pitch = THREE.MathUtils.clamp(this.pitch + (event.clientY - last.y) * 0.008, -1.3, 1.3);
      last = { x: event.clientX, y: event.clientY };
      this.lastInteraction = performance.now();
    });
    const end = () => {
      last = null;
    };
    this.canvas.addEventListener('pointerup', end);
    this.canvas.addEventListener('pointercancel', end);
    this.canvas.addEventListener('dblclick', () => this.reset());
    this.canvas.addEventListener(
      'wheel',
      (event) => {
        event.preventDefault();
        this.distance *= event.deltaY > 0 ? 1.1 : 0.9;
        this.lastInteraction = performance.now();
      },
      { passive: false },
    );
  }

  private resize(): void {
    const { clientWidth: width, clientHeight: height } = this.host;
    if (!width || !height) return;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.dirty = true;
  }

  private frame = (now: number) => {
    if (this.disposed) return;
    this.frameId = requestAnimationFrame(this.frame);
    // Hidden (minimized) windows have no layout box: skip all GPU work.
    if (now - this.lastFrame < FRAME_MS || document.hidden || this.canvas.offsetParent === null) return;
    // Only the focused window animates. Others keep their last frame and redraw only
    // after a resize (which clears the canvas) or while the user is turning them.
    const focused = this.host.closest('.hwin')?.classList.contains('focused') ?? true;
    if (!focused && !this.dirty && now - this.lastInteraction > 300) return;
    this.dirty = false;
    const dt = Math.min(0.1, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    this.time.value = now / 1000;
    if (!this.reduced() && now - this.lastInteraction > AUTO_SPIN_AFTER_MS) this.yaw += dt * 0.35;
    this.pivot.rotation.set(this.pitch, this.yaw, 0, 'XYZ');
    this.camera.position.set(0, 0, this.distance);
    this.camera.lookAt(0, 0, 0);
    this.onFrame?.();
    this.renderer.render(this.scene, this.camera);
  };

  /** Animate every holo material on the stage from nothing to fully built. */
  scanIn(duration = 1300): void {
    const materials: THREE.ShaderMaterial[] = [];
    this.pivot.traverse((object) => {
      const material = (object as THREE.Mesh).material;
      for (const item of Array.isArray(material) ? material : [material]) {
        if (item instanceof THREE.ShaderMaterial && item.uniforms.uBuild) materials.push(item);
      }
    });
    if (this.reduced()) return;
    const start = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      for (const material of materials) material.uniforms.uBuild.value = t;
      if (t < 1 && !this.disposed) requestAnimationFrame(step);
    };
    for (const material of materials) material.uniforms.uBuild.value = 0;
    requestAnimationFrame(step);
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.frameId);
    this.resizer.disconnect();
    this.pivot.traverse((object) => {
      const mesh = object as THREE.Mesh;
      mesh.geometry?.dispose();
      const material = mesh.material;
      for (const item of Array.isArray(material) ? material : material ? [material] : []) {
        for (const value of Object.values(item)) if (value instanceof THREE.Texture) value.dispose();
        item.dispose();
      }
    });
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }
}

// ---------- 3D models ----------

function folderOf(path: string): string {
  const cut = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'));
  return cut >= 0 ? path.slice(0, cut) : path;
}

/** Load a glb, gltf, obj or stl file into an object. Loaders are fetched on first use. */
async function loadModel(path: string, extension: string): Promise<THREE.Object3D> {
  const url = convertFileSrc(path);
  if (extension === 'glb' || extension === 'gltf') {
    const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
    // Asset URLs encode the whole Windows path, so relative buffer and texture names
    // cannot be resolved by the browser. Map them back onto the model's folder instead.
    const manager = new THREE.LoadingManager();
    const folder = folderOf(path);
    manager.setURLModifier((resource) => {
      if (/^(data|blob|https?):/i.test(resource)) return resource;
      return convertFileSrc(`${folder}\\${decodeURIComponent(resource).replace(/\//g, '\\')}`);
    });
    const loader = new GLTFLoader(manager);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = extension === 'glb' ? await response.arrayBuffer() : await response.text();
    const gltf = await loader.parseAsync(data, '');
    return gltf.scene;
  }
  if (extension === 'obj') {
    const { OBJLoader } = await import('three/examples/jsm/loaders/OBJLoader.js');
    return new OBJLoader().loadAsync(url);
  }
  const { STLLoader } = await import('three/examples/jsm/loaders/STLLoader.js');
  const geometry = await new STLLoader().loadAsync(url);
  geometry.computeVertexNormals();
  return new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: 0xb8c8d4, metalness: 0.25, roughness: 0.55 }));
}

/** Render a model file in a window body. Returns a cleanup function. */
export async function mountModel(
  body: HTMLElement,
  path: string,
  extension: string,
  colors: () => ViewerColors,
  reduced: () => boolean,
): Promise<() => void> {
  body.classList.add('viewer-stage');
  body.innerHTML = '<div class="viewer-loading"><i></i><span>RECONSTRUCTING MODEL</span></div>';
  const viewer = new Viewer3D(body, colors, reduced);
  let object: THREE.Object3D;
  try {
    object = await loadModel(path, extension);
  } catch (error) {
    viewer.dispose();
    throw error;
  }
  body.querySelector('.viewer-loading')?.remove();

  // Centre and scale the model to a radius of 2.
  const box = new THREE.Box3().setFromObject(object);
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  const scale = sphere.radius > 0 ? 2 / sphere.radius : 1;
  object.position.sub(sphere.center).multiplyScalar(scale);
  object.scale.multiplyScalar(scale);
  viewer.stage.add(object);
  viewer.fit(2);

  const original = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>();
  let meshes = 0;
  let vertices = 0;
  object.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    meshes += 1;
    vertices += mesh.geometry.getAttribute('position')?.count ?? 0;
    if (!mesh.geometry.getAttribute('normal')) mesh.geometry.computeVertexNormals();
    original.set(mesh, mesh.material);
  });

  const palette = colors();
  const holo = viewer.holoMaterial(palette.primary, 2, true);
  const wire = new THREE.MeshBasicMaterial({ color: palette.accent, wireframe: true, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false });
  const setMode = (mode: ModelMode) => {
    for (const [mesh, material] of original) mesh.material = mode === 'solid' ? material : mode === 'wire' ? wire : holo;
    viewer.setLit(mode === 'solid');
    bar.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((button) => button.classList.toggle('active', button.dataset.mode === mode));
    if (mode === 'holo') viewer.scanIn();
  };

  const bar = document.createElement('div');
  bar.className = 'viewer-toolbar';
  bar.innerHTML = `
    <div class="segmented"><button data-mode="holo">HOLO</button><button data-mode="wire">WIRE</button><button data-mode="solid">SOLID</button></div>
    <span>${meshes} MESH · ${vertices.toLocaleString()} VERTS · DRAG TO TURN · SCROLL TO ZOOM</span>`;
  bar.addEventListener('click', (event) => {
    const mode = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-mode]')?.dataset.mode as ModelMode | undefined;
    if (mode) setMode(mode);
  });
  body.append(bar);
  setMode('holo');

  return () => {
    // Shared materials are not attached to every mesh at dispose time; free them here.
    holo.dispose();
    wire.dispose();
    for (const [mesh, material] of original) mesh.material = material;
    viewer.dispose();
  };
}

// ---------- Tables as 3D charts ----------

export interface ChartData {
  labels: string[];
  series: { name: string; values: number[] }[];
  /** Rows dropped because the chart shows only the first ones. */
  omitted: number;
}

const MAX_BARS = 48;
const MAX_SERIES = 4;

/** Split delimited text into rows, honouring double-quoted cells. */
export function parseTable(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
    } else if (char === '"' && cell === '') {
      quoted = true;
    } else if (char === delimiter) {
      row.push(cell);
      cell = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i += 1;
      row.push(cell);
      if (row.some((value) => value.trim() !== '')) rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += char;
    }
  }
  row.push(cell);
  if (row.some((value) => value.trim() !== '')) rows.push(row);
  return rows;
}

function toNumber(value: string): number | null {
  const cleaned = value.trim().replace(/[,$€£¥%\s]/g, '');
  if (cleaned === '' || !/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(cleaned)) return null;
  return Number(cleaned);
}

/** Pick a label column and up to four numeric columns; null when nothing is chartable. */
export function chartData(rows: string[][]): ChartData | null {
  if (rows.length < 2) return null;
  const width = Math.max(...rows.map((row) => row.length));
  const hasHeader = rows[0].some((cell) => cell.trim() !== '' && toNumber(cell) === null);
  const body = hasHeader ? rows.slice(1) : rows;
  if (!body.length) return null;
  const numeric: number[] = [];
  let labelColumn = -1;
  for (let column = 0; column < width; column += 1) {
    const cells = body.map((row) => row[column] ?? '').filter((cell) => cell.trim() !== '');
    const numbers = cells.filter((cell) => toNumber(cell) !== null).length;
    if (cells.length && numbers / cells.length >= 0.8) numeric.push(column);
    else if (labelColumn < 0 && cells.length) labelColumn = column;
  }
  if (!numeric.length) return null;
  const shown = body.slice(0, MAX_BARS);
  return {
    labels: shown.map((row, index) => (labelColumn >= 0 ? (row[labelColumn] ?? '').trim() : String(index + 1)) || String(index + 1)),
    series: numeric.slice(0, MAX_SERIES).map((column) => ({
      name: hasHeader ? rows[0][column]?.trim() || `COL ${column + 1}` : `COL ${column + 1}`,
      values: shown.map((row) => toNumber(row[column] ?? '') ?? 0),
    })),
    omitted: body.length - shown.length,
  };
}

function textSprite(text: string, color: string): THREE.Sprite {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 48;
  const context = canvas.getContext('2d')!;
  context.font = '600 26px "Plus Jakarta Sans", sans-serif';
  context.fillStyle = color;
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  const label = text.length > 14 ? `${text.slice(0, 13)}…` : text;
  context.fillText(label, 128, 24);
  const texture = new THREE.CanvasTexture(canvas);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false }));
  sprite.scale.set(2.2, 0.41, 1);
  return sprite;
}

/** Render table data as a 3D bar chart in a window body. Returns a cleanup function. */
export function mountChart(
  host: HTMLElement,
  data: ChartData,
  colors: () => ViewerColors,
  reduced: () => boolean,
): () => void {
  const viewer = new Viewer3D(host, colors, reduced);
  const palette = colors();
  const tones = [palette.primary, palette.accent, palette.secondary, palette.primary];
  const values = data.series.flatMap((series) => series.values);
  const maxAbs = Math.max(1e-9, ...values.map(Math.abs));
  const spacing = 0.9;
  const depth = 0.9;
  const width = data.labels.length * spacing;
  const deep = data.series.length * depth;
  const chart = new THREE.Group();
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  geometry.translate(0, 0.5, 0);
  const bars: { mesh: THREE.Mesh; label: string; series: string; value: number; height: number }[] = [];
  data.series.forEach((series, s) => {
    const material = viewer.holoMaterial(tones[s], 0.5);
    series.values.forEach((value, i) => {
      const height = (value / maxAbs) * 4;
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(i * spacing - width / 2 + spacing / 2, 0, s * depth - deep / 2 + depth / 2);
      mesh.scale.set(spacing * 0.62, Math.max(0.0001, Math.abs(height)), depth * 0.62);
      if (height < 0) mesh.rotation.x = Math.PI;
      chart.add(mesh);
      bars.push({ mesh, label: data.labels[i], series: series.name, value, height: Math.abs(height) });
    });
  });
  const grid = new THREE.GridHelper(Math.max(width, deep) + 1.5, Math.round(Math.max(width, deep) + 1.5), palette.primary, palette.primary);
  (grid.material as THREE.Material).transparent = true;
  (grid.material as THREE.Material).opacity = 0.18;
  chart.add(grid);
  // Label every bar when few, otherwise every nth, so text never piles up.
  const every = Math.ceil(data.labels.length / 16);
  data.labels.forEach((label, i) => {
    if (i % every) return;
    const sprite = textSprite(label, palette.primary);
    sprite.position.set(i * spacing - width / 2 + spacing / 2, -0.35, deep / 2 + 0.5);
    chart.add(sprite);
  });
  // Centre the bars vertically on the pivot so turning the chart keeps it in frame.
  const top = Math.max(0, ...values) / maxAbs * 4;
  const bottom = Math.min(0, ...values) / maxAbs * 4;
  chart.position.y = -(top + bottom) / 2;
  viewer.stage.add(chart);
  // Fit the footprint, not the bounding sphere: the sphere wastes most of the window.
  viewer.fit(Math.max(width, deep, 4) * 0.42 + 0.6);
  viewer.reset(0.35, 0.32);

  // Bars rise in a wave from left to right.
  const start = performance.now();
  const grow = (now: number) => {
    let running = false;
    for (const [index, bar] of bars.entries()) {
      const t = reduced() ? 1 : Math.min(1, Math.max(0, (now - start - index * 18) / 600));
      if (t < 1) running = true;
      bar.mesh.scale.y = Math.max(0.0001, bar.height * (1 - (1 - t) ** 3));
    }
    if (running) requestAnimationFrame(grow);
  };
  requestAnimationFrame(grow);

  // Hover readout.
  const tip = document.createElement('div');
  tip.className = 'chart-tip';
  tip.hidden = true;
  host.append(tip);
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2(9, 9);
  let hovered: (typeof bars)[number] | null = null;
  viewer.canvas.addEventListener('pointermove', (event) => {
    const rect = viewer.canvas.getBoundingClientRect();
    pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    tip.style.left = `${event.clientX - rect.left + 14}px`;
    tip.style.top = `${event.clientY - rect.top + 10}px`;
  });
  viewer.canvas.addEventListener('pointerleave', () => pointer.set(9, 9));
  viewer.onFrame = () => {
    raycaster.setFromCamera(pointer, viewer.perspective);
    const hit = pointer.x > 2 ? undefined : raycaster.intersectObjects(bars.map((bar) => bar.mesh), false)[0];
    const bar = hit ? bars.find((candidate) => candidate.mesh === hit.object) ?? null : null;
    if (bar === hovered) return;
    hovered = bar;
    tip.hidden = !bar;
    if (bar) tip.innerHTML = `<b></b><span></span>`;
    if (bar) {
      tip.querySelector('b')!.textContent = bar.value.toLocaleString();
      tip.querySelector('span')!.textContent = `${bar.label} · ${bar.series}`;
    }
  };

  const legend = document.createElement('div');
  legend.className = 'chart-legend';
  data.series.forEach((series, s) => {
    const item = document.createElement('span');
    item.style.setProperty('--c', tones[s]);
    item.textContent = series.name;
    legend.append(item);
  });
  if (data.omitted) {
    const note = document.createElement('em');
    note.textContent = `FIRST ${data.labels.length} ROWS · ${data.omitted} MORE IN TABLE`;
    legend.append(note);
  }
  host.append(legend);

  return () => {
    geometry.dispose();
    viewer.dispose();
  };
}
