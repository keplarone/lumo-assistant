// GLSL for the Lumo mascot, copied verbatim from docs/reference/lumo-mascot.html.
// Do not edit casually: these shaders define the established look of the character.

export const VERT = /* glsl */`
  varying vec3 vN; varying vec3 vV; varying vec3 vObj; varying vec3 vObjN;
  void main(){
    vObj = position; vObjN = normal;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vN = normalize(normalMatrix * normal);
    vV = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
  }`;
export const COMMON = /* glsl */`
  varying vec3 vN; varying vec3 vV; varying vec3 vObj; varying vec3 vObjN;
  const vec3 LDIR = vec3(-0.43, 0.72, 0.54);
  float hash3(vec3 p){ p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
`;

export const BODY_FRAG = COMMON + /* glsl */`
  uniform float uTime; uniform float uGlow;
  uniform vec3 uTop; uniform vec3 uBot; uniform vec3 uRim; uniform vec3 uGold; uniform vec3 uSpark;
  void main(){
    vec3 N = normalize(vN); vec3 V = normalize(vV);
    float h = smoothstep(-1.05, 1.0, vObj.y);
    vec3 col = mix(uBot, uTop, h);
    // chest: scalloped feather rows
    float front = smoothstep(0.3, 0.85, vObjN.z) * smoothstep(0.2, -0.35, vObj.y);
    vec2 uv = vec2(vObj.x * 5.5, vObj.y * 6.2);
    float row = floor(uv.y); uv.x += mod(row, 2.0) * 0.5;
    vec2 f = vec2(fract(uv.x) - 0.5, fract(uv.y));
    float arc = 1.0 - smoothstep(0.0, 0.07, abs(length(f - vec2(0.0, 1.0)) - 0.5));
    col += front * vec3(0.05, 0.06, 0.15);
    col = mix(col, uGold * 0.85, arc * front * 0.32);
    // star flecks on the back and crown
    vec3 q = vObj * 22.0; float s = hash3(floor(q));
    float star = smoothstep(0.28, 0.0, length(fract(q) - 0.5)) * step(0.972, s);
    star *= 0.45 + 0.55 * sin(uTime * (1.5 + s * 3.0) + s * 60.0);
    col += max(star, 0.0) * uSpark * 0.75 * (1.0 - front);
    float dif = max(dot(N, normalize(LDIR)), 0.0);
    col *= 0.5 + 0.75 * dif;
    float fr = pow(1.0 - max(dot(N, V), 0.0), 2.6);
    col += mix(uRim, uGold, smoothstep(0.2, 1.0, vObj.y)) * fr * (0.55 + 0.6 * uGlow);
    gl_FragColor = vec4(col, 1.0);
  }`;

export const DISC_FRAG = COMMON + /* glsl */`
  uniform vec3 uCenter; uniform vec3 uEdge; uniform vec3 uRing; uniform float uGlow;
  void main(){
    vec3 N = normalize(vN); vec3 V = normalize(vV);
    float r = length(vObj.xy);
    float a = atan(vObj.y, vObj.x);
    vec3 col = mix(uCenter, uEdge, smoothstep(0.35, 0.95, r));
    col *= 0.9 + 0.1 * sin(a * 30.0 + r * 4.0);
    float ring = smoothstep(0.8, 0.88, r) * (1.0 - smoothstep(0.9, 0.98, r));
    col = mix(col, uRing, ring * 0.85);
    float dif = max(dot(N, normalize(LDIR)), 0.0);
    col *= 0.62 + 0.5 * dif;
    col += uRing * ring * 0.25 * uGlow;
    gl_FragColor = vec4(col, 1.0);
  }`;

export const IRIS_FRAG = COMMON + /* glsl */`
  uniform vec3 uIn; uniform vec3 uOut; uniform vec3 uPupil; uniform vec3 uSclera; uniform vec3 uCircuit;
  uniform float uDilate; uniform float uGlow; uniform float uTime;
  void main(){
    vec3 N = normalize(vN); vec3 V = normalize(vV);
    vec3 p = normalize(vObj);
    float d = acos(clamp(p.z, -1.0, 1.0));
    float a = atan(p.y, p.x);
    float irisR = 0.78; float pupilR = 0.3 * uDilate;
    float ti = d / irisR;
    vec3 iris = mix(uIn, uOut, smoothstep(0.3, 1.0, ti));
    iris *= 0.82 + 0.22 * sin(a * 26.0 + ti * 7.0) * sin(a * 9.0 - ti * 3.0 + 1.3);
    iris += uIn * (1.0 - ti) * 0.45 * uGlow;
    iris = mix(iris, uOut * 0.25, smoothstep(0.86, 1.0, ti));
    // the AI tell: a slow-turning dashed ring inside the iris
    float tick = step(0.45, fract((a + uTime * 0.35) * 18.0 / 6.2831853));
    float band = 1.0 - smoothstep(0.0, 0.035, abs(ti - 0.6));
    iris = mix(iris, uCircuit, tick * band * 0.7);
    vec3 col = mix(uSclera, iris, 1.0 - smoothstep(irisR - 0.02, irisR + 0.02, d));
    col = mix(col, uPupil, 1.0 - smoothstep(pupilR - 0.025, pupilR + 0.025, d));
    float fr = pow(1.0 - max(dot(N, V), 0.0), 3.0);
    col += uCircuit * fr * 0.25;
    gl_FragColor = vec4(col, 1.0);
  }`;

export const LID_FRAG = COMMON + /* glsl */`
  uniform vec3 uColor; uniform vec3 uLine; uniform vec3 uRim;
  void main(){
    vec3 N = normalize(vN); if (!gl_FrontFacing) N = -N; vec3 V = normalize(vV);
    float dif = max(dot(N, normalize(LDIR)), 0.0);
    vec3 col = uColor * (0.55 + 0.7 * dif);
    float line = 1.0 - smoothstep(0.0, 0.14, abs(vObj.y));
    col = mix(col, uLine, line * 0.9);
    col += uRim * pow(1.0 - max(dot(N, V), 0.0), 2.5) * 0.35;
    gl_FragColor = vec4(col, 1.0);
  }`;

export const LIT_FRAG = COMMON + /* glsl */`
  uniform vec3 uColor; uniform vec3 uRim; uniform float uRimAmt; uniform vec3 uEmissive;
  void main(){
    vec3 N = normalize(vN); if (!gl_FrontFacing) N = -N; vec3 V = normalize(vV);
    vec3 L = normalize(LDIR);
    float dif = max(dot(N, L), 0.0);
    float spec = pow(max(dot(reflect(-L, N), V), 0.0), 28.0);
    float fr = pow(1.0 - max(dot(N, V), 0.0), 2.5);
    vec3 col = uColor * (0.45 + 0.75 * dif) + spec * 0.35 + uRim * fr * uRimAmt + uEmissive;
    gl_FragColor = vec4(col, 1.0);
  }`;

export const CRYSTAL_FRAG = COMMON + /* glsl */`
  uniform vec3 uBase; uniform vec3 uTip; uniform float uPulse; uniform float uTime;
  void main(){
    vec3 N = normalize(vN); vec3 V = normalize(vV);
    float t = clamp(vObj.y * 0.5, 0.0, 1.0);
    vec3 col = mix(uBase, uTip, smoothstep(0.1, 0.9, t));
    float facet = 0.55 + 0.6 * max(dot(N, normalize(LDIR)), 0.0);
    col *= facet;
    col += vec3(1.0) * pow(1.0 - max(dot(N, V), 0.0), 2.0) * 0.55;
    float wave = 0.5 + 0.5 * sin(uTime * 3.0 - t * 7.0);
    col *= 0.75 + 0.45 * uPulse * wave;
    gl_FragColor = vec4(col, 1.0);
  }`;

export const FEATHER_VERT = /* glsl */`
  attribute vec2 aTS;
  varying vec2 vTS; varying vec3 vN; varying vec3 vV; varying float vPhase;
  void main(){
    vTS = aTS;
    vec4 wp = modelMatrix * vec4(0.0, 0.0, 0.0, 1.0);
    vPhase = fract(wp.x * 0.37 + wp.y * 0.21 + wp.z * 0.11);
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vN = normalize(normalMatrix * normal);
    vV = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
  }`;
export const FEATHER_FRAG = /* glsl */`
  uniform vec3 uRoot; uniform vec3 uMid; uniform vec3 uEdge; uniform vec3 uTip;
  uniform float uTime; uniform float uGlow;
  varying vec2 vTS; varying vec3 vN; varying vec3 vV; varying float vPhase;
  void main(){
    float t = clamp(vTS.x, 0.0, 1.0);
    float prof = sin(3.14159265 * pow(max(t, 0.0001), 0.62));
    float e = abs(vTS.y) / max(prof, 0.001);
    if (e > 1.02) discard;
    vec3 col = mix(uRoot, uMid, smoothstep(0.0, 0.8, t));
    float barb = 0.5 + 0.5 * sin(t * 64.0 - e * 9.0);
    col *= 0.84 + 0.16 * barb;
    float rach = (1.0 - smoothstep(0.0, 0.05, abs(vTS.y))) * (1.0 - t * 0.6);
    col += uTip * rach * 0.35;
    vec3 edgeCol = mix(uEdge, uTip, smoothstep(0.45, 1.0, t));
    float eg = smoothstep(0.55, 1.0, e);
    col = mix(col, edgeCol, eg * 0.7);
    col += edgeCol * eg * eg * 0.4 * uGlow;
    col += uTip * smoothstep(0.82, 1.0, t) * 0.35 * uGlow;
    float band = exp(-pow((t - fract(uTime * 0.22 + vPhase)) * 9.0, 2.0));
    col += uEdge * band * 0.3 * uGlow;
    vec3 N = normalize(vN); if (!gl_FrontFacing) N = -N; vec3 V = normalize(vV);
    float dif = max(dot(N, normalize(vec3(-0.43, 0.72, 0.54))), 0.0);
    col *= 0.62 + 0.5 * dif;
    col += uEdge * pow(1.0 - abs(dot(N, V)), 3.0) * 0.2;
    gl_FragColor = vec4(col, 1.0);
  }`;

export const RING_FRAG = COMMON + /* glsl */`
  uniform vec3 uColor; uniform float uPhase; uniform float uIntensity; uniform float uMode;
  void main(){
    float a = atan(vObj.y, vObj.x);
    float v;
    if (uMode < 0.5) {
      v = 0.22 + 0.9 * smoothstep(0.55, 1.0, sin(a * 3.0 + uPhase));
    } else {
      v = step(0.82, fract(a * 72.0 / 6.2831853)) * (0.35 + 0.65 * smoothstep(0.2, 1.0, sin(a - uPhase * 0.6)));
    }
    gl_FragColor = vec4(uColor * v * uIntensity, 1.0);
  }`;

export const PARTICLE_VERT = /* glsl */`
  attribute float aSeed;
  uniform float uTime; uniform float uSize; uniform float uPR;
  varying float vA; varying float vSeed;
  void main(){
    vec3 p = position;
    float sp = 0.1 + aSeed * 0.22;
    p.y = mod(p.y + uTime * sp + 1.9, 4.4) - 1.9;
    p.x += sin(uTime * 0.6 + aSeed * 20.0) * 0.12;
    p.z += cos(uTime * 0.5 + aSeed * 13.0) * 0.12;
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    float tw = 0.4 + 0.6 * (0.5 + 0.5 * sin(uTime * (1.5 + aSeed * 3.0) + aSeed * 40.0));
    float edge = smoothstep(-1.9, -1.3, p.y) * (1.0 - smoothstep(1.9, 2.5, p.y));
    vA = tw * edge; vSeed = aSeed;
    gl_PointSize = uSize * (0.35 + aSeed) * uPR * (8.0 / -mv.z);
  }`;
export const PARTICLE_FRAG = /* glsl */`
  uniform vec3 uA; uniform vec3 uB; uniform float uOpacity;
  varying float vA; varying float vSeed;
  void main(){
    float d = length(gl_PointCoord - 0.5);
    float a = smoothstep(0.5, 0.0, d); a *= a;
    gl_FragColor = vec4(mix(uA, uB, step(0.7, vSeed)), a * vA * uOpacity);
  }`;
