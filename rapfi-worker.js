'use strict';

// ─────────────────────────────────────────────
//  Rapfi Worker  –  完整修復版
//  對應 gomoku_v13.html 的訊息協議
// ─────────────────────────────────────────────

var Module       = null;
var engineReady  = false;
var readyResolvers = [];

// ── 等待引擎就緒的 Promise ──────────────────
function waitForReady() {
  if (engineReady) return Promise.resolve();
  return new Promise(function(resolve) {
    readyResolvers.push(resolve);
  });
}

// ── 載入 Rapfi wasm 膠水層 ──────────────────
try {
  importScripts('./rapfi-multi-simd128-relaxed.js');
} catch (e) {
  postMessage({ type: 'error', message: 'importScripts 失敗: ' + e.message });
}

// ── 初始化 Emscripten Module ────────────────
var moduleConfig = {
  // 讓 Emscripten 在同目錄尋找 .wasm / .data
  locateFile: function(path) {
    return './' + path;
  },

  // wasm + data 全部載完、C++ main() 執行完畢後觸發
  onRuntimeInitialized: function() {
    try {
      // Rapfi 需要先呼叫 init (部分 build 版本)
      if (typeof Module._rapfiInit === 'function') {
        Module._rapfiInit();
      }
      engineReady = true;
      // 通知所有等待者
      readyResolvers.forEach(function(r) { r(); });
      readyResolvers = [];
      // 告知主線程引擎已就緒
      postMessage({ type: 'ready' });
      postMessage({ type: 'log', message: 'Rapfi 引擎初始化完成 ✅' });
    } catch(e) {
      postMessage({ type: 'error', message: '引擎初始化失敗: ' + e.message });
    }
  },

  // 攔截 Emscripten print / printErr，轉成 log 訊息
  print: function(text) {
    postMessage({ type: 'log', message: text });
  },
  printErr: function(text) {
    postMessage({ type: 'log', message: '[ERR] ' + text });
  }
};

// 把 config 合併進全域 Module（Emscripten 會讀取它）
if (typeof Module === 'undefined' || Module === null) {
  self.Module = moduleConfig;
} else {
  Object.assign(self.Module, moduleConfig);
}

// ── 工具：把二維棋盤陣列轉成 Rapfi 需要的格式 ──
// board[y][x] : 0=空, 1=黑, 2=白
function encodeBoard(board, boardSize) {
  // Rapfi C API 使用一維陣列，黑=1 白=2 空=0
  var flat = new Int32Array(boardSize * boardSize);
  for (var y = 0; y < boardSize; y++) {
    for (var x = 0; x < boardSize; x++) {
      flat[y * boardSize + x] = board[y][x] || 0;
    }
  }
  return flat;
}

// ── 呼叫 Rapfi C API 取得 AI 落子 ──────────
function callRapfiMove(board, boardSize, rule, timeLimit) {
  try {
    var flat  = encodeBoard(board, boardSize);
    var bytes = flat.length * 4;

    // 在 wasm heap 上分配記憶體
    var ptr = Module._malloc(bytes);
    Module.HEAP32.set(flat, ptr >> 2);

    var resultPtr = Module._malloc(8); // 兩個 int32: x, y

    // 嘗試呼叫 Rapfi 的標準 C 介面
    // 函式名稱依 build 版本可能不同，依序嘗試
    var moved = false;
    var rx = -1, ry = -1;

    if (typeof Module._rapfiGenMove === 'function') {
      Module._rapfiGenMove(ptr, boardSize, rule, timeLimit, resultPtr);
      rx = Module.HEAP32[resultPtr >> 2];
      ry = Module.HEAP32[(resultPtr + 4) >> 2];
      moved = true;
    } else if (typeof Module._genMove === 'function') {
      Module._genMove(ptr, boardSize, rule, timeLimit, resultPtr);
      rx = Module.HEAP32[resultPtr >> 2];
      ry = Module.HEAP32[(resultPtr + 4) >> 2];
      moved = true;
    }

    Module._free(ptr);
    Module._free(resultPtr);

    if (moved && rx >= 0 && ry >= 0) {
      return { x: rx, y: ry };
    }

    // Fallback：找第一個空格（防止卡死）
    return fallbackMove(board, boardSize);

  } catch(e) {
    postMessage({ type: 'log', message: 'callRapfiMove 例外: ' + e.message });
    return fallbackMove(board, boardSize);
  }
}

// ── 呼叫 Rapfi C API 取得勝率分析 ──────────
function callRapfiAnalyze(board, boardSize, rule) {
  try {
    var flat = encodeBoard(board, boardSize);
    var bytes = flat.length * 4;
    var ptr = Module._malloc(bytes);
    Module.HEAP32.set(flat, ptr >> 2);

    var black = 50, white = 50, winner = 0;

    if (typeof Module._rapfiAnalyze === 'function') {
      var resPtr = Module._malloc(12);
      Module._rapfiAnalyze(ptr, boardSize, rule, resPtr);
      black  = Module.HEAP32[resPtr >> 2];
      white  = Module.HEAP32[(resPtr + 4) >> 2];
      winner = Module.HEAP32[(resPtr + 8) >> 2];
      Module._free(resPtr);
    }

    Module._free(ptr);
    return { black: black, white: white, winner: winner };

  } catch(e) {
    postMessage({ type: 'log', message: 'callRapfiAnalyze 例外: ' + e.message });
    return { black: 50, white: 50, winner: 0 };
  }
}

// ── Fallback：隨機找一個空格 ────────────────
function fallbackMove(board, boardSize) {
  // 優先中心點
  var cx = Math.floor(boardSize / 2);
  var cy = Math.floor(boardSize / 2);
  if (!board[cy][cx]) return { x: cx, y: cy };

  for (var y = 0; y < boardSize; y++) {
    for (var x = 0; x < boardSize; x++) {
      if (!board[y][x]) return { x: x, y: y };
    }
  }
  return { x: 0, y: 0 };
}

// ── 主線程訊息處理 ──────────────────────────
self.onmessage = function(e) {
  var data = e.data;
  if (!data || !data.type) return;

  switch (data.type) {

    // 主線程要求初始化（有些版本會主動發 init）
    case 'init':
      waitForReady().then(function() {
        postMessage({ type: 'ready' });
      });
      break;

    // 請求 AI 落子
    case 'move':
      waitForReady().then(function() {
        try {
          var board     = data.board;
          var boardSize = data.boardSize || 15;
          var rule      = data.rule      || 0;
          var timeLimit = data.timeLimit || 3000;

          var result = callRapfiMove(board, boardSize, rule, timeLimit);
          postMessage({ type: 'move', x: result.x, y: result.y });
        } catch(err) {
          postMessage({ type: 'error', message: 'move 處理失敗: ' + err.message });
        }
      });
      break;

    // 請求勝率分析
    case 'analyze':
      waitForReady().then(function() {
        try {
          var board     = data.board;
          var boardSize = data.boardSize || 15;
          var rule      = data.rule      || 0;

          var result = callRapfiAnalyze(board, boardSize, rule);
          postMessage({ type: 'analysis',
                        black:  result.black,
                        white:  result.white,
                        winner: result.winner });
        } catch(err) {
          postMessage({ type: 'error', message: 'analyze 處理失敗: ' + err.message });
        }
      });
      break;

    // 停止思考（目前 wasm 版不支援中斷，忽略即可）
    case 'stop':
      break;

    default:
      postMessage({ type: 'log', message: '未知指令: ' + data.type });
  }
};

// ── 全域錯誤捕捉 ────────────────────────────
self.onerror = function(msg, src, line, col, err) {
  postMessage({ type: 'error',
                message: 'Worker 全域錯誤: ' + msg + ' (line ' + line + ')' });
};
