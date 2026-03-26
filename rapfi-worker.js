'use strict';

// ══════════════════════════════════════════════════════════════
// rapfi-worker.js — v2 完全修復版
//
// 核心修復：
// 1. 原版呼叫不存在的 _rapfiInit / _rapfiBestMove C API → 改用 Gomocup 協定
// 2. onRuntimeInitialized 觸發後引擎可能還在載入 .data → 加入 ready 偵測
// 3. stdin 用 polling loop 讓引擎真正能讀到輸入
// 4. 完整的 START → OK 握手流程
// ══════════════════════════════════════════════════════════════

var engineReady = false;
var pendingMsg  = null;
var currentRule = 0;
var wasmDone    = false;  // onRuntimeInitialized 已觸發

function send(obj) { postMessage(obj); }

// ── stdin/stdout 緩衝 ─────────────────────────────────────────
var stdinQueue = [];
var stdoutBuf  = '';

// 等候引擎輸出一行的 Promise
var lineResolve = null;
var lineTimeout = null;

function writeLine(cmd) {
  var s = cmd + '\n';
  for (var i = 0; i < s.length; i++) stdinQueue.push(s.charCodeAt(i));
}

function waitLine(ms) {
  return new Promise(function(resolve, reject) {
    lineResolve = function(line) {
      clearTimeout(lineTimeout);
      lineResolve = null;
      resolve(line);
    };
    lineTimeout = setTimeout(function() {
      lineResolve = null;
      reject(new Error('timeout'));
    }, ms);
  });
}

function onStdoutLine(line) {
  line = line.trim();
  if (!line) return;
  // MESSAGE/DEBUG 直接轉發，不影響等候
  if (/^(MESSAGE|DEBUG|INFO\s|WARN)/.test(line)) {
    send({ type: 'debug', text: line }); return;
  }
  if (lineResolve) { lineResolve(line); return; }
  send({ type: 'debug', text: '[出] ' + line });
}

function delay(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

// ── Emscripten Module 定義 ────────────────────────────────────
send({ type: 'status', text: '載入 WASM 引擎...' });

self.Module = {
  // 讓 Emscripten 從同目錄找 .wasm / .data
  locateFile: function(path) {
    return './' + path;
  },

  // stdin：非阻塞輪詢
  stdin: function() {
    return stdinQueue.length > 0 ? stdinQueue.shift() : null;
  },

  // stdout：逐字元收集，遇換行送出一行
  stdout: function(code) {
    if (code === 10) {
      onStdoutLine(stdoutBuf);
      stdoutBuf = '';
    } else if (code !== null && code !== undefined && code > 0) {
      stdoutBuf += String.fromCharCode(code);
    }
  },

  // stderr 轉發（Rapfi 的 debug log）
  stderr: function(code) {
    if (code === 10) {
      if (stdoutBuf) send({ type: 'debug', text: '[stderr] ' + stdoutBuf });
      stdoutBuf = '';
    } else if (code !== null && code !== undefined && code > 0) {
      stdoutBuf += String.fromCharCode(code);
    }
  },

  print: function(text) {
    // Emscripten 有時走 print 而非 stdout
    var lines = text.split('\n');
    for (var i = 0; i < lines.length; i++) onStdoutLine(lines[i]);
  },

  printErr: function(text) {
    send({ type: 'debug', text: '[err] ' + text });
  },

  onRuntimeInitialized: function() {
    wasmDone = true;
    send({ type: 'status', text: 'WASM 就緒，握手中...' });
    // 給引擎 100ms 穩定後再送命令
    setTimeout(doHandshake, 100);
  },

  // 不要 Emscripten 自動執行 main()
  noInitialRun: false
};

// ── START 握手 ────────────────────────────────────────────────
async function doHandshake() {
  try {
    // 有些 Rapfi build 啟動後先印版本資訊，先清一下
    await delay(200);

    // 送 START 15
    writeLine('START 15');

    // 等候 OK（最多 10 秒，NNUE 載入需要時間）
    send({ type: 'status', text: '等候引擎回應 OK...' });
    var resp = await waitLine(15000);

    // 可能夾雜版本訊息，過濾到得到 OK
    var tries = 0;
    while (!resp.startsWith('OK') && !resp.startsWith('ERROR') && tries < 10) {
      send({ type: 'debug', text: '[握手等] ' + resp });
      resp = await waitLine(5000);
      tries++;
    }

    if (resp.startsWith('ERROR') || !resp.startsWith('OK')) {
      throw new Error('START 未收到 OK，最後回應：' + resp);
    }

    // 設定規則
    writeLine('INFO rule ' + currentRule);
    await delay(50);

    engineReady = true;
    send({ type: 'status', text: 'Rapfi NNUE 引擎就緒 ✓' });
    send({ type: 'ready' });

    if (pendingMsg) { handleInit(pendingMsg); pendingMsg = null; }

  } catch (e) {
    send({ type: 'error', text: '引擎握手失敗: ' + e.message + '\n請確認 .data/.wasm 檔案已上傳到伺服器同目錄' });
  }
}

// ── 請引擎思考 ───────────────────────────────────────────────
async function doAIMove(moves, boardSize, timeMs) {
  if (!engineReady) throw new Error('引擎尚未就緒');
  timeMs = timeMs || 3000;

  // 完整棋盤同步（BOARD...DONE 比 TURN 更可靠）
  writeLine('BOARD');
  for (var i = 0; i < moves.length; i++) {
    writeLine(moves[i].c + ',' + moves[i].r + ',' + moves[i].p);
  }
  writeLine('DONE');

  writeLine('INFO time_left ' + timeMs);
  writeLine('INFO time_increment 0');

  if (moves.length === 0) {
    writeLine('BEGIN');
  } else {
    var last = moves[moves.length - 1];
    writeLine('TURN ' + last.c + ',' + last.r);
  }

  // 等引擎回應 x,y
  var answer = await waitLine(timeMs + 8000);

  // 跳過 MESSAGE/DEBUG 行
  var safe = 0;
  while ((/^(MESSAGE|DEBUG|INFO|WARN)/.test(answer)) && safe < 20) {
    answer = await waitLine(5000);
    safe++;
  }

  var parts = answer.split(/[,\s]+/);
  var c = parseInt(parts[0]), r = parseInt(parts[1]);
  if (isNaN(c) || isNaN(r)) throw new Error('無效落子: ' + answer);
  return { c: c, r: r };
}

function handleInit(data) {
  var rule = data.rule !== undefined ? parseInt(data.rule) : 0;
  if (rule !== currentRule) {
    currentRule = rule;
    if (engineReady) writeLine('INFO rule ' + currentRule);
  }
}

// ── 載入引擎 JS（自動嘗試多版本）────────────────────────────
var loaded = false;
var candidates = [
  'rapfi-multi-simd128-relaxed.js',
  'rapfi-multi-simd128.js',
  'rapfi-multi.js',
  'rapfi-single-simd128.js',
  'rapfi-single.js'
];
for (var _i = 0; _i < candidates.length; _i++) {
  try {
    importScripts('./' + candidates[_i]);
    send({ type: 'debug', text: '已載入: ' + candidates[_i] });
    loaded = true;
    break;
  } catch (e) { /* 繼續嘗試 */ }
}
if (!loaded) {
  send({ type: 'error', text: '找不到引擎 JS 檔，請確認伺服器上有 rapfi-*.js' });
}

// ── 訊息處理 ─────────────────────────────────────────────────
self.onmessage = function(e) {
  var d = e.data;
  switch (d.type) {
    case 'init':
      if (!engineReady) pendingMsg = d; else handleInit(d);
      break;
    case 'move':
      if (!engineReady) { send({ type: 'error', text: '引擎尚未就緒' }); return; }
      doAIMove(d.board || [], d.boardSize || 15, d.timeLimit || 3000)
        .then(function(mv) { send({ type: 'move', move: mv, score: 0 }); })
        .catch(function(err) { send({ type: 'error', text: 'AI 失敗: ' + err.message }); });
      break;
    case 'hint':
      if (!engineReady) { send({ type: 'error', text: '引擎尚未就緒' }); return; }
      doAIMove(d.board || [], d.boardSize || 15, d.timeLimit || 3000)
        .then(function(mv) { send({ type: 'hint', move: mv, score: 0 }); })
        .catch(function(err) { send({ type: 'error', text: '提示失敗: ' + err.message }); });
      break;
    default:
      send({ type: 'debug', text: '未知訊息: ' + d.type });
  }
};

self.onerror = function(msg, src, line) {
  send({ type: 'error', text: 'Worker 錯誤: ' + msg });
};
