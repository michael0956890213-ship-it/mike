'use strict';

// ══════════════════════════════════════════════════════════════
// rapfi-worker.js — 完全修復版
//
// 問題根源：原版呼叫 _rapfiInit / _rapfiBestMove 等不存在的 C API
// 真正的 Rapfi Emscripten build 使用 Gomocup/Piskvork 文字協定
// 引擎透過 stdin/stdout 通訊，命令格式：
//   START 15          → 開始15x15棋盤
//   INFO rule N       → 設定規則（0=Standard, 1=Renju, 4=Freestyle）
//   INFO time_left N  → 設定思考時間（毫秒）
//   BEGIN             → 請引擎先手（第一步）
//   TURN x,y          → 告知對手落子，引擎回答自己的落子
//   BOARD / DONE      → 完整棋盤同步
//   引擎回應格式：x,y（座標）或 MESSAGE ...（訊息）
// ══════════════════════════════════════════════════════════════

var engineReady = false;
var pendingMsg  = null;
var currentRule = 0;

function send(obj) { postMessage(obj); }

// ── stdin/stdout 緩衝 ─────────────────────────────────────────
var inputQueue = [];   // 我們要送入引擎的字元（stdin）
var lineBuf    = '';   // 引擎輸出緩衝（stdout）

// 等候引擎輸出一行的 resolve 函式與逾時 ID
var lineResolve = null;
var lineTimeout = null;

function writeToEngine(cmd) {
  var s = cmd + '\n';
  for (var i = 0; i < s.length; i++) inputQueue.push(s.charCodeAt(i));
}

// 等候引擎輸出下一行（非空白行）
function nextEngineLine(ms) {
  return new Promise(function(resolve, reject) {
    lineResolve = function(line) {
      if (lineTimeout) { clearTimeout(lineTimeout); lineTimeout = null; }
      lineResolve = null;
      resolve(line);
    };
    lineTimeout = setTimeout(function() {
      lineResolve = null;
      reject(new Error('引擎回應逾時'));
    }, ms || 15000);
  });
}

// 引擎每輸出一行就呼叫此函式
function onEngineLine(line) {
  line = line.trim();
  if (!line) return;

  // MESSAGE / DEBUG → 轉發，不打斷等候
  if (/^(MESSAGE|DEBUG|INFO\s|ERROR)/.test(line)) {
    send({ type: 'debug', text: line });
    return;
  }

  // 交給等候者
  if (lineResolve) {
    lineResolve(line);
  } else {
    send({ type: 'debug', text: '[未預期] ' + line });
  }
}

// ── Emscripten Module 設定 ────────────────────────────────────
send({ type: 'status', text: '載入 WASM...' });

self.Module = {
  locateFile: function(path) { return './' + path; },

  // stdin：非阻塞，從佇列取字元
  stdin: function() {
    return inputQueue.length ? inputQueue.shift() : null;
  },

  // stdout：逐字元累積，遇 \n 送出一行
  stdout: function(code) {
    if (code === 10) { onEngineLine(lineBuf); lineBuf = ''; }
    else if (code !== null && code !== undefined) lineBuf += String.fromCharCode(code);
  },

  stderr: function(code) {
    // stderr 通常是 Rapfi 的 debug 訊息，直接轉發
    if (code === 10) { send({ type:'debug', text:'[stderr] '+lineBuf }); lineBuf=''; }
    else if (code !== null && code !== undefined) lineBuf += String.fromCharCode(code);
  },

  print:    function(t) { onEngineLine(t); },
  printErr: function(t) { send({ type:'debug', text:'[err] '+t }); },

  onRuntimeInitialized: function() {
    send({ type:'status', text:'WASM 就緒，初始化協定...' });
    setTimeout(initEngine, 50);
  },

  noInitialRun: false
};

// ── 引擎協定初始化 ────────────────────────────────────────────
async function initEngine() {
  try {
    // Rapfi 啟動後會等候指令，先送 START
    writeToEngine('START 15');
    var r1 = await nextEngineLine(8000);

    if (!r1.startsWith('OK')) {
      // 某些版本啟動會先印出版本資訊，再印 OK，嘗試再等一行
      if (r1.includes('Rapfi') || r1.includes('rapfi')) {
        r1 = await nextEngineLine(5000);
      }
      if (!r1.startsWith('OK')) {
        throw new Error('START 未收到 OK，收到：' + r1);
      }
    }

    // 設定規則
    writeToEngine('INFO rule ' + currentRule);
    // INFO 指令通常沒有回應，等 50ms 讓引擎處理
    await delay(50);

    engineReady = true;
    send({ type:'status', text:'Rapfi NNUE 引擎就緒 ✓' });
    send({ type:'ready' });

    if (pendingMsg) { handleInit(pendingMsg); pendingMsg = null; }

  } catch(e) {
    send({ type:'error', text:'引擎初始化失敗: ' + e.message });
  }
}

function delay(ms) { return new Promise(function(r){ setTimeout(r, ms); }); }

// ── 請求引擎落子 ─────────────────────────────────────────────
// moves: [{c, r, p}]  p=1黑 p=2白
async function doMove(moves, boardSize, timeMs) {
  if (!engineReady) throw new Error('引擎尚未就緒');

  timeMs = timeMs || 3000;

  // 同步完整棋盤狀態
  writeToEngine('BOARD');
  for (var i = 0; i < moves.length; i++) {
    var m = moves[i];
    writeToEngine(m.c + ',' + m.r + ',' + m.p);
  }
  writeToEngine('DONE');

  // 設定本局思考時間
  writeToEngine('INFO time_left ' + timeMs);
  writeToEngine('INFO time_increment 0');

  // 觸發引擎思考
  if (moves.length === 0) {
    // 空棋盤，引擎先手
    writeToEngine('BEGIN');
  } else {
    var last = moves[moves.length - 1];
    writeToEngine('TURN ' + last.c + ',' + last.r);
  }

  // 等候 "x,y" 格式的落子回應
  var answer = await nextEngineLine(timeMs + 10000);

  // 解析回應，過濾掉 MESSAGE 行（已在 onEngineLine 處理）
  // 但有時引擎會在落子前夾雜 MESSAGE，此處做安全處理
  while (answer.startsWith('MESSAGE') || answer.startsWith('DEBUG') || answer.startsWith('INFO')) {
    send({ type:'debug', text: answer });
    answer = await nextEngineLine(5000);
  }

  var parts = answer.split(/[,\s]+/);
  var c = parseInt(parts[0]), r = parseInt(parts[1]);
  if (isNaN(c) || isNaN(r)) throw new Error('落子解析失敗：' + answer);
  return { c: c, r: r };
}

// ── 處理 init 訊息 ────────────────────────────────────────────
function handleInit(data) {
  var rule = data.rule !== undefined ? parseInt(data.rule) : 0;
  if (rule !== currentRule) {
    currentRule = rule;
    if (engineReady) {
      writeToEngine('INFO rule ' + currentRule);
    }
  }
}

// ── 載入引擎 WASM（嘗試多個版本）────────────────────────────
(function loadEngine() {
  var versions = [
    'rapfi-multi-simd128-relaxed.js',
    'rapfi-multi-simd128.js',
    'rapfi-multi.js',
    'rapfi-single-simd128.js',
    'rapfi-single.js'
  ];
  for (var i = 0; i < versions.length; i++) {
    try {
      importScripts('./' + versions[i]);
      return; // 成功載入，停止嘗試
    } catch(e) {
      // 繼續嘗試下一個版本
    }
  }
  send({ type:'error', text:'找不到可用的引擎 JS 檔案，請確認伺服器上有 rapfi-*.js' });
})();

// ── 主訊息處理 ────────────────────────────────────────────────
self.onmessage = function(e) {
  var d = e.data;
  switch (d.type) {

    case 'init':
      if (!engineReady) pendingMsg = d;
      else handleInit(d);
      break;

    case 'move':
      if (!engineReady) { send({ type:'error', text:'引擎尚未就緒' }); return; }
      doMove(d.board || [], d.boardSize || 15, d.timeLimit || 3000)
        .then(function(mv) { send({ type:'move', move:mv, score:0 }); })
        .catch(function(err) { send({ type:'error', text:'move 失敗: ' + err.message }); });
      break;

    case 'hint':
      if (!engineReady) { send({ type:'error', text:'引擎尚未就緒' }); return; }
      doMove(d.board || [], d.boardSize || 15, d.timeLimit || 3000)
        .then(function(mv) { send({ type:'hint', move:mv, score:0 }); })
        .catch(function(err) { send({ type:'error', text:'hint 失敗: ' + err.message }); });
      break;

    default:
      send({ type:'debug', text:'未知訊息: ' + d.type });
  }
};

self.onerror = function(msg, src, line) {
  send({ type:'error', text:'Worker 全域錯誤: ' + msg + ' (line ' + line + ')' });
};
