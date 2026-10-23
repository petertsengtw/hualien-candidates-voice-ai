// 說話中的頭像：播放角色語音時依音量切換卡通圖「閉嘴／張嘴」。
// 沒有張嘴卡通圖（例如只有照片）時，只用光環與輕微縮放表示正在說話，不在真人照片上做假嘴型。
const TalkingAvatar = (() => {
  let ctx = null;
  let output = null; // { input, analyser }：所有語音都接到 input，經過音量分析器再播出

  // 在使用者點擊時呼叫：手機瀏覽器只允許在點擊當下啟動音訊處理
  function unlock() {
    try {
      ctx ??= new AudioContext();
      if (ctx.state !== 'running') ctx.resume().catch(() => {});
    } catch {
      // 不支援 Web Audio 時改用一般播放器，只是動畫不跟音量
    }
  }

  // 可以播放時回傳音訊輸出；瀏覽器還不允許（例如頁面還沒被點過）時回傳 null
  async function getOutput() {
    try {
      ctx ??= new AudioContext();
      // 頁面還沒有使用者互動時 resume() 可能一直不回應，最多等 300 毫秒
      if (ctx.state !== 'running') await Promise.race([ctx.resume(), new Promise((r) => setTimeout(r, 300))]);
      if (ctx.state !== 'running') return null;
      if (!output) {
        const input = ctx.createGain();
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        input.connect(analyser);
        analyser.connect(ctx.destination);
        output = { ctx, input, analyser };
      }
      return output;
    } catch {
      return null;
    }
  }

  // 先把張嘴圖下載並解碼好，說話時切換才不會卡頓
  const preloaded = new Set();
  function preload(url) {
    if (!url || preloaded.has(url)) return;
    preloaded.add(url);
    const img = new Image();
    img.src = url;
    img.decode?.().catch(() => {});
  }

  // 開始動畫，回傳停止函式。wrap 是頭像外框（.avatar），images 含 avatarUrl / cartoonUrl / cartoonTalkUrl，
  // getAnalyser() 回傳目前語音的音量分析器（沒有時用固定節奏）
  function start(wrap, images = {}, getAnalyser = () => null) {
    if (!wrap) return () => {};
    const img = wrap.querySelector('img');
    const idle = images.cartoonUrl || images.avatarUrl;
    const talk = images.cartoonUrl && images.cartoonTalkUrl;
    preload(talk);
    wrap.classList.add('talking');

    let buf = null;
    let open = false;
    let lastSwitch = 0;
    let frame = 0;
    let stopped = false;

    const tick = (now) => {
      if (stopped) return;
      const analyser = getAnalyser();
      let level;
      if (analyser) {
        if (buf?.length !== analyser.fftSize) buf = new Uint8Array(analyser.fftSize);
        analyser.getByteTimeDomainData(buf);
        let sum = 0;
        for (const v of buf) {
          const x = (v - 128) / 128;
          sum += x * x;
        }
        level = Math.sqrt(sum / buf.length);
      } else {
        level = 0.05 + 0.04 * Math.sin(now / 110); // 無法分析音量時，用固定節奏表示正在說話
      }
      wrap.style.setProperty('--level', Math.min(1, level * 6).toFixed(3));
      // 張嘴與閉嘴的門檻不同（遲滯），並限制切換頻率，避免畫面閃爍
      if (talk && img && now - lastSwitch > 90) {
        const next = open ? level > 0.03 : level > 0.06;
        if (next !== open) {
          open = next;
          lastSwitch = now;
          img.src = open ? talk : idle;
        }
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);

    return () => {
      stopped = true;
      cancelAnimationFrame(frame);
      wrap.classList.remove('talking');
      wrap.style.removeProperty('--level');
      if (talk && img) img.src = idle;
    };
  }

  return { start, unlock, getOutput };
})();

// 共用的播放器。優先把每段語音先解碼，再用 Web Audio 播放：聲音在獨立的音訊執行緒處理，
// 畫面忙著下載下一句、跑頭像動畫時也不會破音（iPhone 上用 <audio> 播放會有「啪」聲與破音）。
// 瀏覽器還不允許 Web Audio 時，改用整頁共用的 <audio>：手機只允許「點擊過的」<audio> 之後自動播放，
// 所以在第一次點擊或按鍵時解鎖。
const SharedPlayer = (() => {
  const el = new Audio();
  el.preload = 'auto';
  let unlocked = false;
  let current = null; // 目前正在播放的那一段（Web Audio）
  // 一段極短的靜音 wav，用來在點擊當下「播一次」以解鎖 <audio>
  const SILENCE = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=';
  const FADE_SECONDS = 0.01; // 每段開頭結尾各淡入淡出 10 毫秒，避免「啪」一聲；每句前後都有靜音，不會吃到字

  function unlock() {
    TalkingAvatar.unlock();
    if (unlocked) return;
    unlocked = true;
    // 已經在播放就不必再解鎖；不能換成靜音檔，否則會把正在播的語音切掉
    if (!el.paused) return;
    el.src = SILENCE;
    el.play()
      .then(() => { if (el.src === SILENCE) el.pause(); })
      .catch((err) => { if (err?.name === 'NotAllowedError') unlocked = false; }); // 被換成別的音檔而中斷不算失敗
  }
  for (const type of ['pointerdown', 'keydown', 'touchend']) {
    document.addEventListener(type, unlock, { capture: true, passive: true });
  }

  // 用 Web Audio 播放；無法使用時回傳 null，由呼叫端改用 <audio>
  async function playBuffer(src, finish, isStopped) {
    const out = await TalkingAvatar.getOutput();
    if (!out || isStopped()) return null;
    let buffer;
    try {
      const data = await fetch(src).then((r) => r.arrayBuffer());
      buffer = await out.ctx.decodeAudioData(data);
    } catch {
      return null;
    }
    if (isStopped()) return () => {};
    const node = out.ctx.createBufferSource();
    node.buffer = buffer;
    const gain = out.ctx.createGain();
    const t = out.ctx.currentTime + 0.02;
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(1, t + FADE_SECONDS);
    gain.gain.setValueAtTime(1, t + Math.max(FADE_SECONDS, buffer.duration - FADE_SECONDS));
    gain.gain.linearRampToValueAtTime(0, t + buffer.duration);
    node.connect(gain).connect(out.input);
    node.onended = () => {
      if (current?.node === node) current = null;
      finish('ended');
    };
    node.start(t);
    current = { node, analyser: out.analyser };
    // 停止時也淡出，避免中途停止時「啪」一聲
    return () => {
      const now = out.ctx.currentTime;
      gain.gain.cancelScheduledValues(now);
      gain.gain.setTargetAtTime(0, now, FADE_SECONDS / 3);
      try { node.stop(now + FADE_SECONDS * 3); } catch { /* 已經停了 */ }
      if (current?.node === node) current = null;
    };
  }

  // 播放一段音訊（data URL）。回傳 { done, stop }：done 結果是 'ended'（播完）、'stopped'（被停止）
  // 或 'blocked'（瀏覽器不允許自動播放）
  function play(src) {
    let stopped = false;
    let stopSound = () => {};
    let resolveDone;
    const done = new Promise((r) => { resolveDone = r; });
    const finish = (result) => {
      if (stopped && result === 'ended') result = 'stopped';
      resolveDone(result);
    };
    (async () => {
      const stopBuffer = await playBuffer(src, finish, () => stopped);
      if (stopBuffer) {
        stopSound = stopBuffer;
        if (stopped) stopBuffer(); // 剛開始播的瞬間就被停止
        return;
      }
      if (stopped) return;
      // 改用 <audio> 播放
      el.onended = () => finish('ended');
      el.onpause = () => { if (!el.ended) finish('stopped'); };
      el.src = src;
      stopSound = () => el.pause();
      el.play().catch(() => finish('blocked'));
    })();
    return {
      done,
      stop() {
        if (stopped) return;
        stopped = true;
        stopSound();
        finish('stopped');
      },
    };
  }

  // 目前語音的音量分析器（用 <audio> 播放時沒有）
  const analyser = () => current?.analyser || null;

  return { play, analyser, unlock };
})();
