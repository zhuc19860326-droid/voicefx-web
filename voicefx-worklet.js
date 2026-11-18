import { VoiceDSP } from "./dsp-core.js";

class EffectsProcessor extends AudioWorkletProcessor {
  constructor() {
    super(); this.dsp = new VoiceDSP(sampleRate, 2);
    this.port.onmessage = ({ data }) => {
      if (data.type === "params") {
        try { this.dsp.setParams(data.params); }
        catch (e) { this.port.postMessage({ type: "error", message: e.message }); }
      }
    };
  }
  process(inputs, outputs) { this.dsp.process(inputs[0] ?? [], outputs[0]); return true; }
}
registerProcessor("voicefx-effects", EffectsProcessor);

class PCMProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.ring = new Float32Array(1 << 20);
    this.read = 0; this.write = 0; this.playing = false; this.ended = false;
    this.startFrames = Math.round(sampleRate * (options.processorOptions?.bufferMs ?? 80) / 1000);
    this.underruns = 0; this.ticks = 0; this.finished = false;
    this.port.onmessage = ({ data }) => {
      if (data.type === "pcm") {
        if (data.samples.length + this.write - this.read > this.ring.length) {
          this.port.postMessage({ type: "overflow", message: "音频缓冲已满，请暂停上游发送" });
          return;
        }
        for (const x of data.samples) this.ring[this.write++ % this.ring.length] = x;
      } else if (data.type === "end") this.ended = true;
      else if (data.type === "cancel") { this.read = this.write; this.ended = true; }
    };
  }
  process(_, outputs) {
    const out = outputs[0][0], pending = this.write - this.read;
    if (!this.playing && (pending >= this.startFrames || (this.ended && pending > 0))) this.playing = true;
    for (let i = 0; i < out.length; i++) {
      if (this.playing && this.read < this.write) out[i] = this.ring[this.read++ % this.ring.length];
      else out[i] = 0;
    }
    if (this.playing && this.read === this.write && !this.ended) {
      this.playing = false; this.underruns++;
    }
    if (++this.ticks % 20 === 0) this.port.postMessage({
      type: "stats", bufferedMs: (this.write - this.read) / sampleRate * 1000, underruns: this.underruns,
    });
    if (this.ended && this.read === this.write && !this.finished) {
      this.finished = true; this.port.postMessage({ type: "ended" });
    }
    return true;
  }
}
registerProcessor("voicefx-pcm", PCMProcessor);
