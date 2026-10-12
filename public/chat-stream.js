// 串流回答：Claude 邊寫，網頁邊顯示；寫完一句就交給語音合成，不必等整段回答寫完才開始唸。

// 讀取 /api/chat-stream 的串流（每行一個 JSON）。每段新文字呼叫 onText，最後回傳完整回答與來源。
async function streamChat(body, onText, signal) {
  const res = await fetch('/api/chat-stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || res.statusText);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let result = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const event = JSON.parse(line);
      if (event.type === 'text') onText(event.text);
      else if (event.type === 'done') result = event;
      else if (event.type === 'error') throw new Error(event.error);
    }
  }
  if (!result) throw new Error('回答中斷，請再問一次');
  return result;
}

// 把串流進來的文字切成句子，湊成適合合成的段落：第一段至少 12 字（盡快開口），之後每段至少 40 字。
// makeLoader(text) 回傳「合成這段語音」的函式；每段一切出來就立刻開始合成。
// get(i) 等到第 i 段可用時回傳它；串流結束（end）後沒有更多段落時回傳 null。
function createSpeechQueue(makeLoader) {
  const loaders = [];
  const waiting = [];
  let done = false;
  let tail = ''; // 還沒遇到句尾的文字
  let pending = ''; // 已成句、但還沒湊滿一段的文字

  const wake = () => waiting.splice(0).forEach((check) => check());
  const push = (text) => {
    const loader = makeLoader(text);
    loader().catch(() => {}); // 失敗時播放端會再試一次並顯示錯誤
    loaders.push(loader);
    wake();
  };
  const addSentence = (sentence) => {
    pending += sentence;
    if (pending.length >= (loaders.length ? 40 : 12)) {
      push(pending);
      pending = '';
    }
  };

  return {
    feed(delta) {
      if (done) return;
      tail += delta;
      let match;
      while ((match = /[。！？!?；;\n]/.exec(tail))) {
        const sentence = tail.slice(0, match.index + 1).trim();
        tail = tail.slice(match.index + 1);
        if (sentence) addSentence(sentence);
      }
    },
    end() {
      if (done) return;
      const rest = (pending + tail).trim();
      pending = '';
      tail = '';
      if (rest) push(rest);
      done = true;
      wake();
    },
    get(i) {
      return new Promise((resolve) => {
        const check = () => {
          if (i < loaders.length) resolve(loaders[i]);
          else if (done) resolve(null);
          else waiting.push(check);
        };
        check();
      });
    },
    all() {
      return loaders.slice();
    },
  };
}
