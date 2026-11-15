import { copyFile, mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

const source = 'node_modules/@mediapipe/tasks-vision/wasm';
const destination = 'public/wasm';
// FilesetResolver.forVisionTasks('/wasm') loads `vision_wasm_internal` whenever WebAssembly
// SIMD is available, which every WebView2 runtime has. The `_nosimd` and `_module` builds
// (about 22 MB together) are never loaded, so they are left out of the app and installer.
const keep = new Set(['vision_wasm_internal.js', 'vision_wasm_internal.wasm']);
await mkdir(destination, { recursive: true });
for (const name of await readdir(destination)) {
  if (!keep.has(name)) await rm(join(destination, name));
}
for (const name of keep) {
  await copyFile(join(source, name), join(destination, name));
}
