// The water behind everything: a still frame of Submerge's pond (from the old dashboard).
export const water = (() => {
  const cv = document.getElementById('water');
  const gl = cv.getContext('webgl', { alpha: false, antialias: false, depth: false, powerPreference: 'low-power' });
  if (!gl) return { set() {} };
  const VS = 'attribute vec2 p; void main() { gl_Position = vec4(p, 0.0, 1.0); }';
  const FS = `precision highp float;
uniform vec2 res; uniform float time; uniform float light;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 3; i++) { s += a * noise(p); p = p * 2.03 + 17.1; a *= 0.5; } return s; }
float caustic(vec2 p, float t) {
  vec2 q = mod(p * 6.2831, 6.2831) - 250.0; vec2 i = q; float c = 1.0;
  for (int n = 0; n < 3; n++) {
    float tt = t * (1.0 - 3.5 / float(n + 1));
    i = q + vec2(cos(tt - i.x) + sin(tt + i.y), sin(tt - i.y) + cos(tt + i.x));
    c += 1.0 / length(vec2(q.x / (sin(i.x + tt) / 0.005), q.y / (cos(i.y + tt) / 0.005)));
  }
  c /= 3.0; c = 1.17 - pow(c, 1.4);
  return pow(abs(c), 7.0);
}
float body(vec2 p, float t) {
  return fbm(p * 1.5 + vec2(t * 0.014, -t * 0.009)) * 0.62 + fbm(p * 3.1 - vec2(t * 0.011, t * 0.007) + 5.0) * 0.38;
}
void main() {
  vec2 uv = vec2(gl_FragCoord.x / res.x, 1.0 - gl_FragCoord.y / res.y);
  float aspect = res.x / res.y, t = time;
  vec2 p = vec2(uv.x * aspect, uv.y);
  float split = 0.009 * aspect;
  vec3 cl = vec3(body(p + vec2(split, 0.0), t), body(p, t), body(p - vec2(split, 0.0), t));
  float vig = 1.0 - 0.55 * length((uv - vec2(0.5, 0.5)) * vec2(1.0, 1.25));
  vec3 b = smoothstep(0.22, 0.78, cl) * vig;
  // the water is more saturated in some places than others, drifting around slowly
  float field = 0.5 + 0.3 * sin(p.x * 2.3 + t * 0.05 + sin(p.y * 1.9 + t * 0.03) * 1.5) + 0.2 * sin(p.y * 3.1 - t * 0.04);
  // a faint caustic shimmer near the top only
  float top = pow(smoothstep(0.3, 0.0, uv.y), 2.0);
  float c = 0.0;
  if (top > 0.002) c = caustic(vec2(p.x * (0.55 + uv.y * 0.6), p.y * 1.3) * 0.9 + vec2(t * 0.012, 0.0), t * 0.42);
  // sun and shade patches drifting through, like clouds over a pond
  float sun = 0.0, shade = 0.0;
  for (int i = 0; i < 4; i++) {
    float f = float(i), seed = f * 2.399;
    float life = pow(max(0.0, sin(t * (0.021 + f * 0.004) + seed * 3.1)), 3.0);
    vec2 cc = vec2(aspect * (0.5 + 0.45 * sin(t * (0.011 + f * 0.002) + seed * 5.0)), 0.5 + 0.42 * cos(t * (0.009 + f * 0.0017) + seed * 7.0));
    vec2 d = p - cc;
    float r = 0.24 + 0.09 * fract(seed * 1.7);
    float m = exp(-dot(d, d) / (r * r)) * life;
    if (mod(f, 2.0) > 0.5) shade += m; else sun += m * m;
  }
  vec3 col;
  if (light < 0.5) {
    col = mix(vec3(0.014, 0.032, 0.095), vec3(0.05, 0.17, 0.46), b);
    col += vec3(0.01, 0.04, 0.12) * smoothstep(0.6, 0.85, cl.g);
    col += vec3(0.22, 0.6, 1.0) * c * top * 0.12 + vec3(0.1, 0.4, 1.0) * exp(-uv.y * 12.0) * 0.08;
    col = mix(col, vec3(1.0, 0.74, 0.3) * 0.5, sun * 0.16);
    col *= 1.0 - shade * 0.3;
    float lum = dot(col, vec3(0.299, 0.587, 0.114));
    col = max(mix(vec3(lum), col, 1.1 + 0.15 * smoothstep(0.3, 0.85, field)), 0.0);
  } else {
    col = mix(vec3(0.9, 0.94, 0.99), vec3(0.5, 0.68, 0.97), b * 0.85);
    col += vec3(0.5, 0.65, 0.9) * smoothstep(0.62, 0.85, cl.g) * -0.12;
    col += vec3(1.0) * c * top * 0.18;
    col = mix(col, vec3(1.0, 0.86, 0.66), sun * 0.22);
    col *= 1.0 - shade * 0.08;
    float lum = dot(col, vec3(0.299, 0.587, 0.114));
    col = clamp(mix(vec3(lum), col, 1.05 + 0.25 * smoothstep(0.3, 0.85, field)), 0.0, 1.0);
  }
  gl_FragColor = vec4(col, 1.0);
}`;
  const sh = (type, src) => { const o = gl.createShader(type); gl.shaderSource(o, src); gl.compileShader(o); return o; };
  const prog = gl.createProgram();
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS)); gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return { set() {} };
  gl.useProgram(prog);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  const uRes = gl.getUniformLocation(prog, 'res'), uTime = gl.getUniformLocation(prog, 'time'), uLight = gl.getUniformLocation(prog, 'light');
  let lit = 0;
  function draw() {
    const k = 0.25;   // soft water doesn't need full resolution
    const w = Math.max(1, Math.round(innerWidth * k)), h = Math.max(1, Math.round(innerHeight * k));
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; gl.viewport(0, 0, w, h); }
    gl.uniform2f(uRes, w, h);
    gl.uniform1f(uTime, 52.0);   // a moment where the sun and shade patches are both out
    gl.uniform1f(uLight, lit);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
  let pending = 0;
  addEventListener('resize', () => { clearTimeout(pending); pending = setTimeout(draw, 120); });
  document.documentElement.classList.add('pond');
  return { set(dark) { lit = dark ? 0 : 1; draw(); } };
})();
