// Page de la mini-app « Appeler Koto », ouverte dans Telegram. Tout est dans ce fichier : pas de
// dépendance à servir. Le micro est découpé en phrases (détection de voix simple), chaque phrase part
// en WAV 16 kHz, et la réponse de Koto est jouée avant de réécouter (à l'alternat : pas d'écho).
// Le script de page n'utilise ni accent grave ni ${} : il vit dans un gabarit TypeScript.

export const CALL_PAGE_HTML = `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Appel Koto</title>
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<style>
  :root {
    --bg: var(--tg-theme-bg-color, #ffffff);
    --text: var(--tg-theme-text-color, #111111);
    --hint: var(--tg-theme-hint-color, #8a8a8a);
    --accent: var(--tg-theme-button-color, #2481cc);
    --accent-text: var(--tg-theme-button-text-color, #ffffff);
    --bubble: var(--tg-theme-secondary-bg-color, #f0f2f5);
    --danger: #e5484d;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 16px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  main { min-height: 100vh; display: flex; flex-direction: column; align-items: center; padding: 24px 16px calc(24px + env(safe-area-inset-bottom)); gap: 12px; }
  .avatar { width: 96px; height: 96px; border-radius: 50%; background: var(--accent); color: var(--accent-text); display: grid; place-items: center; font-size: 40px; font-weight: 700; transition: transform .2s; }
  .avatar.live { animation: pulse 1.4s ease-in-out infinite; }
  @keyframes pulse { 50% { transform: scale(1.08); } }
  h1 { margin: 4px 0 0; font-size: 22px; }
  #status { margin: 0; color: var(--hint); min-height: 1.4em; text-align: center; }
  #log { width: 100%; max-width: 520px; flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; padding: 8px 0; }
  .me, .koto { margin: 0; padding: 8px 12px; border-radius: 14px; max-width: 85%; white-space: pre-wrap; }
  .me { align-self: flex-end; background: var(--accent); color: var(--accent-text); }
  .koto { align-self: flex-start; background: var(--bubble); }
  .actions { display: flex; gap: 12px; }
  button { border: 0; border-radius: 999px; padding: 14px 28px; font-size: 17px; font-weight: 600; cursor: pointer; }
  #call { background: var(--accent); color: var(--accent-text); }
  #hangup { background: var(--danger); color: #fff; }
  [hidden] { display: none !important; }
</style>
</head>
<body>
<main>
  <div id="avatar" class="avatar">K</div>
  <h1>Koto</h1>
  <p id="status">Touche « Appeler », puis parle normalement.</p>
  <div id="log" aria-live="polite"></div>
  <div class="actions">
    <button id="call" type="button">📞 Appeler</button>
    <button id="hangup" type="button" hidden>Raccrocher</button>
  </div>
</main>
<script>
(function () {
  var tg = window.Telegram && window.Telegram.WebApp;
  if (tg) { tg.ready(); tg.expand(); }
  var initData = (tg && tg.initData) || '';
  var el = function (id) { return document.getElementById(id); };

  var RATE = 16000;
  var MIN_SPEECH_MS = 350;
  var END_SILENCE_MS = 900;
  var MAX_SPEECH_MS = 30000;

  var ctx = null, stream = null, source = null, processor = null;
  var state = 'idle';
  var noise = 0.01, voiced = 0, silence = 0, speechMs = 0;
  var chunks = [], preroll = [];
  var turns = 0, startedAt = 0;

  function setStatus(text) { el('status').textContent = text; }
  function addLine(who, text) {
    var p = document.createElement('p');
    p.className = who;
    p.textContent = text;
    el('log').appendChild(p);
    el('log').scrollTop = el('log').scrollHeight;
  }

  function concat(parts) {
    var length = 0, i;
    for (i = 0; i < parts.length; i++) length += parts[i].length;
    var out = new Float32Array(length), offset = 0;
    for (i = 0; i < parts.length; i++) { out.set(parts[i], offset); offset += parts[i].length; }
    return out;
  }

  function downsample(data, from, to) {
    if (from === to) return data;
    var ratio = from / to, length = Math.floor(data.length / ratio), out = new Float32Array(length);
    for (var i = 0; i < length; i++) {
      var start = Math.floor(i * ratio), end = Math.min(data.length, Math.floor((i + 1) * ratio)), sum = 0;
      for (var j = start; j < end; j++) sum += data[j];
      out[i] = sum / Math.max(1, end - start);
    }
    return out;
  }

  function encodeWav(samples, rate) {
    var buffer = new ArrayBuffer(44 + samples.length * 2), view = new DataView(buffer);
    var text = function (offset, s) { for (var i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i)); };
    text(0, 'RIFF'); view.setUint32(4, 36 + samples.length * 2, true); text(8, 'WAVE');
    text(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    text(36, 'data'); view.setUint32(40, samples.length * 2, true);
    for (var i = 0; i < samples.length; i++) {
      var s = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    return new Blob([buffer], { type: 'audio/wav' });
  }

  function listen() {
    if (state === 'ended') return;
    state = 'listening'; voiced = 0; silence = 0; speechMs = 0; chunks = []; preroll = [];
    setStatus('À l’écoute…');
  }

  function onAudio(event) {
    if (state !== 'listening' && state !== 'speaking') return;
    var input = event.inputBuffer.getChannelData(0), sum = 0;
    for (var i = 0; i < input.length; i++) sum += input[i] * input[i];
    var rms = Math.sqrt(sum / input.length);
    var frameMs = input.length / ctx.sampleRate * 1000;
    var frame = new Float32Array(input);
    var threshold = Math.max(0.012, noise * 3);
    if (state === 'listening') {
      preroll.push(frame);
      if (preroll.length > 3) preroll.shift();
      if (rms > threshold) {
        voiced++;
        if (voiced >= 2) { state = 'speaking'; chunks = preroll; preroll = []; silence = 0; speechMs = 0; setStatus('Je t’écoute…'); }
      } else {
        voiced = 0;
        noise = noise * 0.95 + rms * 0.05;
      }
      return;
    }
    chunks.push(frame);
    speechMs += frameMs;
    silence = rms > threshold ? 0 : silence + frameMs;
    if (silence >= END_SILENCE_MS || speechMs >= MAX_SPEECH_MS) send();
  }

  function play(base64) {
    state = 'playing';
    setStatus('Koto parle…');
    var bytes = Uint8Array.from(atob(base64), function (c) { return c.charCodeAt(0); });
    return ctx.decodeAudioData(bytes.buffer).then(function (buffer) {
      return new Promise(function (resolve) {
        var src = ctx.createBufferSource();
        src.buffer = buffer;
        src.connect(ctx.destination);
        src.onended = resolve;
        src.start();
      });
    });
  }

  function send() {
    if (speechMs < MIN_SPEECH_MS) { listen(); return; }
    state = 'thinking';
    setStatus('Koto réfléchit…');
    var wav = encodeWav(downsample(concat(chunks), ctx.sampleRate, RATE), RATE);
    chunks = [];
    fetch('/appel/tour', { method: 'POST', headers: { 'Authorization': 'tma ' + initData, 'Content-Type': 'audio/wav' }, body: wav })
      .then(function (res) { return res.json().then(function (data) { return { ok: res.ok, status: res.status, data: data }; }); })
      .then(function (answer) {
        var data = answer.data || {};
        if (!answer.ok) {
          setStatus(data.erreur || 'Petit souci de connexion.');
          if (answer.status === 401 || answer.status === 402 || answer.status === 403) { hangup(); return; }
          setTimeout(listen, 1500);
          return;
        }
        if (!data.transcript) { listen(); return; }
        turns++;
        addLine('me', data.transcript);
        if (data.reply) addLine('koto', data.reply);
        var spoken = data.audio ? play(data.audio) : Promise.resolve();
        return spoken.catch(function () { setStatus('Je n’arrive pas à lire le son : lis ma réponse.'); })
          .then(function () { setTimeout(listen, 250); });
      })
      .catch(function () { setStatus('Connexion perdue, je réessaie…'); setTimeout(listen, 1500); });
  }

  function start() {
    if (!initData) { setStatus('Ouvre cette page depuis Telegram : commande /appel.'); return; }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { setStatus('Micro indisponible ici : envoie-moi plutôt un message vocal dans Telegram.'); return; }
    el('call').disabled = true;
    navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
      .then(function (media) {
        stream = media;
        ctx = new (window.AudioContext || window.webkitAudioContext)();
        return ctx.resume().then(function () {
          source = ctx.createMediaStreamSource(stream);
          processor = ctx.createScriptProcessor(4096, 1, 1);
          processor.onaudioprocess = onAudio;
          source.connect(processor);
          processor.connect(ctx.destination);
          startedAt = Date.now();
          el('call').hidden = true;
          el('hangup').hidden = false;
          el('avatar').classList.add('live');
          if (tg && tg.HapticFeedback) tg.HapticFeedback.impactOccurred('medium');
          state = 'starting';
          listen();
        });
      })
      .catch(function () {
        el('call').disabled = false;
        setStatus('Je n’ai pas accès au micro. Autorise-le, ou envoie-moi un message vocal dans Telegram.');
      });
  }

  function hangup() {
    if (state === 'ended' || state === 'idle') return;
    var seconds = Math.round((Date.now() - startedAt) / 1000);
    state = 'ended';
    try {
      if (processor) processor.disconnect();
      if (source) source.disconnect();
      if (stream) stream.getTracks().forEach(function (t) { t.stop(); });
      if (ctx) ctx.close();
    } catch (e) {}
    el('avatar').classList.remove('live');
    el('hangup').hidden = true;
    el('call').hidden = false;
    el('call').disabled = false;
    setStatus('Appel terminé.');
    if (turns > 0) {
      var body = JSON.stringify({ initData: initData, tours: turns, secondes: seconds });
      if (!(navigator.sendBeacon && navigator.sendBeacon('/appel/fin', new Blob([body], { type: 'application/json' })))) {
        fetch('/appel/fin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body, keepalive: true });
      }
    }
    turns = 0;
  }

  el('call').addEventListener('click', start);
  el('hangup').addEventListener('click', hangup);
  window.addEventListener('pagehide', hangup);
})();
</script>
</body>
</html>
`;
