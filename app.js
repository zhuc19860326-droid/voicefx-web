import { VoiceFX, renderEffects, encodeWAV } from "./voicefx.js";
import { DEFAULTS, sanitizeParams } from "./dsp-core.js";

const $ = id => document.getElementById(id);
const presets = [
  { name: "干净原声", note: "保留本来的表达", icon: "∿", params: {} },
  { name: "金属机器人", note: "环形调制 · 冷感机械", icon: "⌘", params: { pitch: -3, voice: 0.2, metal: 0.75, metalFrequency: 82, drive: 0.2, highpass: 160, lowpass: 6800 } },
  { name: "低沉旁白", note: "低音区 · 厚实温暖", icon: "≋", params: { pitch: -5, voice: -0.65, lowpass: 6200, drive: 0.08 } },
  { name: "通讯滤波", note: "窄带声音 · 对讲机", icon: "⌁", params: { highpass: 420, lowpass: 3100, resonance: 1.2, drive: 0.32, crush: 0.18 } },
  { name: "失真异声", note: "粗粝颗粒 · 非人质感", icon: "ϟ", params: { pitch: -7, voice: -0.3, drive: 0.68, metal: 0.32, metalFrequency: 43, crush: 0.35, lowpass: 5300 } },
];
const groups = [
  { title: "音高与表达", icon: "↕", english: "VOICE", controls: [
    { key: "pitch", name: "音高", min: -12, max: 12, step: 0.1, ends: ["低沉 −12", "明亮 +12"], format: v => `${v > 0 ? "+" : ""}${v.toFixed(1)} st` },
    { key: "rate", name: "语速 · 文件模式", min: 0.5, max: 2, step: 0.05, ends: ["慢速", "快速"], format: v => `${v.toFixed(2)} ×` },
    { key: "voice", name: "音色塑形", min: -1, max: 1, step: 0.01, ends: ["厚重", "轻亮"], format: v => `${v > 0 ? "+" : ""}${Math.round(v * 100)}` },
  ] },
  { title: "频谱与滤波", icon: "⌁", english: "FILTER", controls: [
    { key: "highpass", name: "高通 · 去除低频", min: 20, max: 2000, step: 1, log: true, ends: ["20 Hz", "2 kHz"], format: hz },
    { key: "lowpass", name: "低通 · 收拢高频", min: 300, max: 20000, step: 1, log: true, ends: ["300 Hz", "20 kHz"], format: hz },
    { key: "resonance", name: "滤波共振", min: 0.5, max: 5, step: 0.01, ends: ["平滑", "突出"], format: v => `${v.toFixed(2)} Q` },
  ] },
  { title: "失真与金属", icon: "ϟ", english: "TEXTURE", controls: [
    { key: "drive", name: "失真强度", min: 0, max: 1, step: 0.01, ends: ["干净", "饱和"], format: percent },
    { key: "metal", name: "金属质感", min: 0, max: 1, step: 0.01, ends: ["自然", "机械"], format: percent },
    { key: "metalFrequency", name: "金属载波", min: 20, max: 1000, step: 1, log: true, ends: ["低频颤动", "高频金属"], format: hz },
  ] },
  { title: "颗粒与输出", icon: "◌", english: "OUTPUT", controls: [
    { key: "crush", name: "颗粒感", min: 0, max: 1, step: 0.01, ends: ["平滑", "数字颗粒"], format: percent },
    { key: "mix", name: "干湿比例", min: 0, max: 1, step: 0.01, ends: ["原声", "全效果"], format: percent },
    { key: "gain", name: "输出增益", min: -30, max: 6, step: 0.1, ends: ["−30 dB", "+6 dB"], format: v => `${v > 0 ? "+" : ""}${v.toFixed(1)} dB` },
  ] },
];
function hz(v) { return v >= 1000 ? `${(v / 1000).toFixed(2)} kHz` : `${Math.round(v)} Hz`; }
function percent(v) { return `${Math.round(v * 100)} %`; }
const settings = { params: { ...DEFAULTS }, rate: 1, name: "干净原声" };
let saved = [];
try {
  const data = JSON.parse(localStorage.getItem("voicefx-presets") ?? "[]");
  if (Array.isArray(data)) saved = data.slice(0, 12).map((x, i) => ({
    name: `自定义 ${String(i + 1).padStart(2, "0")}`,
    params: sanitizeParams(x.params ?? {}),
    rate: Number.isFinite(x.rate) ? Math.max(0.5, Math.min(2, x.rate)) : 1,
  }));
} catch { /* A corrupt saved preset should not prevent audio playback. */ }
let sourceType = "file", buffer = null, fileName = "", ctx = null, fx = null, analyser = null;
let initPromise = null, source = null, mediaStream = null, pcm = null;
let playing = false, offset = 0, startTime = 0, actualRate = 1, generation = 0;
let streamTimer = null, finishTimer = null, exporting = false;

for (const group of groups) {
  const section = document.createElement("section"); section.className = "control-group";
  const heading = document.createElement("div"); heading.className = "group-title";
  heading.innerHTML = `<span>${group.icon}</span><span>${group.title}</span><small>${group.english}</small>`;
  section.append(heading);
  for (const control of group.controls) {
    const box = document.createElement("div"); box.className = "control";
    box.innerHTML = `<div class="control-top"><label for="param-${control.key}">${control.name}</label><output class="value" id="value-${control.key}" for="param-${control.key}"></output></div>
      <input class="range" id="param-${control.key}" type="range" min="${control.log ? 0 : control.min}" max="${control.log ? 1000 : control.max}" step="${control.log ? 1 : control.step}">
      <div class="ends"><span>${control.ends[0]}</span><span>${control.ends[1]}</span></div>`;
    section.append(box);
    box.querySelector("input").addEventListener("input", event => {
      const raw = Number(event.target.value);
      const value = control.log ? control.min * (control.max / control.min) ** (raw / 1000) : raw;
      if (control.key === "rate") {
        changeRate(value); settings.rate = value;
      } else settings.params[control.key] = value;
      settings.name = "自定义音色"; apply();
    });
  }
  $("controls").append(section);
}
presets.forEach((preset, i) => {
  const button = document.createElement("button"); button.className = `preset${i === 0 ? " selected" : ""}`;
  button.innerHTML = `<span class="preset-icon">${preset.icon}</span><div><strong>${preset.name}</strong><small>${preset.note}</small></div><span>${i === 0 ? "●" : "↗"}</span>`;
  button.addEventListener("click", () => {
    settings.params = { ...DEFAULTS, ...preset.params };
    settings.name = preset.name; changeRate(1); settings.rate = 1;
    apply(); message(`已应用「${preset.name}」，播放中可继续微调。`);
  });
  $("presets").append(button);
});

function renderSaved() {
  $("saved-presets").replaceChildren();
  for (const preset of saved) {
    const button = document.createElement("button"); button.textContent = preset.name;
    button.addEventListener("click", () => {
      settings.params = { ...preset.params };
      settings.name = preset.name; changeRate(preset.rate); settings.rate = preset.rate; apply();
      message(`已载入「${preset.name}」。`);
    });
    $("saved-presets").append(button);
  }
}
function effectiveRate(rate = settings.rate) {
  return sourceType === "file" && !settings.params.bypass ? rate : 1;
}
function position() {
  return sourceType === "file" && playing ? Math.min(buffer?.duration ?? 0, offset + (ctx.currentTime - startTime) * actualRate) : offset;
}
function changeRate(rate) {
  if (sourceType === "file" && playing && source) {
    offset = position(); startTime = ctx.currentTime;
    actualRate = effectiveRate(rate); source.playbackRate.setValueAtTime(actualRate, ctx.currentTime);
  }
}
function apply() {
  for (const group of groups) for (const c of group.controls) {
    const value = c.key === "rate" ? settings.rate : settings.params[c.key];
    const fraction = c.log ? Math.log(value / c.min) / Math.log(c.max / c.min) : (value - c.min) / (c.max - c.min);
    const input = $(`param-${c.key}`);
    input.value = c.log ? Math.round(fraction * 1000) : value;
    input.style.setProperty("--fill", `${Math.min(100, Math.max(0, fraction * 100))}%`);
    input.setAttribute("aria-valuetext", c.format(value));
    $(`value-${c.key}`).value = c.format(value);
  }
  $("param-rate").disabled = sourceType !== "file";
  $("bypass").setAttribute("aria-pressed", String(settings.params.bypass));
  $("active-preset").textContent = settings.params.bypass ? "原声旁路 / A" : settings.name;
  [...$("presets").children].forEach((button, i) => {
    const selected = settings.name === presets[i].name && !settings.params.bypass;
    button.classList.toggle("selected", selected);
    button.lastChild.textContent = selected ? "●" : "↗";
  });
  if (fx) fx.setParams({
    ...settings.params,
    pitch: settings.params.pitch - 12 * Math.log2(effectiveRate()),
  });
  updateTransport();
}
function message(text, error = false) {
  $("message").textContent = text; $("message").classList.toggle("error", error);
}
async function action(fn, button) {
  if (button) button.disabled = true;
  try { await fn(); }
  catch (error) { message(error.message || "操作失败，请重试。", true); }
  finally { if (button) button.disabled = false; updateTransport(); }
}
async function ensureEngine() {
  if (!initPromise) initPromise = (async () => {
    ctx = new AudioContext({ latencyHint: "interactive" });
    fx = await VoiceFX.create(ctx);
    analyser = ctx.createAnalyser(); analyser.fftSize = 2048;
    fx.connect(analyser); analyser.connect(ctx.destination);
    $("latency").textContent = `${Math.round(ctx.sampleRate / 1000)} kHz · 移调延迟 ≈${Math.round(2048 / ctx.sampleRate * 1000)} ms`;
    apply();
  })().catch(async error => {
    await ctx?.close(); ctx = null; fx = null; initPromise = null; throw error;
  });
  await initPromise; await ctx.resume();
}
function stop(reset = true) {
  generation++;
  if (source) {
    source.onended = null;
    try { source.stop?.(); } catch { /* Already ended. */ }
    source.disconnect(); source = null;
  }
  mediaStream?.getTracks().forEach(track => track.stop()); mediaStream = null;
  clearInterval(streamTimer); clearTimeout(finishTimer); streamTimer = finishTimer = null;
  pcm?.cancel(); pcm = null; playing = false;
  if (reset) offset = 0;
  $("status").textContent = offset ? "已暂停" : "待机"; $("status-led").classList.remove("on");
  updateTransport();
}
async function playFile() {
  if (!buffer) return;
  const tokenBeforeInit = generation;
  await ensureEngine();
  if (sourceType !== "file" || tokenBeforeInit !== generation) return;
  if (playing) { offset = position(); stop(false); return; }
  if (offset >= buffer.duration) offset = 0;
  const node = ctx.createBufferSource(); node.buffer = buffer;
  actualRate = effectiveRate(); node.playbackRate.value = actualRate;
  node.connect(fx.input); source = node; startTime = ctx.currentTime; playing = true;
  const token = ++generation;
  node.onended = () => {
    if (token !== generation) return;
    finishTimer = setTimeout(() => {
      stop(); message("试听结束，可以调整参数后再听，或导出效果音频。");
    }, 180);
  };
  node.start(0, offset); apply(); live("正在试听");
}
function live(text) {
  $("status").textContent = text; $("status-led").classList.add("on"); updateTransport();
}
async function startMic() {
  if (playing) { stop(); return; }
  const token = ++generation;
  await ensureEngine();
  if (!navigator.mediaDevices?.getUserMedia) throw new Error("麦克风需要通过 localhost 或 HTTPS 打开");
  let acquired;
  try {
    acquired = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
  } catch (error) {
    if (error.name === "NotAllowedError") throw new Error("麦克风权限未开放，请在浏览器网站设置中允许麦克风。");
    throw error;
  }
  if (token !== generation || sourceType !== "mic") { acquired.getTracks().forEach(track => track.stop()); return; }
  mediaStream = acquired; source = ctx.createMediaStreamSource(acquired); source.connect(fx.input);
  playing = true; startTime = ctx.currentTime; offset = 0; apply(); live("实时监听");
  message("正在监听麦克风。请使用耳机；语速保持 1×，音高及其他效果可实时调整。");
}
function demoBuffer(sampleRate) {
  const seconds = 8, frames = sampleRate * seconds, out = new Float32Array(frames);
  const vowels = [[650, 1100, 2500], [330, 1900, 2600], [370, 720, 2300], [500, 1500, 2600]];
  let phase = 0;
  for (let i = 0; i < frames; i++) {
    const t = i / sampleRate, syllable = Math.floor(t / 0.65);
    const u = (t % 0.65) / 0.65;
    const env = Math.sin(Math.PI * Math.min(1, u / 0.85)) ** 2;
    const f0 = 145 + 20 * Math.sin(t * 2.5) + 2 * Math.sin(t * 31);
    phase += 2 * Math.PI * f0 / sampleRate;
    let x = 0;
    const formants = vowels[syllable % vowels.length];
    for (let h = 1; h <= 28; h++) {
      const f = f0 * h;
      if (f > sampleRate * 0.45) break;
      let amplitude = 0.15 / h;
      for (let k = 0; k < 3; k++) amplitude += Math.exp(-(((f - formants[k]) / (100 + k * 60)) ** 2)) / (k + 2);
      x += Math.sin(phase * h) * amplitude;
    }
    out[i] = x * env * Math.min(1, t / 0.05, (seconds - t) / 0.05) * 0.22;
  }
  return out;
}
async function loadDemo() {
  stop(); const token = generation; await ensureEngine();
  if (sourceType !== "file" || token !== generation) return;
  const samples = demoBuffer(ctx.sampleRate);
  buffer = ctx.createBuffer(1, samples.length, ctx.sampleRate); buffer.copyToChannel(samples, 0);
  fileName = "合成元音 · 功能试听";
  showSource(); message("已载入合成元音。它不是人声 TTS；真人效果请导入你的语音文件。");
}
async function startStream() {
  stop(); const token = generation; await ensureEngine();
  if (sourceType !== "stream" || token !== generation) return;
  playing = true; startTime = ctx.currentTime; offset = 0;
  const samples = demoBuffer(24000);
  pcm = await fx.createPCMStream({
    sampleRate: 24000, format: "s16le", bufferMs: 80,
    onEvent: data => {
      if (token !== generation) return;
      if (data.type === "stats") $("source-detail").textContent = `${Math.round(data.bufferedMs)} ms`;
      if (data.type === "overflow") message(data.message, true);
      if (data.type === "ended") {
        finishTimer = setTimeout(() => {
          stop(); message("24 kHz PCM 分包播放结束，音频流已通过同一条效果链。");
        }, 180);
      }
    },
  });
  if (token !== generation) { pcm?.cancel(); return; }
  $("source-name").textContent = "24 kHz / 16 bit / 单声道 PCM";
  let cursor = 0;
  const send = () => {
    if (token !== generation || !pcm) return;
    const end = Math.min(samples.length, cursor + 960);
    const data = new ArrayBuffer((end - cursor) * 2), view = new DataView(data);
    for (let i = cursor; i < end; i++) view.setInt16((i - cursor) * 2, Math.round(samples[i] * 32767), true);
    pcm.enqueue(data); cursor = end;
    if (cursor === samples.length) { clearInterval(streamTimer); pcm.end(); }
  };
  send(); streamTimer = setInterval(send, 40); apply(); live("音频流试听");
  message("正在模拟 Agent 每 40 ms 发送一个 PCM 音频包。可实时调节效果。");
}
async function loadFile(file) {
  if (!file) return;
  if (file.size > 100 * 1024 * 1024) throw new Error("试听原型支持 100 MB 以内的音频，请截取一段再导入。");
  stop(); const token = generation; await ensureEngine();
  message("正在解码音频…");
  let decoded;
  try { decoded = await ctx.decodeAudioData(await file.arrayBuffer()); }
  catch { throw new Error("无法解码这个文件，请导出为 WAV / MP3 后重试。"); }
  if (token !== generation) return;
  buffer = decoded; fileName = file.name;
  if (sourceType !== "file") selectSource("file");
  showSource(); message(`已载入「${file.name}」。选择预设后开始试听。`);
}
function showSource() {
  $("source-name").textContent = sourceType === "file" ? fileName || "等待声音输入" :
    sourceType === "mic" ? "麦克风 · 请佩戴耳机" : "PCM 测试流 / SDK 接口";
  $("source-detail").textContent = sourceType === "file" && buffer ? `${buffer.duration.toFixed(1)} s` :
    sourceType === "mic" ? "LIVE" : "—";
  updateTransport();
}
function selectSource(type) {
  stop(); sourceType = type;
  for (const key of ["file", "mic", "stream"]) {
    $(`tab-${key}`).setAttribute("aria-selected", String(key === type));
    $(`${key}-source`).hidden = key !== type;
  }
  showSource(); apply();
  message(type === "file" ? "载入音频，可分别调整音高与语速。" :
    type === "mic" ? "开始前请戴耳机，首次使用需授权麦克风。" :
    "用 PCM 测试流验证效果；通过「接入 Agent」查看 SDK 示例。");
}
function time(seconds) {
  if (!Number.isFinite(seconds)) return "00:00";
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
}
function updateTransport() {
  $("play").disabled = sourceType === "file" ? !buffer : sourceType === "stream";
  $("play-icon").textContent = playing ? "Ⅱ" : "▶";
  $("play-label").textContent = sourceType === "mic" ? playing ? "停止监听" : "开始监听" : playing ? "暂停试听" : "开始试听";
  $("stop").disabled = !playing && !offset;
  $("export").disabled = sourceType !== "file" || !buffer || exporting;
  $("demo").disabled = exporting;
  $("stream-demo").disabled = playing;
  $("duration").textContent = sourceType === "file" && buffer ? time(buffer.duration / effectiveRate()) : sourceType === "mic" ? "LIVE" : "00:08";
}

$("play").addEventListener("click", () => action(sourceType === "mic" ? startMic : playFile, $("play")));
$("stop").addEventListener("click", () => { stop(); message("已停止。"); });
$("demo").addEventListener("click", () => action(loadDemo, $("demo")));
$("stream-demo").addEventListener("click", () => action(startStream, $("stream-demo")));
$("audio-file").addEventListener("change", event => { action(() => loadFile(event.target.files[0])); event.target.value = ""; });
for (const type of ["file", "mic", "stream"]) $(`tab-${type}`).addEventListener("click", () => selectSource(type));
for (const type of ["dragenter", "dragover"]) $("dropzone").addEventListener(type, event => {
  event.preventDefault(); $("dropzone").classList.add("drag");
});
for (const type of ["dragleave", "drop"]) $("dropzone").addEventListener(type, event => {
  event.preventDefault(); $("dropzone").classList.remove("drag");
  if (type === "drop") action(() => loadFile(event.dataTransfer.files[0]));
});
$("bypass").addEventListener("click", () => {
  if (playing && sourceType === "file") { offset = position(); startTime = ctx.currentTime; }
  settings.params.bypass = !settings.params.bypass; changeRate(settings.rate); apply();
  message(settings.params.bypass ? "正在听原声：效果和文件语速已旁路，保留输出增益及峰值保护。" : "已回到效果声音。");
});
$("reset").addEventListener("click", () => {
  settings.params = { ...DEFAULTS }; settings.name = "干净原声"; changeRate(1); settings.rate = 1; apply(); message("已恢复初始参数。");
});
$("save-preset").addEventListener("click", () => {
  if (saved.length >= 12) { message("当前最多保存 12 个自定义音色。", true); return; }
  const name = `自定义 ${String(saved.length + 1).padStart(2, "0")}`;
  saved.push({ name, params: { ...settings.params, bypass: false }, rate: settings.rate });
  try { localStorage.setItem("voicefx-presets", JSON.stringify(saved)); }
  catch { saved.pop(); message("浏览器无法保存参数，请允许此站点使用本地存储。", true); return; }
  settings.name = name; renderSaved(); apply(); message(`已保存「${name}」，下次打开仍可使用。`);
});
$("export").addEventListener("click", () => action(async () => {
  if (!buffer || exporting) return;
  exporting = true; updateTransport();
  const sourceBuffer = buffer, parameters = { ...settings.params }, rate = effectiveRate();
  stop(); message("正在离线渲染当前参数…");
  try {
    const rendered = await renderEffects(sourceBuffer, parameters, rate);
    const wav = encodeWAV(rendered);
    if (location.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(location.hostname)) {
      const url = URL.createObjectURL(wav);
      const link = document.createElement("a");
      link.href = url;
      link.download = `VoiceFX-${Date.now()}.wav`;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
      message(`渲染完成：${rendered.duration.toFixed(2)} 秒 / ${rendered.sampleRate} Hz / 16 bit WAV。已发起下载，请查看浏览器下载记录。`);
      return;
    }
    const response = await fetch("/api/export", {
      method: "POST", headers: { "Content-Type": "audio/wav" }, body: wav,
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? "导出保存失败");
    message(`导出完成：${rendered.duration.toFixed(2)} 秒 / ${rendered.sampleRate} Hz / 16 bit WAV。已保存：${result.path}`);
  } finally { exporting = false; }
}, $("export")));
$("sdk-open").addEventListener("click", () => $("sdk-dialog").showModal());
$("sdk-close").addEventListener("click", () => $("sdk-dialog").close());
$("sdk-dialog").addEventListener("click", event => {
  if (event.target === $("sdk-dialog") && (event.offsetX < 0 || event.offsetY < 0 || event.offsetX > $("sdk-dialog").clientWidth || event.offsetY > $("sdk-dialog").clientHeight)) $("sdk-dialog").close();
});
$("copy-sdk").addEventListener("click", () => action(async () => {
  await navigator.clipboard.writeText($("sdk-dialog").querySelector("code").textContent);
  $("copy-sdk").textContent = "已复制"; setTimeout(() => $("copy-sdk").textContent = "复制接入示例", 1800);
}));

const wave = $("wave"), paint = wave.getContext("2d");
let waveform = new Float32Array(2048), lastPaint = 0;
function draw(now) {
  requestAnimationFrame(draw);
  if (now - lastPaint < 40) return;
  lastPaint = now;
  const bounds = wave.getBoundingClientRect(), scale = Math.min(2, devicePixelRatio || 1);
  const w = Math.round(bounds.width * scale), h = Math.round(bounds.height * scale);
  if (wave.width !== w || wave.height !== h) { wave.width = w; wave.height = h; }
  paint.clearRect(0, 0, w, h);
  paint.strokeStyle = "#233023"; paint.lineWidth = scale * 0.5;
  paint.beginPath();
  for (let x = 0; x < w; x += 42 * scale) { paint.moveTo(x, 0); paint.lineTo(x, h); }
  for (let y = h / 2 % (30 * scale); y < h; y += 30 * scale) { paint.moveTo(0, y); paint.lineTo(w, y); }
  paint.stroke();
  if (analyser && playing) analyser.getFloatTimeDomainData(waveform); else waveform.fill(0);
  let sum = 0;
  paint.beginPath(); paint.strokeStyle = playing ? "#dcfa83" : "#526643"; paint.lineWidth = 1.1 * scale;
  for (let i = 0; i < waveform.length; i++) {
    sum += waveform[i] ** 2;
    const x = i / (waveform.length - 1) * w, y = h / 2 - waveform[i] * h * 0.95;
    if (i) paint.lineTo(x, y); else paint.moveTo(x, y);
  }
  paint.stroke();
  const rms = Math.sqrt(sum / waveform.length);
  $("db").textContent = rms > 0.00001 ? `${(20 * Math.log10(rms)).toFixed(1)} dBFS` : "−∞ dBFS";
  $("elapsed").textContent = time(sourceType === "file" ? position() / effectiveRate() : playing ? ctx.currentTime - startTime : 0);
}
window.addEventListener("pagehide", () => { stop(); fx?.dispose(); ctx?.close(); });
renderSaved(); apply(); requestAnimationFrame(draw);
