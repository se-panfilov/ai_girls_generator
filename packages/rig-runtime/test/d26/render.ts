import type { Spine } from '@rig-runtime/spine';

// D26 spike (experiment, not production). Converts the current pose of a real spine-core skeleton into a list of textured quads.
// The visual smoke test sends this list to a minimal WebGL page. So the browser only rasterises; every position, frame index and
// UV comes from spine-core in Node.js.

export type DrawItem = {
  readonly slot: string;
  readonly page: string;
  /** World x, y of the four corners, in the order of RegionAttachment.computeWorldVertices. */
  readonly vertices: readonly number[];
  readonly uvs: readonly number[];
};

export function drawList(skeleton: Spine.Skeleton, regionAttachment: typeof Spine.RegionAttachment): DrawItem[] {
  const items: DrawItem[] = [];
  for (const slot of skeleton.drawOrder.appliedPose) {
    const pose = slot.appliedPose;
    const attachment = pose.getAttachment();
    if (!(attachment instanceof regionAttachment) || !slot.bone.active) continue;
    const index = attachment.sequence.resolveIndex(pose);
    const region = attachment.sequence.regions[index] as Spine.TextureAtlasRegion | null;
    if (!region) continue;
    const vertices = new Array<number>(8).fill(0);
    attachment.computeWorldVertices(slot, attachment.getOffsets(pose), vertices, 0, 2);
    items.push({ slot: slot.data.name, page: region.page.name, vertices, uvs: [...attachment.sequence.getUVs(index)] });
  }
  return items;
}

/** World point of a logical attachment pixel (x from the left, y from the top) of a slot. Templates have no rotation and scale 1. */
export function logicalPoint(
  skeleton: Spine.Skeleton,
  slotName: string,
  template: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
  x: number,
  y: number
): [number, number] {
  const slot = skeleton.findSlot(slotName);
  if (!slot) throw new Error(`No slot ${slotName}`);
  const bone = slot.bone.appliedPose;
  const localX = template.x - template.width / 2 + x;
  const localY = template.y + template.height / 2 - y;
  return [bone.a * localX + bone.b * localY + bone.worldX, bone.c * localX + bone.d * localY + bone.worldY];
}

/** The page that the visual smoke test loads. It draws a draw list with WebGL 1 (two triangles per quad, straight alpha). */
export const rendererPage = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>D26 spike visual smoke</title>
<style>html,body{margin:0;background:#202028}canvas{display:block}</style></head>
<body><canvas id="view"></canvas>
<script>
"use strict";
const textures = new Map();
let gl = null;
let program = null;
function setup(width, height) {
  const canvas = document.getElementById("view");
  canvas.width = width;
  canvas.height = height;
  gl = canvas.getContext("webgl", { antialias: false, preserveDrawingBuffer: true, premultipliedAlpha: false });
  if (!gl) throw new Error("No WebGL context.");
  const compile = (type, text) => {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, text);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
    return shader;
  };
  program = gl.createProgram();
  gl.attachShader(program, compile(gl.VERTEX_SHADER, "attribute vec2 p; attribute vec2 t; uniform vec4 v; varying vec2 uv; void main(){ uv = t; gl_Position = vec4((p.x - v.x) * v.z * 2.0 / v.w - 1.0, 1.0 - (v.y - p.y) * v.z * 2.0 / " + height + ".0, 0.0, 1.0); }"));
  gl.attachShader(program, compile(gl.FRAGMENT_SHADER, "precision mediump float; uniform sampler2D s; varying vec2 uv; void main(){ gl_FragColor = texture2D(s, uv); }"));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
  const debug = gl.getExtension("WEBGL_debug_renderer_info");
  return debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
}
async function loadPage(name, url) {
  const image = new Image();
  image.src = url;
  await image.decode();
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  textures.set(name, texture);
}
async function draw(scene) {
  const { view, items, samples, counts } = scene;
  gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);
  gl.clearColor(32 / 255, 32 / 255, 40 / 255, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  gl.useProgram(program);
  gl.uniform4f(gl.getUniformLocation(program, "v"), view.x0, view.y0, view.scale, gl.canvas.width);
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  const p = gl.getAttribLocation(program, "p");
  const t = gl.getAttribLocation(program, "t");
  gl.enableVertexAttribArray(p);
  gl.enableVertexAttribArray(t);
  gl.vertexAttribPointer(p, 2, gl.FLOAT, false, 16, 0);
  gl.vertexAttribPointer(t, 2, gl.FLOAT, false, 16, 8);
  for (const item of items) {
    const texture = textures.get(item.page);
    if (!texture) throw new Error("No texture for " + item.page);
    const v = item.vertices;
    const u = item.uvs;
    const data = [];
    for (const corner of [0, 1, 2, 2, 3, 0]) data.push(v[corner * 2], v[corner * 2 + 1], u[corner * 2], u[corner * 2 + 1]);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.STREAM_DRAW);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }
  const width = gl.canvas.width;
  const height = gl.canvas.height;
  const pixels = new Uint8Array(width * height * 4);
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", pixels)), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const read = ([x, y]) => {
    const offset = ((height - 1 - y) * width + x) * 4;
    return Array.from(pixels.subarray(offset, offset + 4));
  };
  const tally = counts.map(() => 0);
  for (let offset = 0; offset < pixels.length; offset += 4) {
    for (const [index, count] of counts.entries()) {
      const c = count.rgba;
      if (pixels[offset] === c[0] && pixels[offset + 1] === c[1] && pixels[offset + 2] === c[2] && pixels[offset + 3] === c[3]) tally[index] += 1;
    }
  }
  return { digest, samples: samples.map((sample) => ({ name: sample.name, rgba: read(sample.at) })), counts: counts.map((count, index) => ({ name: count.name, pixels: tally[index] })) };
}
window.spike = { setup, loadPage, draw };
</script>
</body>
</html>
`;
