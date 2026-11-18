import { DEFAULTS, sanitizeParams, StreamingResampler } from "./dsp-core.js";
const modules = new WeakMap();

export class VoiceFX {
  static async create(context, params = {}) {
    if (!context.audioWorklet) throw new Error("请通过 localhost 或受信任的 HTTPS 在 Chrome / Edge / Safari 中打开");
    if (!modules.has(context)) modules.set(context,
      context.audioWorklet.addModule(new URL("./voicefx-worklet.js", import.meta.url)));
    try { await modules.get(context); }
    catch (error) { modules.delete(context); throw error; }
    return new VoiceFX(context, params);
  }
  constructor(context, params) {
    this.context = context;
    this.input = new AudioWorkletNode(context, "voicefx-effects", {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
    });
    this.output = this.input;
    this.params = { ...DEFAULTS };
    this.setParams(params);
  }
  setParams(params) {
    this.params = sanitizeParams(params, this.params);
    this.input.port.postMessage({ type: "params", params: this.params });
  }
  connect(destination) { this.output.connect(destination); return destination; }
  disconnect() { this.output.disconnect(); }
  dispose() { this.disconnect(); this.input.port.close(); }

  async createPCMStream({ sampleRate = 24000, format = "s16le", bufferMs = 80, onEvent = () => {} } = {}) {
    if (!["s16le", "f32"].includes(format)) throw new Error("支持 s16le 或 f32 单声道 PCM");
    if (!(bufferMs >= 20 && bufferMs <= 1000)) throw new RangeError("bufferMs 需在 20–1000 之间");
    const resampler = new StreamingResampler(sampleRate, this.context.sampleRate);
    const node = new AudioWorkletNode(this.context, "voicefx-pcm", {
      numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1],
      processorOptions: { bufferMs },
    });
    node.connect(this.input);
    let closed = false;
    const stats = { bufferedMs: 0, underruns: 0 };
    node.port.onmessage = ({ data }) => {
      if (data.type === "stats") Object.assign(stats, data);
      onEvent(data);
    };
    const send = (samples) => {
      if (samples.length) node.port.postMessage({ type: "pcm", samples }, [samples.buffer]);
    };
    return {
      stats,
      enqueue: (chunk) => {
        if (closed) throw new Error("音频流已结束");
        let samples;
        if (format === "s16le") {
          const bytes = chunk instanceof ArrayBuffer ? new Uint8Array(chunk) :
            new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
          if (bytes.byteLength % 2) throw new Error("s16le 音频包长度必须是偶数");
          const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
          samples = Float32Array.from({ length: bytes.byteLength / 2 }, (_, i) => view.getInt16(i * 2, true) / 32768);
        } else {
          if (!(chunk instanceof Float32Array)) throw new TypeError("f32 输入需要 Float32Array");
          samples = chunk;
        }
        if (samples.some(x => !Number.isFinite(x))) throw new TypeError("PCM 含非有限数值");
        send(resampler.convert(samples));
      },
      end: () => {
        if (closed) return;
        send(resampler.flush()); closed = true; node.port.postMessage({ type: "end" });
      },
      cancel: () => {
        closed = true; node.port.postMessage({ type: "cancel" });
        node.disconnect(); node.port.close();
      },
      dispose: () => { closed = true; node.disconnect(); node.port.close(); },
    };
  }
}

export async function renderEffects(buffer, params, rate = 1) {
  if (!(rate >= 0.5 && rate <= 2)) throw new RangeError("播放速度需在 0.5–2 之间");
  const sr = buffer.sampleRate;
  const offline = new OfflineAudioContext(2, Math.ceil(buffer.length / rate + sr * 0.3), sr);
  const fx = await VoiceFX.create(offline, { ...params, pitch: params.pitch - 12 * Math.log2(rate) });
  const source = offline.createBufferSource();
  source.buffer = buffer; source.playbackRate.value = rate;
  source.connect(fx.input); fx.connect(offline.destination); source.start();
  try { return await offline.startRendering(); }
  finally { fx.dispose(); }
}

export function encodeWAV(buffer) {
  const channels = buffer.numberOfChannels, frames = buffer.length;
  const bytes = new ArrayBuffer(44 + frames * channels * 2);
  const view = new DataView(bytes);
  const text = (pos, str) => [...str].forEach((c, i) => view.setUint8(pos + i, c.charCodeAt(0)));
  text(0, "RIFF"); view.setUint32(4, bytes.byteLength - 8, true); text(8, "WAVE");
  text(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, channels, true); view.setUint32(24, buffer.sampleRate, true);
  view.setUint32(28, buffer.sampleRate * channels * 2, true); view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true); text(36, "data"); view.setUint32(40, bytes.byteLength - 44, true);
  const data = Array.from({ length: channels }, (_, c) => buffer.getChannelData(c));
  for (let i = 0; i < frames; i++) for (let c = 0; c < channels; c++) {
    const x = Math.max(-1, Math.min(1, data[c][i]));
    view.setInt16(44 + (i * channels + c) * 2, Math.round(x * (x < 0 ? 32768 : 32767)), true);
  }
  return new Blob([bytes], { type: "audio/wav" });
}
