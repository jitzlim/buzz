uniform sampler2D tDiffuse;
uniform vec2 uResolution;
uniform float uCellSize;
uniform float uAudioMod;
uniform sampler2D uCharAtlas;

varying vec2 vUv;

float luminance(vec3 col) {
  return dot(col, vec3(0.299, 0.587, 0.114));
}

void main() {
  vec2 cellCount = uResolution / uCellSize;
  vec2 cellIdx   = floor(vUv * cellCount);
  vec2 cellUv    = fract(vUv * cellCount);

  vec2 sampleUv  = (cellIdx + 0.5) / cellCount;
  vec3 sceneCol  = texture2D(tDiffuse, sampleUv).rgb;
  float lum      = luminance(sceneCol);

  float boostedLum = clamp(lum + uAudioMod * 0.35, 0.0, 1.0);

  float numChars = 5.0;
  float charIdx  = clamp(floor(boostedLum * numChars), 0.0, numChars - 1.0);

  float atlasU = (charIdx * 8.0 + cellUv.x * 8.0) / 40.0;
  float atlasV = 1.0 - cellUv.y;

  float glyphAlpha = texture2D(uCharAtlas, vec2(atlasU, atlasV)).r;

  vec3 inkColor = vec3(0.102, 0.102, 0.102);
  vec3 bgColor  = vec3(0.820, 0.820, 0.820);

  gl_FragColor = vec4(mix(bgColor, inkColor, glyphAlpha), 1.0);
}
