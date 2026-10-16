/**
 * Shell-texture fur: real strands, not a fuzzy texture.
 *
 * A furry part is drawn as a stack of shells: copies of its surface pushed out along the normal, one
 * draw call for the whole stack (an instanced geometry where each instance is one shell height).
 * Every point on the surface hashes into a strand cell; a shell keeps a pixel only where a strand
 * still reaches that height, and strands taper toward their tips, so the stack reads as thousands of
 * soft hairs with depth, self-shadowing at the roots and light catching the tips.
 *
 * Secondary motion: the tips bend with a force the character sets each frame (gravity, drag when
 * he flies, a puff when he lands), plus a gentle breeze, so the fur reacts to how the body moves.
 * Lighting is a soft wrap-around key, a fill, a cool sky bounce and a back-light rim (Kajiya-style
 * cheap fur shading), tone mapped like the rest of the scene.
 */
import * as THREE from 'three';

export interface FurOptions {
  /** Number of shells (quality). */
  shells: number;
  /** Strand length in world units at the part's own scale of 1. */
  length: number;
  /** Strands per world unit. */
  density: number;
  /** Fur color at the tips, and at the roots (in the undercoat shadow). */
  tip: THREE.ColorRepresentation;
  root: THREE.ColorRepresentation;
  /** 0..1: shorter fur on the front of the face (so the eyes and mouth stay clear). */
  faceShort?: number;
  /** How far the tips bend under the shared force. */
  bend?: number;
  /** How much the strands lie down along the body (0 = standing straight out). */
  comb?: number;
  /** Shorten on the whole front (ears), not only the face window. */
  frontOnly?: boolean;
  /** Thin parts seen from both sides (wings). */
  doubleSide?: boolean;
}

/** Uniforms every fur part shares, updated once per frame by the character. */
export interface FurShared {
  /** Tip displacement direction and strength, in the character's own space. */
  force: { value: THREE.Vector3 };
  time: { value: number };
}

export function makeFurShared(): FurShared {
  return { force: { value: new THREE.Vector3(0, -0.25, 0) }, time: { value: 0 } };
}

const VERT = /* glsl */ `
attribute float aShell;
uniform float uLength;
uniform float uFaceShort;
uniform float uFrontOnly;
uniform float uBend;
uniform float uComb;
uniform vec3 uForce;
uniform float uTime;
uniform vec3 uScale;
varying vec3 vBase;
varying float vH;
varying vec3 vNormalW;
varying vec3 vViewW;
void main() {
  float h = aShell;
  vec3 n = normalize(normal);
  // The normal and push direction of the scaled surface, in the part's own (unscaled) space.
  vec3 nw = normalize(n / uScale);
  float face = uFaceShort * smoothstep(0.45, 0.8, nw.z) * max(uFrontOnly, 1.0 - smoothstep(0.35, 0.7, abs(nw.y - 0.05)));
  float len = uLength * (1.0 - face);
  vec3 push = nw * len * h;
  // Tips bend with the force (more toward the tip), plus a soft breeze.
  float bend = h * h * uBend;
  vec3 breeze = vec3(sin(uTime * 1.7 + position.y * 4.0), 0.0, cos(uTime * 1.3 + position.x * 4.0)) * 0.08;
  vec3 f = uForce + breeze;
  push += (f - nw * dot(f, nw) * 0.6) * len * bend;
  // Combed: strands lie down along the body (outward and downward), like a plush coat, so they
  // read as soft streaks rather than bristles.
  vec3 down = vec3(0.0, -1.0, 0.0) - nw * nw.y;
  vec3 comb = normalize(down + nw * 0.0001 + vec3(nw.x, 0.0, 0.0) * 0.6);
  push += comb * len * pow(h, 1.4) * uComb;
  vec3 p = position + push / uScale;
  vBase = position * uScale;
  vH = h;
  vec4 wp = modelMatrix * vec4(p, 1.0);
  vNormalW = normalize(mat3(modelMatrix) * (n / uScale));
  vViewW = normalize(cameraPosition - wp.xyz);
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

const FRAG = /* glsl */ `
uniform float uDensity;
uniform vec3 uTip;
uniform vec3 uRoot;
varying vec3 vBase;
varying float vH;
varying vec3 vNormalW;
varying vec3 vViewW;
float hash(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.x + p.y) * p.z);
}
void main() {
  vec3 q = vBase * uDensity;
  vec3 cell = floor(q);
  float r = hash(cell);
  if (vH > 0.0) {
    vec3 off = vec3(hash(cell + 17.0), hash(cell + 41.0), hash(cell + 73.0)) - 0.5;
    float d = length(fract(q) - 0.5 - off * 0.45);
    float strandLen = mix(0.45, 1.0, r);
    if (vH > strandLen) discard;
    float t = vH / strandLen;
    if (d > 0.58 * (1.0 - t * 0.9)) discard;
  }
  vec3 n = normalize(vNormalW);
  vec3 v = normalize(vViewW);
  vec3 keyDir = normalize(vec3(-0.45, 0.75, 0.6));
  vec3 fillDir = normalize(vec3(0.6, -0.2, 0.6));
  float key = pow(clamp(dot(n, keyDir) * 0.5 + 0.5, 0.0, 1.0), 1.4);
  float fill = clamp(dot(n, fillDir) * 0.5 + 0.5, 0.0, 1.0) * 0.25;
  float sky = clamp(n.y * 0.5 + 0.5, 0.0, 1.0) * 0.18;
  float rim = pow(1.0 - clamp(dot(n, v), 0.0, 1.0), 2.5);
  // Roots sit in the undercoat's shadow; tips catch the light.
  float ao = mix(0.68, 1.0, pow(vH, 0.5));
  vec3 base = mix(uRoot, uTip, pow(vH, 0.6));
  vec3 col = base * (0.5 + 0.65 * key + fill) * ao;
  col += vec3(0.62, 0.74, 1.0) * sky * ao;
  col += vec3(0.9, 0.94, 1.0) * rim * (0.2 + 0.5 * vH);
  col *= 0.96 + 0.05 * r;
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

/**
 * Give a mesh fur. The mesh keeps its geometry and transform; its own material is hidden and the
 * shells (one child mesh) draw the surface instead. Returns what to dispose. Meshes that share a
 * material share its hiding too, so give fur to all of them.
 */
export function addFur(
  mesh: THREE.Mesh,
  opts: FurOptions,
  shared: FurShared,
): { geometry: THREE.BufferGeometry; material: THREE.ShaderMaterial } {
  const base = mesh.geometry;
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.index = base.index;
  for (const name of ['position', 'normal']) geometry.setAttribute(name, base.getAttribute(name));
  const n = Math.max(2, Math.round(opts.shells));
  const h = new Float32Array(n);
  for (let i = 0; i < n; i++) h[i] = i / (n - 1);
  geometry.setAttribute('aShell', new THREE.InstancedBufferAttribute(h, 1));
  geometry.instanceCount = n;
  base.computeBoundingSphere();
  geometry.boundingSphere = base.boundingSphere!.clone();
  geometry.boundingSphere.radius *= 1.6;

  const material = new THREE.ShaderMaterial({
    side: opts.doubleSide ? THREE.DoubleSide : THREE.FrontSide,
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms: {
      uLength: { value: opts.length },
      uDensity: { value: opts.density },
      uFaceShort: { value: opts.faceShort ?? 0 },
      uFrontOnly: { value: opts.frontOnly ? 1 : 0 },
      uBend: { value: opts.bend ?? 1 },
      uComb: { value: opts.comb ?? 0.9 },
      uTip: { value: new THREE.Color(opts.tip) },
      uRoot: { value: new THREE.Color(opts.root) },
      uScale: { value: mesh.scale.clone() },
      uForce: shared.force,
      uTime: shared.time,
    },
  });
  const shells = new THREE.Mesh(geometry, material);
  shells.name = 'fur';
  shells.raycast = () => {};
  // A child of the mesh, so it follows every move; the shader undoes the mesh's scale for the
  // strands (they keep their real length and thickness on squashed shapes).
  mesh.add(shells);
  // Keep raycasts (boops) on the original surface, but don't draw it.
  const mat = mesh.material as THREE.Material;
  mat.colorWrite = false;
  mat.depthWrite = false;
  mesh.userData.fur = shells;
  return { geometry, material };
}
