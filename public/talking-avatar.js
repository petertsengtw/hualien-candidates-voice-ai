// 說話中的頭像：播放角色語音時依音量切換卡通圖「閉嘴／張嘴」。
// 沒有張嘴卡通圖（例如只有照片）時，只用光環與輕微縮放表示正在說話，不在真人照片上做假嘴型。
const TalkingAvatar = (() => {
  let ctx = null;
  const analysers = new WeakMap(); // 同一個 <audio> 只能接上一次，接過就重複使用

  // 在使用者點擊時呼叫：手機瀏覽器只允許在點擊當下啟動音訊處理
  function unlock() {
    try {
      ctx ??= new AudioContext();
      if (ctx.state === 'suspended') ctx.resume();
    } catch {
      // 不支援時只是沒有跟音量走的動畫
    }
  }

  // 讓 <audio> 的聲音經過音量分析器再播出；瀏覽器不允許時回傳 null（照常播放，只是動畫不跟音量）
  async function analyserFor(audioEl) {
    if (analysers.has(audioEl)) return analysers.get(audioEl);
    try {
      ctx ??= new AudioContext();
      // 頁面還沒有使用者互動時 resume() 可能一直不回應，最多等 300 毫秒
      if (ctx.state === 'suspended') await Promise.race([ctx.resume(), new Promise((r) => setTimeout(r, 300))]);
      if (ctx.state !== 'running') return null;
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      ctx.createMediaElementSource(audioEl).connect(analyser);
      analyser.connect(ctx.destination);
      analysers.set(audioEl, analyser);
      return analyser;
    } catch {
      return null;
    }
  }

  function preload(url) {
    if (url) new Image().src = url;
  }

  // 開始動畫，回傳停止函式。wrap 是頭像外框（.avatar），images 含 avatarUrl / cartoonUrl / cartoonTalkUrl
  async function start(audioEl, wrap, images = {}) {
    if (!wrap) return () => {};
    const img = wrap.querySelector('img');
    const idle = images.cartoonUrl || images.avatarUrl;
    const talk = images.cartoonUrl && images.cartoonTalkUrl;
    preload(talk);
    wrap.classList.add('talking');

    const analyser = await analyserFor(audioEl);
    const buf = analyser ? new Uint8Array(analyser.fftSize) : null;
    let open = false;
    let lastSwitch = 0;
    let frame = 0;
    let stopped = false;

    const tick = (now) => {
      if (stopped) return;
      let level;
      if (analyser) {
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

  return { start, unlock };
})();

// 共用的播放器：手機（特別是 iPhone）只允許「點擊過的」<audio> 之後自動播放，
// 所以整頁只用這一個，並在第一次點擊或按鍵時解鎖，連續對談時角色的聲音才能自動播出。
const SharedPlayer = (() => {
  const el = new Audio();
  el.preload = 'auto';
  let unlocked = false;
  // 一段極短的靜音 wav，用來在點擊當下「播一次」以解鎖
  const SILENCE = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=';

  function unlock() {
    TalkingAvatar.unlock();
    if (unlocked) return;
    unlocked = true;
    el.src = SILENCE;
    el.play().then(() => el.pause()).catch(() => { unlocked = false; });
  }
  for (const type of ['pointerdown', 'keydown', 'touchend']) {
    document.addEventListener(type, unlock, { capture: true, passive: true });
  }
  return { el, unlock };
})();
