'use strict';

// ── 狀態變數 ──────────────────────────────────────────────────
var Module       = null;
var engineReady  = false;
var pendingMsg   = null;   // init 訊息在引擎就緒前暫存
var currentRule  = 0;      // 0=Standard, 1=Renju, 4=Freestyle

// ── 傳送輔助 ─────────────────────────────────────────────────
function send(obj) { postMessage(obj); }

// ── 載入 Emscripten 模組 ──────────────────────────────────────
send({ type: 'status', text: '初始化引擎...' });

// Emscripten 在 importScripts 前需要先定義 Module
self.Module = {
  // 告訴 Emscripten .data/.wasm 與 worker 同目錄
  locateFile: function(path) {
    return './' + path;
  },

  // 引擎 wasm 初始化完成時觸發
  onRuntimeInitialized: function() {
    engineReady = true;
    send({ type: 'status', text: 'Rapfi NNUE 載入完成' });
    send({ type: 'ready' });

    // 若 init 訊息在引擎就緒前已到達，補處理
    if (pendingMsg) {
      handleInit(pendingMsg);
      pendingMsg = null;
    }
  },

  // 抑制 Emscripten 預設的 print（避免噪音）
  print:    function(t) { send({ type: 'debug', text: t }); },
  printErr: function(t) { send({ type: 'debug', text: '[err] ' + t }); },

  // 讓 Emscripten 知道是 Worker 環境
  noInitialRun: false
};

try {
  importScripts('./rapfi-multi-simd128-relaxed.js');
} catch(e) {
  send({ type: 'error', text: '無法載入引擎 JS：' + e.message });
}

// ── Rapfi C API 封裝 ──────────────────────────────────────────
// Rapfi Emscripten 匯出的函式名稱（依官方 build）：
//   _rapfiInit(rule)
//   _rapfiClear()
//   _rapfiMove(x, y, color)   color: 1=BLACK, 2=WHITE
//   _rapfiBestMove(timeMs)    → 回傳 packed int: x | (y << 8)
//   _rapfiScore()             → 回傳 int (centipawn-like)
//   _rapfiUndo()

function callInit(rule) {
  try {
    if (typeof Module._rapfiInit === 'function') {
      Module._rapfiInit(rule);
      return true;
    }
    // 備用：ccall
    Module.ccall('rapfiInit', null, ['number'], [rule]);
    return true;
  } catch(e) {
    send({ type: 'debug', text: 'callInit error: ' + e.message });
    return false;
  }
}

function callClear() {
  try {
    if (typeof Module._rapfiClear === 'function') { Module._rapfiClear(); return; }
    Module.ccall('rapfiClear', null, [], []);
  } catch(e) {}
}

function callMove(x, y, color) {
  try {
    if (typeof Module._rapfiMove === 'function') { Module._rapfiMove(x, y, color); return; }
    Module.ccall('rapfiMove', null, ['number','number','number'], [x, y, color]);
  } catch(e) {
    send({ type: 'debug', text: 'callMove error: ' + e.message });
  }
}

function callBestMove(timeMs) {
  try {
    var packed;
    if (typeof Module._rapfiBestMove === 'function') {
      packed = Module._rapfiBestMove(timeMs);
    } else {
      packed = Module.ccall('rapfiBestMove', 'number', ['number'], [timeMs]);
    }
    return { c: packed & 0xFF, r: (packed >> 8) & 0xFF };
  } catch(e) {
    send({ type: 'debug', text: 'callBestMove error: ' + e.message });
    return null;
  }
}

function callScore() {
  try {
    if (typeof Module._rapfiScore === 'function') return Module._rapfiScore();
    return Module.ccall('rapfiScore', 'number', [], []);
  } catch(e) { return 0; }
}

function callUndo() {
  try {
    if (typeof Module._rapfiUndo === 'function') { Module._rapfiUndo(); return; }
    Module.ccall('rapfiUndo', null, [], []);
  } catch(e) {}
}

// ── 棋盤重建 ─────────────────────────────────────────────────
// moves: [{c, r, p}]  p=1 黑, p=2 白
function rebuildBoard(moves, boardSize) {
  callClear();
  for (var i = 0; i < moves.length; i++) {
    var m = moves[i];
    callMove(m.c, m.r, m.p);   // p 直接對應 rapfi color (1=BLACK,2=WHITE)
  }
}

// ── 處理 init ────────────────────────────────────────────────
function handleInit(data) {
  currentRule = data.rule !== undefined ? data.rule : 0;
  var ok = callInit(currentRule);
  if (!ok) {
    send({ type: 'error', text: 'rapfiInit 呼叫失敗，請確認引擎版本' });
  }
}

// ── 主訊息處理 ───────────────────────────────────────────────
self.onmessage = function(e) {
  var d = e.data;

  switch (d.type) {

    case 'init':
      if (!engineReady) {
        pendingMsg = d;   // 引擎還沒好，先暫存
      } else {
        handleInit(d);
      }
      break;

    case 'move':
      if (!engineReady) { send({ type: 'error', text: '引擎尚未就緒' }); return; }
      try {
        rebuildBoard(d.board || [], d.boardSize || 15);
        var timeMs = d.timeLimit || 3000;
        var best = callBestMove(timeMs);
        var score = callScore();
        if (best) {
          send({ type: 'move', move: { c: best.c, r: best.r }, score: score });
        } else {
          send({ type: 'move', move: null, score: 0 });
        }
      } catch(ex) {
        send({ type: 'error', text: 'move 處理失敗: ' + ex.message });
      }
      break;

    case 'hint':
      if (!engineReady) { send({ type: 'error', text: '引擎尚未就緒' }); return; }
      try {
        rebuildBoard(d.board || [], d.boardSize || 15);
        var timeMs = d.timeLimit || 3000;
        var best = callBestMove(timeMs);
        var score = callScore();
        if (best) {
          send({ type: 'hint', move: { c: best.c, r: best.r }, score: score });
        } else {
          send({ type: 'hint', move: null, score: 0 });
        }
      } catch(ex) {
        send({ type: 'error', text: 'hint 處理失敗: ' + ex.message });
      }
      break;

    default:
      send({ type: 'debug', text: '未知訊息類型: ' + d.type });
  }
};

// ── 全域錯誤捕捉 ─────────────────────────────────────────────
self.onerror = function(msg, src, line) {
  send({ type: 'error', text: 'Worker 全域錯誤: ' + msg + ' (line ' + line + ')' });
};
