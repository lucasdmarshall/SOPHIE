import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ease, Tweener } from './tween';
import type { CoreStyle, HoloEntry, HoloListing, HoloTheme, SceneLayout, Tone, WorldStyle } from './types';

interface GalaxyNode {
  entry: HoloEntry;
  group: THREE.Group;
  body: THREE.Group;
  hit: THREE.Mesh;
  container: THREE.Group;
  /** Resting position inside its container. */
  home: THREE.Vector3;
  /** Where the user dragged it, relative to home. */
  offset: THREE.Vector3;
  phase: number;
  /** Position in the listing, which is also its slot index. */
  index: number;
  /** 0 = at the core, 1 = at home, >1 = flung outward. */
  radial: number;
  scale: number;
  hover: number;
  /** 0 = not materialized, 1 = fully built. Drives the holo shader's scan-in and dissolve. */
  build: number;
  /** Slot in its batches: folders use the dirWire and dirCore batches, files the file batch. */
  instance: number;
  label: HTMLElement | null;
  /** Last values written to the label, so unchanged ones are not written again. */
  labelOpacity: string;
  labelTransform: string;
  labelHot: boolean;
}

/**
 * Every node part of one kind is drawn by a single InstancedMesh. Per-node state that
 * used to live in its own material's uniforms (build, seed, opacity, tone) lives in
 * instance attributes instead, so a folder of 240 items costs 3 draw calls, not 360.
 */
interface NodeBatch {
  mesh: THREE.InstancedMesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  build: THREE.InstancedBufferAttribute;
  seed: THREE.InstancedBufferAttribute;
  opacity: THREE.InstancedBufferAttribute;
  tone: THREE.InstancedBufferAttribute;
  /** Opacity factor the old per-node material used for this part. */
  baseOpacity: number;
}

const TONE_INDEX: Record<Tone, number> = { primary: 0, secondary: 1, accent: 2 };

interface Slot {
  container: number;
  home: THREE.Vector3;
}

interface Placement {
  slots: Slot[];
  containers: number;
  /** Radius of the arrangement, used to fit the camera. */
  extent: number;
  orbitRadii: number[];
  /** Pairs of slot indices joined by a line (network layouts only). */
  links?: [number, number][];
  /** Radius of the helix, globe or neural cloud. */
  radius?: number;
  /** Height of the helix. */
  height?: number;
  /** Camera distance that frames the whole arrangement (network layouts only). */
  distance?: number;
  /** How far below the centre the floor grid must sit to clear the arrangement. */
  floor?: number;
}

interface Pulse {
  link: number;
  progress: number;
  speed: number;
  /** Travels from the link's second node to its first. */
  reverse: boolean;
}

type DragMode = 'none' | 'pending' | 'node' | 'view';

export type QualityTier = 'high' | 'balanced' | 'saver';

/** scale = fraction of native resolution; cap = max rendered frames per second. */
export const QUALITY: Record<QualityTier, { scale: number; bloom: boolean; cap: number }> = {
  high: { scale: 1, bloom: true, cap: 60 },
  balanced: { scale: 0.75, bloom: true, cap: 40 },
  saver: { scale: 0.55, bloom: false, cap: 30 },
};

const IMAGE = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'heic', 'ico']);
const MEDIA = new Set(['mp4', 'mkv', 'mov', 'avi', 'webm', 'mp3', 'wav', 'flac', 'ogg', 'm4a']);
const DOCS = new Set(['pdf', 'doc', 'docx', 'txt', 'md', 'rtf', 'xls', 'xlsx', 'csv', 'ppt', 'pptx', 'odt']);
const CODE = new Set(['ts', 'js', 'rs', 'py', 'json', 'html', 'css', 'c', 'cpp', 'h', 'java', 'go', 'toml', 'yml', 'yaml', 'sh', 'ps1']);
/** Pointer travel (px) before a press becomes a drag instead of a click. */
const DRAG_THRESHOLD = 7;
/** How long a node stays targeted after the pointer slips off it. */
const HOVER_STICK_MS = 260;
const ORBIT_START = 12;
const ORBIT_STEP = 5.2;
/** Arc length between neighbours on an orbit. */
const ORBIT_SPACING = 3.8;

export function toneFor(entry: HoloEntry): Tone {
  if (entry.is_dir || DOCS.has(entry.extension)) return 'primary';
  if (IMAGE.has(entry.extension) || MEDIA.has(entry.extension)) return 'accent';
  return 'secondary';
}

export function categoryFor(entry: HoloEntry): string {
  if (entry.is_dir) return 'Folder';
  if (IMAGE.has(entry.extension)) return 'Image';
  if (MEDIA.has(entry.extension)) return 'Media';
  if (DOCS.has(entry.extension)) return 'Document';
  if (CODE.has(entry.extension)) return 'Code / data';
  return entry.extension ? `${entry.extension.toUpperCase()} file` : 'File';
}

/** Layouts drawn as a network: no centerpiece, nodes joined by links that carry pulses. */
const LINKED = new Set<SceneLayout>(['helix', 'globe', 'neural', 'constellation', 'tunnel']);
/** Files per ring of the data tunnel, and the distance between rings. */
const TUNNEL_RING = 8;
const TUNNEL_GAP = 7;
/** The neural cloud is a flattened ellipsoid, wider than it is tall or deep. */
const NEURAL_SHAPE = new THREE.Vector3(1, 0.55, 0.7);
/** Constellations spread wide and shallow, like a star chart. */
const CHART_SHAPE = new THREE.Vector3(1, 0.58, 0.45);
const BASE_FOV = 55;
/** How bright the star field is in each world. */
const STAR_LEVEL: Record<WorldStyle, number> = { grid: 0.9, hud: 0.28, starmap: 1, tunnel: 0.5 };
const MAX_PULSES = 72;
/** Camera height above the arrangement, as a fraction of its distance. */
const ELEVATION: Record<SceneLayout, number> = { orbit: 0.42, spiral: 0.42, wall: 0.06, helix: 0.1, globe: 0.16, neural: 0.24, dial: 0, constellation: 0.08, tunnel: 0 };
/** Slow idle turn of a single-container layout, radians per second. */
const DRIFT: Record<SceneLayout, number> = { orbit: 0, spiral: 0.02, wall: 0, helix: 0.07, globe: 0.035, neural: 0.02, dial: 0, constellation: 0.012, tunnel: 0 };

/** Small deterministic generator (mulberry32). */
function seeded(seed: number): () => number {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Join every slot to its `k` nearest neighbours, each pair once. */
function nearestLinks(slots: Slot[], k: number): [number, number][] {
  const links: [number, number][] = [];
  const seen = new Set<number>();
  const nearest: { index: number; gap: number }[] = [];
  for (let i = 0; i < slots.length; i += 1) {
    nearest.length = 0;
    for (let j = 0; j < slots.length; j += 1) {
      if (j === i) continue;
      const gap = slots[i].home.distanceToSquared(slots[j].home);
      if (nearest.length < k || gap < nearest[nearest.length - 1].gap) {
        nearest.push({ index: j, gap });
        nearest.sort((a, b) => a.gap - b.gap);
        if (nearest.length > k) nearest.pop();
      }
    }
    for (const { index } of nearest) {
      const key = Math.min(i, index) * 4096 + Math.max(i, index);
      if (seen.has(key)) continue;
      seen.add(key);
      links.push([i, index]);
    }
  }
  return links;
}

export function place(count: number, layout: SceneLayout): Placement {
  const slots: Slot[] = [];
  if (layout === 'wall') {
    const columns = Math.max(4, Math.ceil(Math.sqrt(count * 1.9)));
    const rows = Math.ceil(count / columns);
    const dx = 5.6;
    const dy = 3.8;
    for (let i = 0; i < count; i += 1) {
      const column = i % columns;
      const row = Math.floor(i / columns);
      const wave = Math.sin(column * 0.55) * 1.2;
      slots.push({ container: 0, home: new THREE.Vector3((column - (columns - 1) / 2) * dx, ((rows - 1) / 2 - row) * dy, wave) });
    }
    return { slots, containers: 1, extent: Math.max(columns * dx, rows * dy * 1.6) / 2, orbitRadii: [] };
  }
  if (layout === 'spiral') {
    const golden = Math.PI * (3 - Math.sqrt(5));
    let extent = 0;
    for (let i = 0; i < count; i += 1) {
      const r = 10 + 3.3 * Math.sqrt(i + 1);
      const angle = i * golden;
      extent = Math.max(extent, r);
      slots.push({ container: 0, home: new THREE.Vector3(Math.cos(angle) * r, Math.sin(i * 0.9) * 1.1, Math.sin(angle) * r) });
    }
    return { slots, containers: 1, extent, orbitRadii: [] };
  }
  if (layout === 'helix') {
    // A DNA-style tower: strands wind around a shared axis, rungs join each step.
    const strands = count > 120 ? 4 : count > 60 ? 3 : 2;
    const steps = Math.max(1, Math.ceil(count / strands));
    const radius = strands === 2 ? 6.5 : strands === 3 ? 8 : 10;
    const rise = 1.7;
    const twist = 0.45;
    const links: [number, number][] = [];
    for (let i = 0; i < count; i += 1) {
      const strand = i % strands;
      const step = Math.floor(i / strands);
      const angle = step * twist + (strand / strands) * Math.PI * 2;
      slots.push({ container: 0, home: new THREE.Vector3(Math.cos(angle) * radius, ((steps - 1) / 2 - step) * rise, Math.sin(angle) * radius) });
      if (i + strands < count) links.push([i, i + strands]);
      if (strand > 0) links.push([i - 1, i]);
      if (strands > 2 && strand === strands - 1) links.push([i, i - strand]);
    }
    const height = steps * rise;
    return { slots, containers: 1, extent: Math.max(radius * 1.5, Math.min(height / 2, 20)), orbitRadii: [], links, radius, height, distance: 16 + Math.max(radius * 1.5, Math.min(height / 2, 20)) * 1.5, floor: Math.min(height / 2 + 4, 30) };
  }
  if (layout === 'tunnel') {
    // Rings of files receding from the camera, each ring twisted a little from the last.
    const radius = 9;
    const links: [number, number][] = [];
    for (let i = 0; i < count; i += 1) {
      const ring = Math.floor(i / TUNNEL_RING);
      const slot = i % TUNNEL_RING;
      const angle = (slot / TUNNEL_RING) * Math.PI * 2 + ring * 0.22;
      slots.push({ container: 0, home: new THREE.Vector3(Math.cos(angle) * radius, Math.sin(angle) * radius, -ring * TUNNEL_GAP) });
      if (i + TUNNEL_RING < count) links.push([i, i + TUNNEL_RING]);
      if (slot > 0) links.push([i - 1, i]);
      if (slot === TUNNEL_RING - 1) links.push([i, i - slot]);
    }
    const height = Math.max(1, Math.ceil(count / TUNNEL_RING)) * TUNNEL_GAP;
    return { slots, containers: 1, extent: radius, orbitRadii: [], links, radius, height, distance: 21 };
  }
  if (layout === 'globe') {
    // A data sphere: files spread evenly over its surface (Fibonacci lattice).
    const radius = Math.max(9, 1.45 * Math.sqrt(count));
    const golden = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < count; i += 1) {
      const y = 1 - ((i + 0.5) / count) * 2;
      const r = Math.sqrt(1 - y * y);
      const angle = i * golden;
      slots.push({ container: 0, home: new THREE.Vector3(Math.cos(angle) * r * radius, y * radius, Math.sin(angle) * r * radius) });
    }
    // The outermost ring sits at 1.28 radii; about twice that fills the 55 degree view.
    return { slots, containers: 1, extent: radius, orbitRadii: [], links: nearestLinks(slots, 2), radius, distance: radius * 1.28 * 1.95, floor: radius * 1.3 + 3 };
  }
  if (layout === 'neural' || layout === 'constellation') {
    // A neural net: an even but irregular cloud, each node wired to its nearest neighbours.
    // Seeded by the count, so a folder always grows the same network.
    const chart = layout === 'constellation';
    const shape = chart ? CHART_SHAPE : NEURAL_SHAPE;
    const radius = Math.max(chart ? 13 : 9, Math.cbrt((chart ? 110 : 55) * count));
    const random = seeded(count * 7919 + 13);
    const candidate = new THREE.Vector3();
    for (let i = 0; i < count; i += 1) {
      const best = new THREE.Vector3();
      let bestGap = -1;
      for (let attempt = 0; attempt < 10; attempt += 1) {
        do candidate.set(random() * 2 - 1, random() * 2 - 1, random() * 2 - 1); while (candidate.lengthSq() > 1);
        candidate.multiply(shape).multiplyScalar(radius);
        let gap = Infinity;
        for (const slot of slots) gap = Math.min(gap, slot.home.distanceToSquared(candidate));
        if (gap > bestGap) {
          bestGap = gap;
          best.copy(candidate);
        }
      }
      slots.push({ container: 0, home: best });
    }
    return { slots, containers: 1, extent: radius, orbitRadii: [], links: nearestLinks(slots, chart ? 2 : 3), radius, distance: 8 + radius * 1.3, floor: radius * shape.y + 5 };
  }
  const orbitRadii: number[] = [];
  let ring = 0;
  while (slots.length < count) {
    const radius = ORBIT_START + ring * ORBIT_STEP;
    const capacity = Math.max(8, Math.floor((Math.PI * 2 * radius) / ORBIT_SPACING));
    const n = Math.min(capacity, count - slots.length);
    // Alternate ring heights so neighbouring orbits never sit on one flat disc.
    const height = ring % 2 === 0 ? 0 : 1.4;
    for (let i = 0; i < n; i += 1) {
      const angle = (i / n) * Math.PI * 2 + ring * 0.4;
      slots.push({ container: ring, home: new THREE.Vector3(Math.cos(angle) * radius, height, Math.sin(angle) * radius) });
    }
    orbitRadii.push(radius);
    ring += 1;
  }
  const extent = orbitRadii[orbitRadii.length - 1] ?? ORBIT_START;
  // The dial is the orbit rings seen face-on, so the whole disc has to fit the view's height.
  return { slots, containers: Math.max(1, ring), extent, orbitRadii, distance: layout === 'dial' ? (extent + 6) * 2.05 : undefined };
}

function softDotTexture(): THREE.Texture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  const context = canvas.getContext('2d')!;
  const gradient = context.createRadialGradient(32, 32, 0, 32, 32, 32);
  gradient.addColorStop(0, 'rgba(255,255,255,1)');
  gradient.addColorStop(0.35, 'rgba(255,255,255,0.45)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  context.fillStyle = gradient;
  context.fillRect(0, 0, 64, 64);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

const GRID_VERTEX = /* glsl */ `
  varying vec3 vWorld;
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const GRID_FRAGMENT = /* glsl */ `
  uniform vec3 uColor;
  uniform vec3 uPulse;
  uniform float uTime;
  uniform float uOpacity;
  varying vec3 vWorld;
  float gridLine(float coord, float width) {
    float d = abs(fract(coord - 0.5) - 0.5) / fwidth(coord);
    return 1.0 - min(d / width, 1.0);
  }
  void main() {
    vec2 c = vWorld.xz / 2.5;
    c.y += uTime * 0.18;
    float minor = max(gridLine(c.x, 1.0), gridLine(c.y, 1.0));
    float major = max(gridLine(c.x / 5.0, 1.3), gridLine(c.y / 5.0, 1.3));
    float dist = length(vWorld.xz);
    float fade = smoothstep(120.0, 8.0, dist);
    float wave = smoothstep(2.0, 0.0, abs(dist - mod(uTime * 14.0, 130.0)));
    vec3 color = mix(uColor, uPulse, wave);
    // The pulse only lights existing grid lines, so it never blooms into a solid arc.
    float lines = max(minor, major);
    float alpha = (minor * 0.22 + major * 0.55 + wave * lines * 0.35) * fade * uOpacity;
    gl_FragColor = vec4(color * (0.55 + major * 0.8 + wave * lines * 0.4), alpha);
  }
`;

/**
 * Holographic surface: fresnel rim, drifting interference bands, rare flicker, and a
 * build front that scans the object in from the bottom (or dissolves it into noise).
 */
export const HOLO_VERTEX = /* glsl */ `
  varying vec3 vNormal;
  varying vec3 vView;
  varying vec3 vLocal;
  // uWorld = 1 measures the build front in world space around uCenter (for models made
  // of many meshes); 0 uses the mesh's own coordinates.
  uniform float uWorld;
  uniform vec3 uCenter;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vNormal = normalize(normalMatrix * normal);
    vView = -mv.xyz;
    vLocal = mix(position, (modelMatrix * vec4(position, 1.0)).xyz - uCenter, uWorld);
    gl_Position = projectionMatrix * mv;
  }
`;

/** The holo surface itself, shared by the per-mesh and the instanced variants. */
const HOLO_SURFACE = /* glsl */ `
  uniform float uTime;
  uniform float uExtent;
  uniform float uFlicker;
  varying vec3 vNormal;
  varying vec3 vView;
  varying vec3 vLocal;
  float hash(vec3 p) { return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }
  vec4 holoSurface(vec3 baseColor, float build, float seed, float opacity) {
    float height = clamp(vLocal.y / uExtent * 0.5 + 0.5, 0.0, 1.0);
    float grain = hash(floor(vLocal * 18.0 / uExtent));
    float edge = height * 0.78 + grain * 0.22;
    float reach = build * 1.08;
    if (edge > reach) discard;
    float front = (1.0 - smoothstep(0.0, 0.09, reach - edge)) * step(build, 0.999);
    float rim = pow(1.0 - abs(dot(normalize(vNormal), normalize(vView))), 2.0);
    float bands = 0.72 + 0.28 * sin(vLocal.y / uExtent * 22.0 - uTime * 4.0 + seed * 6.283);
    float flick = 1.0 - uFlicker * 0.35 * step(0.975, hash(vec3(floor(uTime * 16.0), seed, 1.0)));
    vec3 color = baseColor * (0.45 + rim * 1.5) * bands * flick + vec3(front * 1.6);
    return vec4(color, clamp(opacity * (0.5 + rim * 0.5) + front, 0.0, 1.0));
  }
`;

export const HOLO_FRAGMENT = /* glsl */ `
  uniform vec3 uColor;
  uniform float uBuild;
  uniform float uSeed;
  uniform float uOpacity;
  ${HOLO_SURFACE}
  void main() {
    gl_FragColor = holoSurface(uColor, uBuild, uSeed, uOpacity);
  }
`;

/** Instanced galaxy nodes: the transform comes from instanceMatrix, the rest from attributes. */
const NODE_VERTEX = /* glsl */ `
  attribute float aBuild;
  attribute float aSeed;
  attribute float aOpacity;
  attribute float aTone;
  uniform vec3 uColors[3];
  varying vec3 vNormal;
  varying vec3 vView;
  varying vec3 vLocal;
  varying vec3 vColor;
  varying float vBuild;
  varying float vSeed;
  varying float vOpacity;
  void main() {
    mat4 mvMatrix = modelViewMatrix * instanceMatrix;
    vec4 mv = mvMatrix * vec4(position, 1.0);
    // Node transforms only scale uniformly, so the upper 3x3 transforms normals correctly.
    vNormal = normalize(mat3(mvMatrix) * normal);
    vView = -mv.xyz;
    vLocal = position;
    vColor = aTone < 0.5 ? uColors[0] : (aTone < 1.5 ? uColors[1] : uColors[2]);
    vBuild = aBuild;
    vSeed = aSeed;
    vOpacity = aOpacity;
    gl_Position = projectionMatrix * mv;
  }
`;

const NODE_FRAGMENT = /* glsl */ `
  varying vec3 vColor;
  varying float vBuild;
  varying float vSeed;
  varying float vOpacity;
  ${HOLO_SURFACE}
  void main() {
    gl_FragColor = holoSurface(vColor, vBuild, vSeed, vOpacity);
  }
`;

/**
 * The final pass: slight colour fringing toward the screen edges, like a projected image,
 * then the linear-to-sRGB output step that OutputPass used to do in a pass of its own.
 * The renderer uses no tone mapping, so sRGB transfer is all OutputPass did here.
 * uAmount = 0 turns the fringe off (lower tiers, reduced motion).
 */
const FINAL_SHADER = {
  uniforms: { tDiffuse: { value: null }, uAmount: { value: 0.006 } },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uAmount;
    varying vec2 vUv;
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      if (uAmount > 0.0) {
        vec2 d = vUv - 0.5;
        vec2 o = d * dot(d, d) * uAmount * 4.0;
        c.r = texture2D(tDiffuse, vUv + o).r;
        c.b = texture2D(tDiffuse, vUv - o).b;
      }
      gl_FragColor = sRGBTransferOETF(c);
    }
  `,
};
const FRINGE_BASE = 0.006;
/** Initial instance slots per batch; grows if a listing ever exceeds it (backend caps at 240). */
const BATCH_CAPACITY = 256;

export interface SceneCallbacks {
  hover: (entry: HoloEntry | null) => void;
  select: (entry: HoloEntry) => void;
  activate: (entry: HoloEntry) => void;
  back: () => void;
}

interface Spinner {
  object: THREE.Object3D;
  axis: 'x' | 'y' | 'z';
  speed: number;
}

interface Electron {
  mesh: THREE.Mesh;
  orbit: THREE.Object3D;
  radius: number;
  speed: number;
  phase: number;
}

export class HoloScene {
  readonly tweener = new Tweener();
  private readonly renderer: THREE.WebGLRenderer;
  private readonly composer: EffectComposer;
  private readonly bloom: UnrealBloomPass;
  /** Edge fringe + sRGB output in one full-screen pass. */
  private readonly finalPass: ShaderPass;
  private fringeOn = true;
  /** Shared by every holo material, so one write per frame animates them all. */
  private readonly holoTime = { value: 0 };
  private readonly holoFlicker = { value: 1 };
  private reducedMotion = false;
  private standby = false;
  private standbyLevel = 0;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(BASE_FOV, 1, 0.1, 800);
  /** Rotated by the user (orbit/spiral) or panned (wall). */
  private readonly view = new THREE.Group();
  private readonly galaxy = new THREE.Group();
  private readonly containers: THREE.Group[] = [];
  private readonly orbitLines: THREE.LineLoop[] = [];
  private readonly core = new THREE.Group();
  private spinners: Spinner[] = [];
  private electrons: Electron[] = [];
  private readonly reticle = new THREE.Group();
  private readonly stars: THREE.Points;
  private readonly grid: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2(9, 9);
  private readonly parallax = new THREE.Vector2();
  private readonly lookTarget = new THREE.Vector3();
  private readonly toneMaterials = new Map<string, { tone: Tone; material: THREE.Material & { color: THREE.Color } }>();
  private readonly colors: Record<Tone, THREE.Color> = {
    primary: new THREE.Color(),
    secondary: new THREE.Color(),
    accent: new THREE.Color(),
  };
  private readonly geometries = {
    dirWire: new THREE.OctahedronGeometry(0.72),
    dirCore: new THREE.OctahedronGeometry(0.34),
    file: new THREE.IcosahedronGeometry(0.32, 0),
    hitDir: new THREE.SphereGeometry(1.5, 8, 8),
    hitFile: new THREE.SphereGeometry(1.15, 8, 8),
  };
  /**
   * Hit spheres are only ray-cast, never drawn. `visible: false` skips their draw calls;
   * three.js ray casting does not look at material visibility, so picking is unchanged.
   */
  private readonly hitMaterial = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, visible: false });
  private batches!: { dirWire: NodeBatch; dirCore: NodeBatch; file: NodeBatch };
  private dirCount = 0;
  private fileCount = 0;
  private hitTargets: THREE.Object3D[] = [];
  private readonly nodeByHit = new Map<THREE.Object3D, GalaxyNode>();
  private readonly scratch = new THREE.Vector3();
  // Network layouts (helix, globe, neural): links between nodes, pulses along them, a frame.
  private links: [number, number][] = [];
  /** For each node index, the links that touch it. */
  private linksOf: number[][] = [];
  private linkLines: THREE.LineSegments | null = null;
  private pulsePoints: THREE.Points | null = null;
  private pulses: Pulse[] = [];
  private readonly linkMaterial = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
  private readonly pulseMaterial = new THREE.PointsMaterial({ size: 1.5, map: softDotTexture(), vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
  /** The layout's own frame: globe shell, helix axis. Scales in with `decorLevel`. */
  private readonly decor = new THREE.Group();
  private decorSpinners: Spinner[] = [];
  private decorLevel = 0;
  /** How far the tunnel reaches, which is how far the user can fly into it. */
  private tunnelDepth = 0;
  /** Smoothed depth actually shown. */
  private travel = 0;
  /** Where the floor grid rests for the current layout. */
  private floorTarget = -10;
  private nodes: GalaxyNode[] = [];
  private hovered: GalaxyNode | null = null;
  private selected: GalaxyNode | null = null;
  private layout: SceneLayout = 'orbit';
  private world: WorldStyle | '' = '';
  /** 0..1, raised by boot(); the world sets how bright full is. */
  private starFade = 0;
  private readonly nebula: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
  private readonly nebulaCanvas = document.createElement('canvas');
  private coreStyle: CoreStyle | '' = '';
  private zoom = 1;
  private userZoom = 1;
  private fitDistance = 34;
  private coreScale = 0;
  private running = false;
  private lastFrame = 0;
  private lastHoverHit = 0;
  private quality: QualityTier = 'high';
  private renderScale = 1;
  private frameInterval = 1000 / 60;
  private framesThisSecond = 0;
  private fpsWindowStart = 0;
  private measuredFps = 0;
  private interactive = false;
  // Direct manipulation state.
  private dragMode: DragMode = 'none';
  private dragNode: GalaxyNode | null = null;
  private readonly dragStart = new THREE.Vector2();
  private readonly dragLast = new THREE.Vector2();
  private readonly dragPlane = new THREE.Plane();
  private yaw = 0;
  private pitch = 0;
  private yawVelocity = 0;
  private readonly pan = new THREE.Vector2();

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly labelLayer: HTMLElement,
    private readonly callbacks: SceneCallbacks,
  ) {
    // No MSAA: the post-processing chain renders to plain targets, so it would only cost GPU time.
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
    this.renderer.setClearColor(0x03060c, 1);
    this.renderer.setPixelRatio(1);
    this.scene.fog = new THREE.FogExp2(0x03060c, 0.0085);

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 1.1, 0.55, 0.05);
    this.composer.addPass(this.bloom);
    this.finalPass = new ShaderPass(FINAL_SHADER);
    this.composer.addPass(this.finalPass);
    this.createBatches(BATCH_CAPACITY, BATCH_CAPACITY);

    this.grid = new THREE.Mesh(
      new THREE.PlaneGeometry(300, 300, 1, 1),
      new THREE.ShaderMaterial({
        vertexShader: GRID_VERTEX,
        fragmentShader: GRID_FRAGMENT,
        transparent: true,
        depthWrite: false,
        uniforms: {
          uColor: { value: new THREE.Color() },
          uPulse: { value: new THREE.Color() },
          uTime: { value: 0 },
          uOpacity: { value: 0 },
        },
      }),
    );
    this.grid.rotation.x = -Math.PI / 2;
    this.grid.position.y = -40;
    this.scene.add(this.grid);

    this.stars = this.createStars();
    this.scene.add(this.stars);
    this.nebulaCanvas.width = 1024;
    this.nebulaCanvas.height = 512;
    const nebulaMap = new THREE.CanvasTexture(this.nebulaCanvas);
    nebulaMap.colorSpace = THREE.SRGBColorSpace;
    this.nebula = new THREE.Mesh(
      new THREE.SphereGeometry(420, 32, 16),
      new THREE.MeshBasicMaterial({ map: nebulaMap, side: THREE.BackSide, transparent: true, opacity: 0, depthWrite: false, fog: false, blending: THREE.AdditiveBlending }),
    );
    this.nebula.visible = false;
    this.scene.add(this.nebula);
    this.buildReticle();
    this.view.add(this.core, this.galaxy);
    this.scene.add(this.view);
    this.setCoreStyle('reactor');

    this.resize();
    window.addEventListener('resize', () => this.resize());
    this.bindPointer();
  }

  // ---------- Materials ----------

  private material(key: string, tone: Tone, create: () => THREE.Material & { color: THREE.Color }) {
    let record = this.toneMaterials.get(key);
    if (!record) {
      record = { tone, material: create() };
      record.material.color.copy(this.colors[tone]);
      this.toneMaterials.set(key, record);
    }
    return record.material;
  }

  private wire(tone: Tone, opacity = 0.9) {
    return this.material(`wire-${tone}-${opacity}`, tone, () =>
      new THREE.MeshBasicMaterial({ wireframe: true, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
  }

  private solid(tone: Tone, opacity = 1) {
    return this.material(`solid-${tone}-${opacity}`, tone, () =>
      new THREE.MeshBasicMaterial({ transparent: opacity < 1, opacity, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
  }

  private line(tone: Tone, opacity: number) {
    return this.material(`line-${tone}-${opacity}`, tone, () =>
      new THREE.LineBasicMaterial({ transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
  }

  /** One instanced batch per node part; each instance scans in and dissolves on its own. */
  private createBatch(geometry: THREE.BufferGeometry, extent: number, baseOpacity: number, wireframe: boolean, capacity: number): NodeBatch {
    const shape = geometry.clone();
    const attribute = (name: string) => {
      const value = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1).setUsage(THREE.DynamicDrawUsage);
      shape.setAttribute(name, value);
      return value;
    };
    const build = attribute('aBuild');
    const seed = attribute('aSeed');
    const opacity = attribute('aOpacity');
    const tone = attribute('aTone');
    const material = new THREE.ShaderMaterial({
      vertexShader: NODE_VERTEX,
      fragmentShader: NODE_FRAGMENT,
      transparent: true,
      depthWrite: false,
      wireframe,
      blending: THREE.AdditiveBlending,
      uniforms: {
        // The live theme colours: setTheme edits these objects in place.
        uColors: { value: [this.colors.primary, this.colors.secondary, this.colors.accent] },
        uTime: this.holoTime,
        uFlicker: this.holoFlicker,
        uExtent: { value: extent },
      },
    });
    const mesh = new THREE.InstancedMesh(shape, material, capacity);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.count = 0;
    // Instances move every frame; their matrices are world matrices, so the mesh sits at the root.
    mesh.frustumCulled = false;
    this.scene.add(mesh);
    return { mesh, build, seed, opacity, tone, baseOpacity };
  }

  private createBatches(dirs: number, files: number): void {
    if (this.batches) {
      for (const batch of Object.values(this.batches)) {
        batch.mesh.removeFromParent();
        batch.mesh.geometry.dispose();
        batch.mesh.material.dispose();
        batch.mesh.dispose();
      }
    }
    this.batches = {
      dirWire: this.createBatch(this.geometries.dirWire, 0.72, 0.9, true, dirs),
      dirCore: this.createBatch(this.geometries.dirCore, 0.34, 1, false, dirs),
      file: this.createBatch(this.geometries.file, 0.32, 1, false, files),
    };
  }

  private initInstance(batch: NodeBatch, index: number, tone: Tone): void {
    batch.seed.setX(index, Math.random());
    batch.tone.setX(index, TONE_INDEX[tone]);
    batch.build.setX(index, 0);
    batch.seed.needsUpdate = true;
    batch.tone.needsUpdate = true;
  }

  private writeInstance(batch: NodeBatch, index: number, matrix: THREE.Matrix4, build: number, opacity: number): void {
    batch.mesh.setMatrixAt(index, matrix);
    batch.build.setX(index, build);
    batch.opacity.setX(index, batch.baseOpacity * opacity);
  }

  // ---------- Static pieces ----------

  private createStars(): THREE.Points {
    const count = 2600;
    const positions = new Float32Array(count * 3);
    const mix = new Float32Array(count);
    for (let i = 0; i < count; i += 1) {
      const r = 80 + Math.random() * 200;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(Math.random() * 2 - 1);
      positions.set([r * Math.sin(phi) * Math.cos(theta), r * Math.cos(phi) * 0.6, r * Math.sin(phi) * Math.sin(theta)], i * 3);
      mix[i] = Math.random();
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
    geometry.userData.mix = mix;
    return new THREE.Points(
      geometry,
      new THREE.PointsMaterial({ size: 1.1, map: softDotTexture(), vertexColors: true, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending }),
    );
  }

  /** Rebuild the centerpiece. Kept small so files have room around it. */
  setCoreStyle(style: CoreStyle): void {
    if (style === this.coreStyle) return;
    this.coreStyle = style;
    this.core.clear();
    this.spinners = [];
    this.electrons = [];
    const spin = (object: THREE.Object3D, axis: Spinner['axis'], speed: number) => {
      this.spinners.push({ object, axis, speed });
      return object;
    };
    if (style === 'reactor') {
      this.core.add(spin(new THREE.Mesh(new THREE.IcosahedronGeometry(1.45, 1), this.wire('primary', 0.85)), 'y', 0.25));
      this.core.add(new THREE.Mesh(new THREE.IcosahedronGeometry(0.85, 2), this.solid('secondary', 0.35)));
      (['primary', 'secondary', 'accent'] as Tone[]).forEach((tone, i) => {
        const ring = new THREE.Mesh(new THREE.TorusGeometry(2.0 + i * 0.32, 0.02, 8, 160), this.solid(tone, 0.9));
        ring.rotation.set(Math.PI / 2 + i * 0.5, i * 0.7, 0);
        this.core.add(spin(ring, 'z', (0.35 + i * 0.18) * (i % 2 ? -1 : 1)));
      });
    } else if (style === 'atom') {
      const nucleus = new THREE.Group();
      for (let i = 0; i < 7; i += 1) {
        const ball = new THREE.Mesh(new THREE.SphereGeometry(0.32, 16, 12), this.solid(i % 2 ? 'secondary' : 'primary', 0.9));
        ball.position.set(Math.cos(i * 2.4) * 0.38, Math.sin(i * 1.7) * 0.38, Math.sin(i * 2.4) * 0.38);
        nucleus.add(ball);
      }
      this.core.add(spin(nucleus, 'y', 0.6));
      for (let i = 0; i < 3; i += 1) {
        const orbit = new THREE.Group();
        orbit.rotation.set(Math.PI / 2 + (i - 1) * 1.05, i * 1.05, 0);
        orbit.add(new THREE.Mesh(new THREE.TorusGeometry(2.3, 0.012, 6, 160), this.solid('primary', 0.6)));
        const electron = new THREE.Mesh(new THREE.SphereGeometry(0.16, 12, 8), this.solid('accent'));
        orbit.add(electron);
        this.core.add(orbit);
        this.electrons.push({ mesh: electron, orbit, radius: 2.3, speed: 1.6 + i * 0.5, phase: i * 2.1 });
      }
    } else if (style === 'tesseract') {
      const outer = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(2.6, 2.6, 2.6)), this.line('primary', 0.95));
      const inner = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1.4, 1.4, 1.4)), this.line('accent', 0.95));
      const heart = new THREE.Mesh(new THREE.OctahedronGeometry(0.45), this.solid('secondary', 0.7));
      outer.rotation.set(0.6, 0.6, 0);
      this.core.add(spin(outer, 'y', 0.3), spin(inner, 'x', -0.7), spin(heart, 'y', 1.2));
    }
  }

  private buildReticle(): void {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(1.15, 0.035, 6, 64), this.solid('accent'));
    const outer = new THREE.Mesh(new THREE.TorusGeometry(1.45, 0.015, 6, 64, Math.PI * 1.4), this.solid('primary'));
    this.reticle.add(ring, outer);
    for (let i = 0; i < 4; i += 1) {
      const tick = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.32, 0.02), this.solid('accent'));
      const angle = (i / 4) * Math.PI * 2;
      tick.position.set(Math.cos(angle) * 1.7, Math.sin(angle) * 1.7, 0);
      tick.rotation.z = angle + Math.PI / 2;
      this.reticle.add(tick);
    }
    this.reticle.visible = false;
    this.scene.add(this.reticle);
  }

  setTheme(theme: HoloTheme, reducedMotion: boolean): void {
    this.colors.primary.set(theme.primary);
    this.colors.secondary.set(theme.secondary);
    this.colors.accent.set(theme.accent);
    for (const { tone, material } of this.toneMaterials.values()) material.color.copy(this.colors[tone]);
    this.grid.material.uniforms.uColor.value.copy(this.colors.primary);
    this.grid.material.uniforms.uPulse.value.copy(this.colors.accent);
    const starColors = this.stars.geometry.getAttribute('color') as THREE.BufferAttribute;
    const mix = this.stars.geometry.userData.mix as Float32Array;
    const color = new THREE.Color();
    for (let i = 0; i < mix.length; i += 1) {
      color.copy(this.colors.primary).lerp(mix[i] > 0.85 ? this.colors.accent : this.colors.secondary, mix[i]);
      starColors.setXYZ(i, color.r, color.g, color.b);
    }
    starColors.needsUpdate = true;
    this.bloom.strength = 1.15 * theme.glow;
    this.tweener.reduced = reducedMotion;
    this.reducedMotion = reducedMotion;
    this.holoFlicker.value = reducedMotion ? 0 : 1;
    this.setFringe(!reducedMotion && this.quality === 'high');
    this.setCoreStyle(theme.core);
    this.paintNebula();
    this.setWorld(theme.world ?? 'grid');
  }

  /** Swap the whole environment: floor grid and centerpiece, a bare HUD backdrop, or open space. */
  private setWorld(world: WorldStyle): void {
    if (world === this.world) return;
    this.world = world;
    this.grid.visible = world === 'grid';
    this.nebula.visible = world === 'starmap';
    (this.stars.material as THREE.PointsMaterial).size = world === 'starmap' ? 1.6 : 1.1;
    this.core.visible = world === 'grid' && !LINKED.has(this.layout);
  }

  /** Soft clouds in the theme colours, painted once per theme onto the sky sphere. */
  private paintNebula(): void {
    const canvas = this.nebulaCanvas;
    const context = canvas.getContext('2d')!;
    const random = seeded(2187);
    context.globalCompositeOperation = 'source-over';
    context.fillStyle = '#000';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.globalCompositeOperation = 'lighter';
    const tones = [this.colors.primary, this.colors.secondary, this.colors.secondary, this.colors.accent];
    for (let i = 0; i < 54; i += 1) {
      const tone = tones[Math.floor(random() * tones.length)];
      const rgb = `${Math.round(tone.r * 255)}, ${Math.round(tone.g * 255)}, ${Math.round(tone.b * 255)}`;
      const x = random() * canvas.width;
      // Clouds gather in a band, like a galaxy seen from inside, and stay off the pinched poles.
      const y = canvas.height * (0.5 + (random() + random() - 1) * 0.3);
      const radius = 50 + random() * 170;
      const alpha = 0.05 + random() * 0.1;
      // Drawn three times so clouds wrap cleanly across the texture seam.
      for (const shift of [-canvas.width, 0, canvas.width]) {
        const gradient = context.createRadialGradient(x + shift, y, 0, x + shift, y, radius);
        gradient.addColorStop(0, `rgba(${rgb}, ${alpha})`);
        gradient.addColorStop(1, `rgba(${rgb}, 0)`);
        context.fillStyle = gradient;
        context.fillRect(x + shift - radius, y - radius, radius * 2, radius * 2);
      }
    }
    this.nebula.material.map!.needsUpdate = true;
  }

  get currentLayout(): SceneLayout {
    return this.layout;
  }

  private resize(): void {
    const width = window.innerWidth;
    const height = window.innerHeight;
    this.renderer.setPixelRatio(this.renderScale);
    this.composer.setPixelRatio(this.renderScale);
    this.renderer.setSize(width, height, false);
    this.composer.setSize(width, height);
    this.bloom.resolution.set(width, height);
    this.camera.aspect = width / Math.max(1, height);
    this.camera.updateProjectionMatrix();
  }

  // ---------- Pointer: hover, click, drag a file, drag the view ----------

  private bindPointer(): void {
    window.addEventListener('pointermove', (event) => {
      if (this.dragMode === 'none') {
        this.parallax.set((event.clientX / window.innerWidth) * 2 - 1, (event.clientY / window.innerHeight) * 2 - 1);
      }
      if (event.target === this.canvas) {
        this.pointer.set((event.clientX / window.innerWidth) * 2 - 1, -((event.clientY / window.innerHeight) * 2 - 1));
      } else if (this.dragMode === 'none') {
        this.pointer.set(9, 9);
      }
    });
    this.canvas.addEventListener('pointerleave', () => {
      if (this.dragMode === 'none') this.pointer.set(9, 9);
    });
    this.canvas.addEventListener('pointerdown', (event) => {
      if (!this.interactive || event.button !== 0) return;
      this.canvas.setPointerCapture(event.pointerId);
      this.dragMode = 'pending';
      this.dragNode = this.hovered;
      this.dragStart.set(event.clientX, event.clientY);
      this.dragLast.copy(this.dragStart);
      this.yawVelocity = 0;
    });
    this.canvas.addEventListener('pointermove', (event) => {
      if (this.dragMode === 'none') return;
      const here = new THREE.Vector2(event.clientX, event.clientY);
      if (this.dragMode === 'pending' && here.distanceTo(this.dragStart) > DRAG_THRESHOLD) {
        this.dragMode = this.dragNode ? 'node' : 'view';
        if (this.dragNode) this.beginNodeDrag(this.dragNode);
        this.canvas.classList.add(this.dragNode ? 'dragging-node' : 'dragging-view');
      }
      if (this.dragMode === 'node' && this.dragNode) this.moveNode(this.dragNode, event);
      if (this.dragMode === 'view') this.moveView(here.x - this.dragLast.x, here.y - this.dragLast.y);
      this.dragLast.copy(here);
    });
    const finish = (event: PointerEvent) => {
      if (this.dragMode === 'none') return;
      if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId);
      const wasClick = this.dragMode === 'pending';
      const node = this.dragNode;
      this.dragMode = 'none';
      this.dragNode = null;
      this.canvas.classList.remove('dragging-node', 'dragging-view');
      if (wasClick && node && event.type === 'pointerup') this.activateNode(node);
    };
    this.canvas.addEventListener('pointerup', finish);
    this.canvas.addEventListener('pointercancel', finish);
    this.canvas.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      if (this.interactive && this.dragMode === 'none') this.callbacks.back();
    });
    this.canvas.addEventListener(
      'wheel',
      (event) => {
        if (this.layout === 'tunnel') {
          // The wheel flies one ring forward or back.
          this.pan.y = THREE.MathUtils.clamp(this.pan.y + (event.deltaY > 0 ? -TUNNEL_GAP : TUNNEL_GAP), 0, this.tunnelDepth);
          return;
        }
        this.userZoom = THREE.MathUtils.clamp(this.userZoom * (event.deltaY > 0 ? 1.08 : 0.92), 0.35, 1.8);
      },
      { passive: true },
    );
  }

  private activateNode(node: GalaxyNode): void {
    if (node.entry.is_dir) {
      this.callbacks.activate(node.entry);
    } else {
      this.selected = node;
      this.callbacks.select(node.entry);
    }
  }

  private beginNodeDrag(node: GalaxyNode): void {
    const position = new THREE.Vector3();
    node.group.getWorldPosition(position);
    const normal = new THREE.Vector3();
    this.camera.getWorldDirection(normal);
    this.dragPlane.setFromNormalAndCoplanarPoint(normal.negate(), position);
  }

  private moveNode(node: GalaxyNode, event: PointerEvent): void {
    const ndc = new THREE.Vector2((event.clientX / window.innerWidth) * 2 - 1, -((event.clientY / window.innerHeight) * 2 - 1));
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(this.dragPlane, hit)) return;
    node.container.worldToLocal(hit);
    node.offset.copy(hit).sub(node.home.clone().multiplyScalar(node.radial));
  }

  private moveView(dx: number, dy: number): void {
    if (this.layout === 'wall') {
      const perPixel = (this.fitDistance * this.zoom * this.userZoom) / window.innerHeight;
      this.pan.x += dx * perPixel * 1.1;
      this.pan.y -= dy * perPixel * 1.1;
      return;
    }
    const step = dx * 0.006;
    this.yaw += step;
    this.yawVelocity = step;
    if (this.layout === 'tunnel') {
      // Sideways rolls the tunnel; pulling down flies into it.
      this.pan.y = THREE.MathUtils.clamp(this.pan.y + dy * 0.12, 0, this.tunnelDepth);
    } else if (this.layout === 'dial') {
      this.pitch = THREE.MathUtils.clamp(this.pitch + dy * 0.003, -0.45, 0.45);
    } else if (this.layout === 'helix') {
      // The tower turns sideways and slides up and down.
      this.pan.y -= (dy * this.fitDistance * this.zoom * this.userZoom * 1.1) / window.innerHeight;
    } else if (LINKED.has(this.layout)) {
      // Volumes can be turned freely to bring the far side round.
      this.pitch = THREE.MathUtils.clamp(this.pitch + dy * 0.004, -0.9, 0.9);
    } else {
      // Never tilt the disc edge-on: below about -0.1 the files collapse into a line.
      this.pitch = THREE.MathUtils.clamp(this.pitch + dy * 0.004, -0.1, 0.7);
    }
  }

  /** Put dragged files back and reset the view angle. */
  recenter(): void {
    for (const node of this.nodes) {
      const from = node.offset.clone();
      void this.tweener.to({ from: 1, to: 0, duration: 650, ease: ease.outBack, update: (v) => node.offset.copy(from).multiplyScalar(v) });
    }
    const yaw = this.yaw;
    const pitch = this.pitch;
    const pan = this.pan.clone();
    this.yawVelocity = 0;
    void this.tweener.to({
      from: 1,
      to: 0,
      duration: 700,
      ease: ease.outCubic,
      update: (v) => {
        this.yaw = yaw * v;
        this.pitch = pitch * v;
        this.pan.copy(pan).multiplyScalar(v);
      },
    });
    this.userZoom = 1;
  }

  // ---------- Lifecycle ----------

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastFrame = performance.now();
    requestAnimationFrame(this.frame);
  }

  stop(): void {
    this.running = false;
    this.dragMode = 'none';
    this.tweener.finishAll();
  }

  /** Grid rises, stars fade in, the core ignites. */
  async boot(): Promise<void> {
    // The frame loop raises the grid from here to wherever the layout wants its floor.
    this.grid.position.y = this.floorTarget - 30;
    const uniforms = this.grid.material.uniforms;
    await Promise.all([
      this.tweener.to({ from: 0, to: 1, duration: 1200, update: (v) => (uniforms.uOpacity.value = v) }),
      this.tweener.to({ from: 0, to: 1, duration: 1600, update: (v) => (this.starFade = v) }),
      this.tweener.to({ from: 0.0001, to: 1, duration: 1200, delay: 350, ease: ease.outElastic, update: (v) => (this.coreScale = v) }),
    ]);
  }

  async powerDown(): Promise<void> {
    this.interactive = false;
    void this.tweener.to({ from: this.decorLevel, to: 0, duration: 380, ease: ease.inCubic, update: (v) => (this.decorLevel = v) });
    await Promise.all([
      ...this.nodes.map((node) =>
        this.tweener.to({ from: node.radial, to: 0, duration: 380, ease: ease.inCubic, update: (v) => { node.radial = v; node.scale = v; node.build = v; } }),
      ),
      this.tweener.to({ from: this.coreScale, to: 0.0001, duration: 450, delay: 150, ease: ease.inCubic, update: (v) => (this.coreScale = v) }),
    ]);
  }

  /** Animate the current folder away. `target` is the folder being entered. */
  async leave(kind: 'down' | 'up', target?: HoloEntry): Promise<void> {
    this.interactive = false;
    this.dragMode = 'none';
    this.callbacks.hover(null);
    this.hovered = null;
    this.selected = null;
    void this.tweener.to({ from: this.decorLevel, to: 0, duration: 380, ease: ease.inCubic, update: (v) => (this.decorLevel = v) });
    // Diving through open space stretches the view, like a jump to warp.
    if (kind === 'down' && this.world === 'starmap' && !this.reducedMotion) {
      void this.tweener.to({ from: this.camera.fov, to: 104, duration: 600, ease: ease.inCubic, update: (v) => this.setFov(v) });
    }
    if (kind === 'down') {
      const node = this.nodes.find((candidate) => candidate.entry.path === target?.path);
      const destination = new THREE.Vector3();
      node?.group.getWorldPosition(destination);
      const start = this.lookTarget.clone();
      await Promise.all([
        this.tweener.to({ from: 0, to: 1, duration: 620, ease: ease.inOutCubic, update: (v) => this.lookTarget.lerpVectors(start, destination, v) }),
        this.tweener.to({ from: this.zoom, to: 0.3, duration: 620, ease: ease.inCubic, update: (v) => (this.zoom = v) }),
        ...this.nodes
          .filter((candidate) => candidate !== node)
          .map((other) =>
            this.tweener.to({ from: 1, to: 2.4, duration: 520, ease: ease.inCubic, update: (v) => { other.radial = v; other.scale = Math.max(0, 1 - (v - 1) / 1.1); other.build = Math.max(0, 1 - (v - 1) / 0.9); } }),
          ),
        this.tweener.to({ from: this.coreScale, to: 0.25, duration: 520, ease: ease.inCubic, update: (v) => (this.coreScale = v) }),
        this.glitch(),
      ]);
    } else {
      await Promise.all([
        ...this.nodes.map((node, i) =>
          this.tweener.to({ from: 1, to: 0, duration: 380, delay: Math.min(i * 3, 160), ease: ease.inCubic, update: (v) => { node.radial = v; node.scale = v; node.build = v; } }),
        ),
        this.tweener.to({ from: this.zoom, to: 1.4, duration: 420, ease: ease.inCubic, update: (v) => (this.zoom = v) }),
      ]);
    }
  }

  /** Replace the galaxy with a folder's contents and animate it in. */
  async show(listing: HoloListing, kind: 'enter' | 'down' | 'up', layout: SceneLayout = this.layout): Promise<void> {
    this.interactive = false;
    this.clearNodes();
    this.layout = layout;
    this.yaw = 0;
    this.pitch = 0;
    this.yawVelocity = 0;
    this.pan.set(0, 0);
    const placement = place(listing.entries.length, layout);
    this.ensureContainers(placement);
    const dirs = listing.entries.filter((entry) => entry.is_dir).length;
    const files = listing.entries.length - dirs;
    if (dirs > this.batches.dirWire.build.count || files > this.batches.file.build.count) {
      this.createBatches(Math.max(dirs, this.batches.dirWire.build.count), Math.max(files, this.batches.file.build.count));
    }
    const showAllLabels = listing.entries.length <= 30;
    listing.entries.forEach((entry, index) => {
      const node = this.createNode(entry, placement.slots[index], index);
      if (showAllLabels || (entry.is_dir && index < 40)) node.label = this.createLabel(entry);
      this.nodes.push(node);
      this.hitTargets.push(node.hit);
      this.nodeByHit.set(node.hit, node);
    });
    this.tunnelDepth = Math.max(0, (placement.height ?? 0) - TUNNEL_GAP);
    this.buildNetwork(placement);
    this.batches.dirWire.mesh.count = this.dirCount;
    this.batches.dirCore.mesh.count = this.dirCount;
    this.batches.file.mesh.count = this.fileCount;
    this.core.position.set(0, 0, layout === 'wall' ? -10 : 0);
    // Fit the arrangement, but cap the distance so large folders stay legible; drag to explore.
    this.fitDistance = placement.distance !== undefined
      ? Math.min(82, placement.distance)
      : Math.min(70, layout === 'wall' ? 10 + placement.extent * 1.5 : 14 + placement.extent * 1.3);
    // The floor grid drops out of the way of tall arrangements.
    this.floorTarget = -Math.max(10, placement.floor ?? 10);
    this.lookTarget.set(0, 0, 0);

    if (this.camera.fov !== BASE_FOV) {
      void this.tweener.to({ from: this.camera.fov, to: BASE_FOV, duration: 800, ease: ease.outCubic, update: (v) => this.setFov(v) });
    }
    const fromRadial = kind === 'up' ? 2.2 : 0;
    const fromZoom = kind === 'down' ? 0.45 : kind === 'up' ? 1.45 : 0.7;
    const total = this.nodes.length;
    await Promise.all([
      this.tweener.to({ from: fromZoom, to: 1, duration: 950, ease: ease.outCubic, update: (v) => (this.zoom = v) }),
      this.tweener.to({ from: this.coreScale, to: 1, duration: 900, ease: ease.outElastic, update: (v) => (this.coreScale = v) }),
      this.tweener.to({ from: 0, to: 1, duration: 1100, delay: 200, ease: ease.outCubic, update: (v) => (this.decorLevel = v) }),
      ...this.nodes.map((node, i) =>
        this.tweener.to({
          from: fromRadial,
          to: 1,
          duration: 820,
          delay: 80 + (i / Math.max(1, total)) * 520,
          ease: kind === 'up' ? ease.outCubic : ease.outBack,
          update: (v) => {
            node.radial = v;
            node.scale = kind === 'up' ? Math.min(1, 2 - v / 1.1) : Math.min(1, v * 1.4);
          },
        }),
      ),
      // Each object scans in from the bottom a moment after it starts moving.
      ...this.nodes.map((node, i) =>
        this.tweener.to({ from: 0, to: 1, duration: 700, delay: 260 + (i / Math.max(1, total)) * 620, ease: ease.inOutCubic, update: (v) => (node.build = v) }),
      ),
    ]);
    this.interactive = true;
  }

  private setFov(fov: number): void {
    this.camera.fov = fov;
    this.camera.updateProjectionMatrix();
  }

  private ensureContainers(placement: Placement): void {
    for (const container of this.containers) container.removeFromParent();
    this.containers.length = 0;
    this.orbitLines.length = 0;
    for (let index = 0; index < placement.containers; index += 1) {
      const container = new THREE.Group();
      if (this.layout === 'orbit' || this.layout === 'dial') {
        container.rotation.x = (index % 2 ? -1 : 1) * 0.04;
        container.userData.speed = (index % 2 ? -1 : 1) * (0.03 / (1 + index * 0.45));
        const radius = placement.orbitRadii[index];
        const points: THREE.Vector3[] = [];
        for (let i = 0; i < 200; i += 1) {
          const a = (i / 200) * Math.PI * 2;
          points.push(new THREE.Vector3(Math.cos(a) * radius, index % 2 === 0 ? 0 : 1.4, Math.sin(a) * radius));
        }
        const line = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(points), this.line(index % 3 === 2 ? 'secondary' : 'primary', 0.16));
        container.add(line);
        this.orbitLines.push(line);
      } else {
        container.userData.speed = DRIFT[this.layout];
      }
      this.containers.push(container);
      this.galaxy.add(container);
    }
  }

  // ---------- Network layouts ----------

  private clearNetwork(): void {
    this.decor.traverse((object) => (object as THREE.Mesh).geometry?.dispose());
    this.decor.clear();
    this.decor.removeFromParent();
    this.decorSpinners = [];
    for (const object of [this.linkLines, this.pulsePoints]) {
      object?.removeFromParent();
      object?.geometry.dispose();
    }
    this.linkLines = null;
    this.pulsePoints = null;
    this.pulses = [];
    this.links = [];
    this.linksOf = [];
  }

  /** Links, pulses and the frame for a network layout. Everything lives in container 0. */
  private buildNetwork(placement: Placement): void {
    this.clearNetwork();
    this.core.visible = this.world === 'grid' && !LINKED.has(this.layout);
    if (this.layout === 'dial') {
      this.buildDial(placement.extent);
      return;
    }
    if (!LINKED.has(this.layout)) return;
    const host = this.containers[0];
    const links = placement.links ?? [];
    this.links = links;
    this.linksOf = placement.slots.map(() => []);
    links.forEach(([a, b], index) => {
      this.linksOf[a].push(index);
      this.linksOf[b].push(index);
    });
    const dynamic = (size: number) => new THREE.BufferAttribute(new Float32Array(size), 3).setUsage(THREE.DynamicDrawUsage);
    if (links.length) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', dynamic(links.length * 6));
      geometry.setAttribute('color', dynamic(links.length * 6));
      this.linkLines = new THREE.LineSegments(geometry, this.linkMaterial);
      this.linkLines.frustumCulled = false;
      host.add(this.linkLines);
      const count = this.reducedMotion ? 0 : Math.min(MAX_PULSES, links.length);
      if (count) {
        const points = new THREE.BufferGeometry();
        points.setAttribute('position', dynamic(count * 3));
        points.setAttribute('color', dynamic(count * 3));
        this.pulsePoints = new THREE.Points(points, this.pulseMaterial);
        this.pulsePoints.frustumCulled = false;
        host.add(this.pulsePoints);
        for (let i = 0; i < count; i += 1) {
          this.pulses.push({ link: Math.floor(Math.random() * links.length), progress: Math.random(), speed: 0.5 + Math.random() * 0.9, reverse: Math.random() < 0.5 });
        }
      }
    }

    const radius = placement.radius ?? placement.extent;
    const spin = (object: THREE.Object3D, speed: number) => this.spinDecor(object, speed);
    const ring = (size: number, tube: number, arc: number, tone: Tone, opacity: number, tilt = 0) => this.arc(size, tube, arc, tone, opacity, tilt);
    if (this.layout === 'globe') {
      // Latitude and longitude lines just under the surface the files sit on.
      const shell = radius * 0.9;
      const points: THREE.Vector3[] = [];
      const circle = (at: (angle: number) => THREE.Vector3) => {
        for (let i = 0; i < 72; i += 1) points.push(at((i / 72) * Math.PI * 2), at(((i + 1) / 72) * Math.PI * 2));
      };
      for (const degrees of [-60, -30, 0, 30, 60]) {
        const latitude = THREE.MathUtils.degToRad(degrees);
        const r = Math.cos(latitude) * shell;
        const y = Math.sin(latitude) * shell;
        circle((angle) => new THREE.Vector3(Math.cos(angle) * r, y, Math.sin(angle) * r));
      }
      for (let i = 0; i < 6; i += 1) {
        const longitude = (i / 6) * Math.PI;
        circle((angle) => new THREE.Vector3(Math.cos(angle) * Math.cos(longitude) * shell, Math.sin(angle) * shell, Math.cos(angle) * Math.sin(longitude) * shell));
      }
      this.decor.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(points), this.line('primary', 0.12)));
      this.decor.add(new THREE.Mesh(new THREE.IcosahedronGeometry(radius * 0.22, 1), this.wire('secondary', 0.3)));
      this.decor.add(spin(ring(radius * 1.15, 0.035, Math.PI * 1.5, 'primary', 0.8, 0.3), 0.12));
      this.decor.add(spin(ring(radius * 1.21, 0.05, Math.PI * 0.45, 'accent', 0.9, 0.3), -0.3));
      this.decor.add(spin(ring(radius * 1.28, 0.02, Math.PI * 1.1, 'secondary', 0.6, -0.5), 0.2));
    } else if (this.layout === 'tunnel') {
      // Hoops between the file rings and rails along the walls, running past both ends.
      const hoop = radius + 2.6;
      const rings = Math.ceil((placement.height ?? 0) / TUNNEL_GAP);
      for (let k = -1; k <= rings + 2; k += 1) {
        const gate = ((k % 3) + 3) % 3 === 0;
        const mesh = new THREE.Mesh(
          new THREE.TorusGeometry(hoop, gate ? 0.08 : 0.025, 6, 96, gate ? Math.PI * 1.3 : Math.PI * 2),
          this.solid(gate ? 'accent' : k % 2 ? 'secondary' : 'primary', gate ? 0.9 : 0.55),
        );
        mesh.position.z = -k * TUNNEL_GAP + TUNNEL_GAP / 2;
        mesh.rotation.z = k * 0.9;
        this.decor.add(gate ? spin(mesh, k % 2 ? 0.35 : -0.35) : mesh);
      }
      const rails: THREE.Vector3[] = [];
      for (let i = 0; i < 8; i += 1) {
        const angle = (i / 8) * Math.PI * 2;
        rails.push(new THREE.Vector3(Math.cos(angle) * hoop, Math.sin(angle) * hoop, TUNNEL_GAP * 2.5), new THREE.Vector3(Math.cos(angle) * hoop, Math.sin(angle) * hoop, -(rings + 2.5) * TUNNEL_GAP));
      }
      this.decor.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(rails), this.line('primary', 0.3)));
    } else if (this.layout === 'helix') {
      const half = (placement.height ?? 0) / 2 + 2.5;
      const axis = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, -half, 0), new THREE.Vector3(0, half, 0)]);
      this.decor.add(new THREE.LineSegments(axis, this.line('secondary', 0.45)));
      for (const end of [-1, 1]) {
        const cap = spin(ring(radius, 0.04, Math.PI * 1.6, 'primary', 0.85), 0.5 * end);
        const inner = spin(ring(radius * 0.55, 0.03, Math.PI * 0.8, 'accent', 0.9), -0.9 * end);
        cap.position.y = inner.position.y = end * half;
        this.decor.add(cap, inner);
      }
    }
    this.decor.scale.setScalar(0.0001);
    host.add(this.decor);
  }

  private spinDecor<T extends THREE.Object3D>(object: T, speed: number, axis: Spinner['axis'] = 'z'): T {
    if (speed) this.decorSpinners.push({ object, axis, speed });
    return object;
  }

  /** A flat ring (optionally a partial arc) around the vertical axis, tilted by `tilt`. It spins about its own z. */
  private arc(size: number, tube: number, arc: number, tone: Tone, opacity: number, tilt = 0, start = 0): THREE.Mesh {
    const mesh = new THREE.Mesh(new THREE.TorusGeometry(size, tube, 6, Math.max(24, Math.round(size * 12)), arc), this.solid(tone, opacity));
    mesh.rotation.set(Math.PI / 2 + tilt, 0, start);
    return mesh;
  }

  /** Radial tick marks around the vertical axis, like the edge of a gauge. It spins about y. */
  private ticks(radius: number, count: number, length: number, tone: Tone, opacity: number): THREE.LineSegments {
    const points: THREE.Vector3[] = [];
    for (let i = 0; i < count; i += 1) {
      const angle = (i / count) * Math.PI * 2;
      points.push(new THREE.Vector3(Math.cos(angle) * radius, 0, Math.sin(angle) * radius), new THREE.Vector3(Math.cos(angle) * (radius + length), 0, Math.sin(angle) * (radius + length)));
    }
    return new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(points), this.line(tone, opacity));
  }

  /**
   * The HUD world's instrument: rotating arcs and gauges in the hub, a bezel outside the
   * file rings. Pieces sit at different depths (local y faces the camera) for parallax.
   */
  private buildDial(extent: number): void {
    const add = (object: THREE.Object3D, depth: number, speed: number, axis: Spinner['axis'] = 'z') => {
      object.position.y = depth;
      this.decor.add(this.spinDecor(object, speed, axis));
    };
    const full = Math.PI * 2;
    // Hub, inside the first file ring.
    add(this.arc(0.7, 0.09, full, 'accent', 1), 2.6, 0);
    add(this.arc(1.6, 0.06, Math.PI * 1.5, 'primary', 0.95), 2.2, 0.9);
    add(this.arc(2.5, 0.13, Math.PI * 0.5, 'accent', 0.9), 1.6, -1.3);
    add(this.arc(2.5, 0.13, Math.PI * 0.5, 'accent', 0.9, 0, Math.PI), 1.6, -1.3);
    add(this.arc(3.3, 0.02, full, 'secondary', 0.7), 1, 0);
    add(this.ticks(3.8, 72, 0.5, 'primary', 0.75), 0.6, 0.25, 'y');
    for (let i = 0; i < 3; i += 1) add(this.arc(5.3, 0.09, Math.PI * 0.42, 'primary', 0.85, 0, (i / 3) * full), 0.2, 0.5);
    add(this.ticks(6.3, 180, 0.28, 'secondary', 0.55), -0.4, -0.12, 'y');
    add(this.arc(7.5, 0.035, Math.PI * 1.7, 'accent', 0.75), -1, -0.35);
    add(this.ticks(8.2, 12, 1, 'primary', 0.95), -1, 0.08, 'y');
    add(this.arc(9.6, 0.02, Math.PI * 0.9, 'secondary', 0.6), -1.6, 0.18);
    // Bezel, outside the last file ring.
    const outer = extent + 3.2;
    add(this.arc(outer, 0.03, full, 'primary', 0.55), 0, 0);
    add(this.ticks(outer + 0.4, 240, 0.4, 'primary', 0.5), 0, 0.03, 'y');
    add(this.ticks(outer + 0.4, 24, 1.1, 'accent', 0.9), 0, 0.03, 'y');
    add(this.arc(outer + 2, 0.12, Math.PI * 0.32, 'accent', 0.9), -0.8, 0.22);
    add(this.arc(outer + 2, 0.12, Math.PI * 0.18, 'secondary', 0.9, 0, Math.PI), -0.8, 0.22);
    add(this.arc(outer + 2.8, 0.025, Math.PI * 1.2, 'primary', 0.5, 0, 1), -1.4, -0.1);
    this.decor.scale.setScalar(0.0001);
    this.galaxy.add(this.decor);
  }

  /** Follow the nodes with the links, and move the pulses along them. */
  private updateNetwork(dt: number): void {
    for (const spinner of this.decorSpinners) spinner.object.rotation[spinner.axis] += dt * spinner.speed;
    this.decor.scale.setScalar(Math.max(0.0001, this.decorLevel));
    if (!this.linkLines) return;
    const fade = 1 - this.standbyLevel * 0.6;
    const { primary, secondary, accent } = this.colors;
    const nodes = this.nodes;
    const position = this.linkLines.geometry.getAttribute('position') as THREE.BufferAttribute;
    const color = this.linkLines.geometry.getAttribute('color') as THREE.BufferAttribute;
    for (let i = 0; i < this.links.length; i += 1) {
      const a = nodes[this.links[i][0]];
      const b = nodes[this.links[i][1]];
      position.setXYZ(i * 2, a.group.position.x, a.group.position.y, a.group.position.z);
      position.setXYZ(i * 2 + 1, b.group.position.x, b.group.position.y, b.group.position.z);
      // A link lights up in the accent colour while either of its nodes is targeted.
      const hot = Math.max(a.hover, b.hover);
      const level = Math.min(a.build, b.build) * fade * (0.3 + hot * 0.9);
      const r = (primary.r + (accent.r - primary.r) * hot) * level;
      const g = (primary.g + (accent.g - primary.g) * hot) * level;
      const bl = (primary.b + (accent.b - primary.b) * hot) * level;
      color.setXYZ(i * 2, r, g, bl);
      color.setXYZ(i * 2 + 1, r, g, bl);
    }
    position.needsUpdate = true;
    color.needsUpdate = true;

    if (!this.pulsePoints) return;
    const at = this.pulsePoints.geometry.getAttribute('position') as THREE.BufferAttribute;
    const tint = this.pulsePoints.geometry.getAttribute('color') as THREE.BufferAttribute;
    const focus = this.hovered ? this.linksOf[this.hovered.index] : undefined;
    this.pulses.forEach((pulse, i) => {
      pulse.progress += dt * pulse.speed;
      if (pulse.progress >= 1) {
        pulse.progress = 0;
        pulse.speed = 0.5 + Math.random() * 0.9;
        if (focus?.length && this.hovered && Math.random() < 0.7) {
          // Signals fire outward from the node being aimed at.
          pulse.link = focus[Math.floor(Math.random() * focus.length)];
          pulse.reverse = this.links[pulse.link][0] !== this.hovered.index;
        } else {
          pulse.link = Math.floor(Math.random() * this.links.length);
          pulse.reverse = Math.random() < 0.5;
        }
      }
      const a = nodes[this.links[pulse.link][0]];
      const b = nodes[this.links[pulse.link][1]];
      const along = pulse.reverse ? 1 - pulse.progress : pulse.progress;
      at.setXYZ(
        i,
        a.group.position.x + (b.group.position.x - a.group.position.x) * along,
        a.group.position.y + (b.group.position.y - a.group.position.y) * along,
        a.group.position.z + (b.group.position.z - a.group.position.z) * along,
      );
      const hot = Math.max(a.hover, b.hover);
      const level = Math.sin(pulse.progress * Math.PI) * Math.min(a.build, b.build) * fade * (0.9 + hot * 0.6);
      const base = hot > 0.5 ? accent : secondary;
      tint.setXYZ(i, (base.r * 0.6 + 0.4) * level, (base.g * 0.6 + 0.4) * level, (base.b * 0.6 + 0.4) * level);
    });
    at.needsUpdate = true;
    tint.needsUpdate = true;
  }

  private createNode(entry: HoloEntry, slot: Slot, index: number): GalaxyNode {
    const tone = toneFor(entry);
    const group = new THREE.Group();
    // The body is an empty transform; its world matrix places this node's instances.
    const body = new THREE.Group();
    let instance: number;
    if (entry.is_dir) {
      instance = this.dirCount++;
      this.initInstance(this.batches.dirWire, instance, tone);
      this.initInstance(this.batches.dirCore, instance, 'secondary');
    } else {
      instance = this.fileCount++;
      this.initInstance(this.batches.file, instance, tone);
    }
    const hit = new THREE.Mesh(entry.is_dir ? this.geometries.hitDir : this.geometries.hitFile, this.hitMaterial);
    group.add(body, hit);
    const container = this.containers[slot.container];
    container.add(group);
    return {
      entry, group, body, hit, container,
      home: slot.home, offset: new THREE.Vector3(),
      phase: Math.random() * Math.PI * 2, index, radial: 0, scale: 0, hover: 0, build: 0, instance, label: null,
      labelOpacity: '', labelTransform: '', labelHot: false,
    };
  }

  private createLabel(entry: HoloEntry): HTMLElement {
    const label = document.createElement('div');
    label.className = `node-label${entry.is_dir ? ' is-dir' : ''}`;
    label.textContent = entry.name;
    this.labelLayer.append(label);
    return label;
  }

  private clearNodes(): void {
    for (const node of this.nodes) {
      node.group.removeFromParent();
      node.label?.remove();
    }
    this.nodes = [];
    this.hitTargets = [];
    this.nodeByHit.clear();
    this.dirCount = 0;
    this.fileCount = 0;
    for (const batch of Object.values(this.batches)) batch.mesh.count = 0;
    this.hovered = null;
    this.selected = null;
    this.reticle.visible = false;
  }

  /** Where a file's node is on screen, so a window can open out of it. */
  screenPoint(path: string): { x: number; y: number } | undefined {
    const node = this.nodes.find((candidate) => candidate.entry.path === path);
    if (!node) return undefined;
    const position = new THREE.Vector3();
    node.group.getWorldPosition(position);
    position.project(this.camera);
    return { x: ((position.x + 1) / 2) * window.innerWidth, y: ((1 - position.y) / 2) * window.innerHeight };
  }

  clearSelection(): void {
    this.selected = null;
  }

  /** A short burst of colour fringing, used when diving into a folder. */
  glitch(): Promise<void> {
    if (this.reducedMotion || !this.fringeOn) return Promise.resolve();
    const uniform = this.finalPass.uniforms.uAmount;
    return this.tweener.to({ from: 0.09, to: FRINGE_BASE, duration: 520, ease: ease.outCubic, update: (v) => {
      if (this.fringeOn) uniform.value = v;
    } });
  }

  /** Idle mode: the galaxy dims and the core breathes slowly until the user returns. */
  setStandby(on: boolean): void {
    this.standby = on;
  }

  // ---------- Frame ----------

  /** Render scale, bloom and frame cap. Lower tiers leave GPU time for hand tracking. */
  setQuality(tier: QualityTier): void {
    const settings = QUALITY[tier];
    this.quality = tier;
    this.renderScale = Math.min(window.devicePixelRatio, 1) * settings.scale;
    this.frameInterval = 1000 / settings.cap;
    this.bloom.enabled = settings.bloom;
    this.setFringe(tier === 'high' && !this.reducedMotion);
    this.resize();
  }

  private setFringe(on: boolean): void {
    this.fringeOn = on;
    this.finalPass.uniforms.uAmount.value = on ? FRINGE_BASE : 0;
  }

  get qualityTier(): QualityTier {
    return this.quality;
  }

  get renderFps(): number {
    return this.measuredFps;
  }

  private frame = (now: number) => {
    if (!this.running) return;
    requestAnimationFrame(this.frame);
    // Skip frames above the tier's cap; animations use real elapsed time, so speed is unchanged.
    // Standby only breathes, so 15 fps is plenty and frees the GPU for anything else.
    const interval = this.standby ? Math.max(this.frameInterval, 1000 / 15) : this.frameInterval;
    if (now - this.lastFrame < interval - 2) return;
    const dt = Math.min(0.05, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    this.framesThisSecond += 1;
    if (now - this.fpsWindowStart >= 1000) {
      this.measuredFps = (this.framesThisSecond * 1000) / (now - this.fpsWindowStart);
      this.framesThisSecond = 0;
      this.fpsWindowStart = now;
    }
    const t = now / 1000;
    this.tweener.tick(now);

    this.grid.material.uniforms.uTime.value = t;
    this.grid.position.y += (this.floorTarget - this.grid.position.y) * Math.min(1, dt * 4);
    this.holoTime.value = t;
    this.standbyLevel += ((this.standby ? 1 : 0) - this.standbyLevel) * Math.min(1, dt * 1.5);
    this.stars.rotation.y += dt * 0.006;
    (this.stars.material as THREE.PointsMaterial).opacity = this.starFade * STAR_LEVEL[this.world || 'grid'];
    if (this.nebula.visible) {
      this.nebula.rotation.y -= dt * 0.004;
      this.nebula.material.opacity = this.starFade * 0.38 * (1 - this.standbyLevel * 0.5);
    }

    // Standby swaps the quick pulse for a slow, deep breath.
    const breath = Math.sin(t * 2.2) * 0.035 * (1 - this.standbyLevel) + Math.sin(t * 0.9) * 0.12 * this.standbyLevel;
    this.core.scale.setScalar(this.coreScale * (1 + breath));
    for (const spinner of this.spinners) spinner.object.rotation[spinner.axis] += dt * spinner.speed;
    for (const electron of this.electrons) {
      const a = t * electron.speed + electron.phase;
      electron.mesh.position.set(Math.cos(a) * electron.radius, Math.sin(a) * electron.radius, 0);
    }

    // Drift stops while the user aims or drags, so targets never slide away.
    const still = this.hovered !== null || this.dragMode !== 'none';
    if (!still) for (const container of this.containers) container.rotation.y += dt * (container.userData.speed as number);
    if (this.dragMode !== 'view') {
      this.yaw += this.yawVelocity;
      this.yawVelocity *= Math.exp(-dt * 3.5);
    }
    if (this.layout === 'dial') {
      // The dial faces the camera: dragging spins it like a wheel and tips it slightly.
      this.view.rotation.set(this.pitch, 0, 0);
      this.galaxy.rotation.set(Math.PI / 2, this.yaw, 0);
    } else if (this.layout === 'tunnel') {
      if (!still && this.dragMode === 'none') this.yaw += dt * 0.025;
      this.view.rotation.set(0, 0, this.yaw);
      this.galaxy.rotation.set(0, 0, 0);
    } else {
      this.view.rotation.set(this.pitch, this.yaw, 0);
      this.galaxy.rotation.set(0, 0, 0);
    }
    // In the tunnel the pan is depth: the view slides toward the camera as the user flies in.
    const travel = this.layout === 'tunnel' ? this.travel += (this.pan.y - this.travel) * Math.min(1, dt * 5) : 0;
    this.view.position.set(this.layout === 'tunnel' ? 0 : this.pan.x, this.layout === 'tunnel' ? 0 : this.pan.y, travel);

    for (const node of this.nodes) {
      const bob = node === this.dragNode ? 0 : Math.sin(t * 1.1 + node.phase) * 0.22;
      node.group.position.copy(node.home).multiplyScalar(node.radial).add(node.offset);
      node.group.position.y += bob;
      const target = node === this.hovered || node === this.dragNode ? 1 : 0;
      node.hover += (target - node.hover) * Math.min(1, dt * 12);
      node.body.scale.setScalar(Math.max(0.0001, node.scale * (1 + node.hover * 0.7)));
      node.body.rotation.y += dt * (0.6 + node.hover * 3);
      node.body.rotation.x += dt * 0.3;
    }
    this.writeInstances();
    this.updateNetwork(dt);

    const distance = this.fitDistance * this.zoom * this.userZoom;
    const elevation = ELEVATION[this.layout];
    const sway = this.dragMode === 'none' ? 1 : 0;
    const desired = this.scratch.set(
      this.lookTarget.x + this.parallax.x * 2.4 * sway,
      this.lookTarget.y + distance * elevation - this.parallax.y * 1.6 * sway,
      this.lookTarget.z + distance,
    );
    this.camera.position.lerp(desired, Math.min(1, dt * 4));
    this.camera.lookAt(this.lookTarget);

    if (this.dragMode === 'none') this.pick();
    this.updateReticle(t);
    this.composer.render();
    this.updateLabels();
  };

  /** Copy each node's world transform, build and opacity into its batch instances. */
  private writeInstances(): void {
    if (!this.nodes.length) return;
    this.view.updateMatrixWorld();
    const fade = 1 - this.standbyLevel * 0.6;
    const { dirWire, dirCore, file } = this.batches;
    for (const node of this.nodes) {
      const opacity = fade * (1 + node.hover * 0.6);
      const matrix = node.body.matrixWorld;
      if (node.entry.is_dir) {
        this.writeInstance(dirWire, node.instance, matrix, node.build, opacity);
        this.writeInstance(dirCore, node.instance, matrix, node.build, opacity);
      } else {
        this.writeInstance(file, node.instance, matrix, node.build, opacity);
      }
    }
    for (const batch of [dirWire, dirCore, file]) {
      if (!batch.mesh.count) continue;
      batch.mesh.instanceMatrix.needsUpdate = true;
      batch.build.needsUpdate = true;
      batch.opacity.needsUpdate = true;
    }
  }

  private pick(): void {
    if (!this.interactive || this.pointer.x > 2) {
      this.setHovered(null);
      return;
    }
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObjects(this.hitTargets, false);
    const node = hits.length ? this.nodeByHit.get(hits[0].object) ?? null : null;
    const now = performance.now();
    if (node) {
      this.lastHoverHit = now;
      this.setHovered(node);
    } else if (!this.hovered || now - this.lastHoverHit > HOVER_STICK_MS) {
      // Hand tremor and the pinch itself nudge the cursor; keep the target briefly so
      // a pinch that slips just off a node still grabs it instead of spinning the view.
      this.setHovered(null);
    }
  }

  private setHovered(node: GalaxyNode | null): void {
    if (node === this.hovered) return;
    this.hovered = node;
    this.canvas.classList.toggle('over-node', node !== null);
    this.callbacks.hover(node?.entry ?? null);
  }

  private updateReticle(t: number): void {
    const node = this.dragNode && this.dragMode === 'node' ? this.dragNode : this.hovered ?? this.selected;
    this.reticle.visible = node !== null && node.scale > 0.5;
    if (!node) return;
    node.group.getWorldPosition(this.reticle.position);
    this.reticle.quaternion.copy(this.camera.quaternion);
    this.reticle.rotateZ(t * 1.4);
    const pulse = 1 + Math.sin(t * 6) * 0.06;
    this.reticle.scale.setScalar((node.entry.is_dir ? 1.15 : 0.85) * pulse);
  }

  private updateLabels(): void {
    const width = window.innerWidth;
    const height = window.innerHeight;
    const position = this.scratch;
    for (const node of this.nodes) {
      if (!node.label) continue;
      // render() just refreshed every world matrix, so read it directly.
      position.setFromMatrixPosition(node.group.matrixWorld);
      position.project(this.camera);
      const visible = position.z < 1 && node.scale > 0.35;
      const hot = node === this.hovered || node === this.dragNode;
      // Only touch the DOM when a value changes: unchanged writes still cost style work.
      const opacity = visible ? String(Math.min(1, node.scale) * (hot ? 1 : 0.8)) : '0';
      if (opacity !== node.labelOpacity) {
        node.label.style.opacity = opacity;
        node.labelOpacity = opacity;
      }
      if (visible) {
        const transform = `translate(${((position.x + 1) / 2) * width + 16}px, ${((1 - position.y) / 2) * height - 8}px)`;
        if (transform !== node.labelTransform) {
          node.label.style.transform = transform;
          node.labelTransform = transform;
        }
      }
      if (hot !== node.labelHot) {
        node.label.classList.toggle('is-hot', hot);
        node.labelHot = hot;
      }
    }
  }
}
