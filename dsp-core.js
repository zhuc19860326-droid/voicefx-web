export const DEFAULTS = Object.freeze({
  pitch: 0, voice: 0, highpass: 50, lowpass: 18000, resonance: 0.707,
  drive: 0, metal: 0, metalFrequency: 70, crush: 0,
  mix: 1, gain: -6, bypass: false,
});

const ranges = {
  pitch: [-24, 24], voice: [-1, 1], highpass: [20, 2000],
  lowpass: [300, 20000], resonance: [0.5, 5], drive: [0, 1],
  metal: [0, 1], metalFrequency: [20, 1000], crush: [0, 1],
  mix: [0, 1], gain: [-30, 6],
};
const smoothKeys = ["pitch", "drive", "metal", "metalFrequency", "crush", "mix", "gain"];
export function sanitizeParams(input, previous = DEFAULTS) {
  const result = { ...previous };
  for (const [key, limits] of Object.entries(ranges)) {
    if (Object.hasOwn(input, key)) {
      const value = Number(input[key]);
      if (!Number.isFinite(value)) throw new TypeError(`${key} 必须是有限数字`);
      result[key] = Math.min(limits[1], Math.max(limits[0], value));
    }
  }
  if (Object.hasOwn(input, "bypass")) {
    if (typeof input.bypass !== "boolean") throw new TypeError("bypass 必须是布尔值");
    result.bypass = input.bypass;
  }
  return result;
}

class Biquad {
  constructor() { this.z1 = 0; this.z2 = 0; this.b = [1, 0, 0, 0, 0]; }
  configure(type, hz, q, db, sr) {
    const w = 2 * Math.PI * Math.min(hz, sr * 0.45) / sr;
    const c = Math.cos(w), s = Math.sin(w), alpha = s / (2 * q);
    const A = 10 ** (db / 40);
    let b0, b1, b2, a0, a1, a2;
    if (type === "lowpass") {
      b0 = (1 - c) / 2; b1 = 1 - c; b2 = b0;
      a0 = 1 + alpha; a1 = -2 * c; a2 = 1 - alpha;
    } else if (type === "highpass") {
      b0 = (1 + c) / 2; b1 = -(1 + c); b2 = b0;
      a0 = 1 + alpha; a1 = -2 * c; a2 = 1 - alpha;
    } else if (type === "peak") {
      b0 = 1 + alpha * A; b1 = -2 * c; b2 = 1 - alpha * A;
      a0 = 1 + alpha / A; a1 = -2 * c; a2 = 1 - alpha / A;
    } else {
      const t = 2 * Math.sqrt(A) * s / Math.sqrt(2);
      if (type === "lowshelf") {
        b0 = A * ((A + 1) - (A - 1) * c + t);
        b1 = 2 * A * ((A - 1) - (A + 1) * c);
        b2 = A * ((A + 1) - (A - 1) * c - t);
        a0 = (A + 1) + (A - 1) * c + t;
        a1 = -2 * ((A - 1) + (A + 1) * c);
        a2 = (A + 1) + (A - 1) * c - t;
      } else {
        b0 = A * ((A + 1) + (A - 1) * c + t);
        b1 = -2 * A * ((A - 1) + (A + 1) * c);
        b2 = A * ((A + 1) + (A - 1) * c - t);
        a0 = (A + 1) - (A - 1) * c + t;
        a1 = 2 * ((A - 1) - (A + 1) * c);
        a2 = (A + 1) - (A - 1) * c - t;
      }
    }
    this.b = [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0];
  }
  sample(x) {
    const [b0, b1, b2, a1, a2] = this.b;
    const y = b0 * x + this.z1;
    this.z1 = b1 * x - a1 * y + this.z2;
    this.z2 = b2 * x - a2 * y;
    return y;
  }
}

class FFT {
  constructor(size) {
    this.size = size;
    this.reverse = new Uint16Array(size);
    const bits = Math.log2(size);
    for (let i = 0; i < size; i++) {
      let x = i, y = 0;
      for (let j = 0; j < bits; j++) { y = (y << 1) | (x & 1); x >>= 1; }
      this.reverse[i] = y;
    }
  }
  transform(real, imag, inverse = false) {
    const n = this.size;
    for (let i = 0; i < n; i++) {
      const j = this.reverse[i];
      if (j > i) {
        const r = real[i], m = imag[i];
        real[i] = real[j]; imag[i] = imag[j]; real[j] = r; imag[j] = m;
      }
    }
    for (let length = 2; length <= n; length *= 2) {
      const angle = (inverse ? 2 : -2) * Math.PI / length;
      const wr = Math.cos(angle), wi = Math.sin(angle), half = length / 2;
      for (let start = 0; start < n; start += length) {
        let tr = 1, ti = 0;
        for (let j = 0; j < half; j++) {
          const a = start + j, b = a + half;
          const r = real[b] * tr - imag[b] * ti, m = real[b] * ti + imag[b] * tr;
          real[b] = real[a] - r; imag[b] = imag[a] - m;
          real[a] += r; imag[a] += m;
          const next = tr * wr - ti * wi; ti = tr * wi + ti * wr; tr = next;
        }
      }
    }
    if (inverse) for (let i = 0; i < n; i++) { real[i] /= n; imag[i] /= n; }
  }
}

// Streaming phase vocoder, eightfold overlap. Tracks true bin frequency
// before spectral remapping. No formant correction or voice cloning.
class SpectralPitch {
  constructor(sr) {
    this.sr = sr; this.size = 2048; this.hop = 256; this.latency = this.size - this.hop;
    this.rover = this.latency; this.frame = 0; this.dry = 0;
    this.fft = new FFT(this.size);
    this.input = new Float64Array(this.size);
    this.output = new Float64Array(this.hop);
    this.accum = new Float64Array(this.size);
    this.real = new Float64Array(this.size); this.imag = new Float64Array(this.size);
    this.lastPhase = new Float64Array(this.size / 2 + 1);
    this.sumPhase = new Float64Array(this.size / 2 + 1);
    this.mag = new Float64Array(this.size / 2 + 1);
    this.freq = new Float64Array(this.size / 2 + 1);
    this.dryRing = new Float32Array(this.size + 1);
    this.window = Float64Array.from({ length: this.size }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / this.size));
  }
  sample(x, ratio) {
    const dryIndex = this.frame % this.dryRing.length;
    this.dryRing[dryIndex] = x;
    this.dry = this.frame >= this.size ? this.dryRing[(this.frame - this.size) % this.dryRing.length] : 0;
    this.frame++;
    this.input[this.rover] = x;
    const wet = this.output[this.rover - this.latency];
    if (++this.rover === this.size) { this.rover = this.latency; this.processFrame(ratio); }
    return wet;
  }
  processFrame(ratio) {
    const n = this.size, h = this.hop, half = n / 2, binHz = this.sr / n;
    for (let i = 0; i < n; i++) { this.real[i] = this.input[i] * this.window[i]; this.imag[i] = 0; }
    this.fft.transform(this.real, this.imag);
    this.mag.fill(0); this.freq.fill(0);
    for (let k = 0; k <= half; k++) {
      const phase = Math.atan2(this.imag[k], this.real[k]);
      let delta = phase - this.lastPhase[k] - 2 * Math.PI * k * h / n;
      this.lastPhase[k] = phase;
      delta -= 2 * Math.PI * Math.round(delta / (2 * Math.PI));
      const trueHz = k * binHz + delta * this.sr / (2 * Math.PI * h);
      const target = Math.round(k * ratio);
      if (target <= half) {
        const amplitude = Math.hypot(this.real[k], this.imag[k]);
        this.mag[target] += amplitude;
        this.freq[target] += amplitude * trueHz * ratio;
      }
    }
    this.real.fill(0); this.imag.fill(0);
    for (let k = 0; k <= half; k++) {
      const frequency = this.mag[k] > 1e-12 ? this.freq[k] / this.mag[k] : k * binHz;
      this.sumPhase[k] += 2 * Math.PI * frequency * h / this.sr;
      this.sumPhase[k] %= 2 * Math.PI;
      this.real[k] = this.mag[k] * Math.cos(this.sumPhase[k]);
      this.imag[k] = k === 0 || k === half ? 0 : this.mag[k] * Math.sin(this.sumPhase[k]);
      if (k > 0 && k < half) { this.real[n - k] = this.real[k]; this.imag[n - k] = -this.imag[k]; }
    }
    this.fft.transform(this.real, this.imag, true);
    for (let i = 0; i < n; i++) this.accum[i] += this.real[i] * this.window[i] / 3;
    this.output.set(this.accum.subarray(0, h));
    this.accum.copyWithin(0, h); this.accum.fill(0, n - h);
    this.input.copyWithin(0, h);
  }
}

export class VoiceDSP {
  constructor(sampleRate = 48000, channels = 2) {
    this.sampleRate = sampleRate; this.params = { ...DEFAULTS };
    this.smooth = { ...DEFAULTS }; this.phase = 0; this.counter = 0;
    this.state = Array.from({ length: channels }, () => ({
      pitch: new SpectralPitch(sampleRate),
      filters: Array.from({ length: 5 }, () => new Biquad()),
      hold: 0, dcIn: 0, dcOut: 0,
    }));
    this.alpha = 1 - Math.exp(-1 / (sampleRate * 0.015));
    this.filterKey = "";
  }
  setParams(params) { this.params = sanitizeParams(params, this.params); }
  process(inputs, outputs) {
    const p = this.params, sr = this.sampleRate, a = this.alpha;
    const key = `${p.voice},${p.highpass},${p.lowpass},${p.resonance}`;
    if (key !== this.filterKey) {
      for (const state of this.state) {
        state.filters[0].configure("highpass", p.highpass, 0.707, 0, sr);
        state.filters[1].configure("lowshelf", 220, 0.707, -p.voice * 8, sr);
        state.filters[2].configure("peak", 850, 0.9, p.voice * 4, sr);
        state.filters[3].configure("highshelf", 2800, 0.707, p.voice * 8, sr);
        state.filters[4].configure("lowpass", p.lowpass, p.resonance, 0, sr);
      }
      this.filterKey = key;
    }
    const count = outputs[0].length;
    for (let i = 0; i < count; i++) {
      for (const key of smoothKeys) {
        this.smooth[key] += a * (p[key] - this.smooth[key]);
      }
      const s = this.smooth;
      const ratio = 2 ** (s.pitch / 12);
      const carrier = Math.sin(this.phase);
      this.phase = (this.phase + 2 * Math.PI * s.metalFrequency / sr) % (2 * Math.PI);
      const holdEvery = 1 + Math.round(s.crush * 15);
      const steps = 2 ** Math.round(16 - s.crush * 12);
      const gain = 10 ** (s.gain / 20);
      for (let ch = 0; ch < outputs.length; ch++) {
        const state = this.state[ch];
        let x = inputs[ch]?.[i] ?? inputs[0]?.[i] ?? 0;
        if (!Number.isFinite(x)) x = 0;
        let wet = state.pitch.sample(x, ratio);
        const dry = state.pitch.dry;
        for (const f of state.filters) wet = f.sample(wet);
        wet *= (1 - s.metal) + s.metal * carrier;
        const drive = 1 + s.drive * 24;
        const saturated = Math.tanh(wet * drive) / Math.tanh(drive);
        wet = wet * (1 - s.drive) + saturated * s.drive;
        if (this.counter % holdEvery === 0) state.hold = Math.round(wet * steps) / steps;
        wet = wet * (1 - s.crush) + state.hold * s.crush;
        const dc = wet - state.dcIn + 0.995 * state.dcOut;
        state.dcIn = wet; state.dcOut = dc; wet = dc;
        let y = (p.bypass ? dry : dry * (1 - s.mix) + wet * s.mix) * gain;
        // Smooth peak ceiling at 0.99, with unity slope at the knee.
        if (Math.abs(y) > 0.9) y = Math.sign(y) * (0.9 + 0.09 * Math.tanh((Math.abs(y) - 0.9) / 0.09));
        outputs[ch][i] = Number.isFinite(y) ? y : 0;
      }
      this.counter++;
    }
  }
}

// Stateful resampling keeps interpolation phase across packet boundaries.
export class StreamingResampler {
  constructor(inputRate, outputRate) {
    if (!(inputRate >= 8000 && inputRate <= 192000)) throw new RangeError("输入采样率不支持");
    this.step = inputRate / outputRate; this.last = null; this.position = 0;
  }
  convert(chunk) {
    if (!chunk.length) return new Float32Array();
    const merged = new Float32Array(chunk.length + (this.last === null ? 0 : 1));
    if (this.last !== null) { merged[0] = this.last; merged.set(chunk, 1); }
    else merged.set(chunk);
    const n = Math.max(0, Math.ceil((merged.length - 1 - this.position) / this.step));
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const pos = this.position, lo = Math.floor(pos), f = pos - lo;
      out[i] = merged[lo] * (1 - f) + merged[lo + 1] * f;
      this.position += this.step;
    }
    this.position -= merged.length - 1;
    this.last = merged[merged.length - 1];
    return out;
  }
  flush() {
    if (this.last === null) return new Float32Array();
    const result = this.convert(new Float32Array([this.last]));
    this.last = null; this.position = 0;
    return result;
  }
}
