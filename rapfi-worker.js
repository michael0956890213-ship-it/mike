'use strict';

var Module = null;
var engineReady = false;
var pendingMove = null;
var readyResolvers = [];
var currentRule = 0;

function handleLine(line) {
  line = line.trim();
  if (!line) return;

  // 落子座標回傳（格式：col,row）
  if (/^\d+,\d+$/.test(line)) {
    var p = line.split(',');
    if (pendingMove) {
      var cb = pendingMove;
      pendingMove = null;
      cb.resolve({ c: parseInt(p[0], 10), r: parseInt(p[1], 10) });
    }
    return;
  }

  // 嘗試從 info 行解析分數（格式：info ... score <N> ...）
  var scoreMatch = line.match(/\bscore\s+(-?\d+)/i);
  if (scoreMatch && pendingMove) {
    pendingMove.lastScore = parseInt(scoreMatch[1], 10);
  }

  if (line === 'OK') {
    if (!engineReady) {
      engineReady = true;
      readyResolvers.forEach(function(fn){ fn(); });
      readyResolvers = [];
    }
    return;
  }

  self.postMessage({ type: 'debug', text: line });
}

function cmd(s) {
  if (Module && Module.stdin_push) Module.stdin_push(s + '\n');
}

function waitReady() {
  if (engineReady) return Promise.resolve();
  return new Promise(function(r){ readyResolvers.push(r); });
}

async function fetchToFS(url, name) {
  try {
    var resp = await fetch(url);
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    var buf = await resp.arrayBuffer();
    Module.FS.writeFile('/' + name, new Uint8Array(buf));
    self.postMessage({ type: 'status', text: '✓ ' + name });
  } catch(e) {
    self.postMessage({ type: 'status', text: '⚠ 略過 ' + name + ': ' + e.message });
  }
}

async function initEngine(rule) {
  currentRule = (rule === undefined) ? 0 : rule;
  self.postMessage({ type: 'status', text: '載入 WASM...' });
  importScripts('./rapfi-multi-simd128-relaxed.js');

  // 等待 Rapfi 函式出現
  await new Promise(function(resolve) {
    var t = setInterval(function(){
      if (typeof Rapfi !== 'undefined') { clearInterval(t); resolve(); }
    }, 30);
  });

  self.postMessage({ type: 'status', text: '初始化引擎...' });

  // 等待 onRuntimeInitialized 確保 FS 已就緒
  Module = await new Promise(function(resolve) {
    Rapfi({
      print:    function(t){ handleLine(t); },
      printErr: function(t){ /* 忽略 stderr */ },
      onRuntimeInitialized: function() { resolve(this); }
    });
  });

  var configName = currentRule === 1
    ? 'gomocalc-classical220723.toml'
    : 'gomocalc-mix9svq.toml';
  await fetchToFS('./nnue/' + configName, 'config.toml');

  self.postMessage({ type: 'status', text: '載入模型...' });

  var nnueFiles = [
    'mix9svq-b1.bin','mix9svq-b2.bin','mix9svq-b3.bin',
    'mix9svq-b4.bin','mix9svq-b5.bin','mix9svq-b6.bin',
    'classical220723.bin'
  ];
  for (var i = 0; i < nnueFiles.length; i++) {
    await fetchToFS('./nnue/' + nnueFiles[i], nnueFiles[i]);
  }

  cmd('isready');
  await waitReady();
  self.postMessage({ type: 'ready' });
}

// ★ 核心：move 與 hint 完全共用同一函式，保證引擎指令一致
function requestMove(moves, boardSize, timeLimit) {
  return new Promise(function(resolve) {
    var sz = boardSize || 15;
    var timeSec = Math.max(1, Math.round((timeLimit || 3000) / 1000));
    var turn = (moves.length % 2 === 0) ? 'black' : 'white';

    // 設定好 pendingMove（含 lastScore 暫存）
    pendingMove = {
      lastScore: null,
      resolve: function(pos) {
        var sc = pendingMove ? pendingMove.lastScore : null;
        pendingMove = null;
        resolve({ move: pos, score: sc });
      }
    };

    // 送出指令序列
    cmd('boardsize ' + sz);
    cmd('clearboard');
    for (var i = 0; i < moves.length; i++) {
      var m = moves[i];
      cmd('play ' + (m.p === 1 ? 'black' : 'white') + ' ' + m.c + ',' + m.r);
    }
    cmd('time_settings 0 ' + timeSec + ' 0');
    cmd('genmove ' + turn);
  });
}

self.onmessage = async function(e) {
  var d = e.data;
  switch (d.type) {

    case 'init':
      try { await initEngine(d.rule); }
      catch(err) { self.postMessage({ type:'error', text: String(err) }); }
      break;

    case 'newgame':
      engineReady = false;
      pendingMove = null;
      try { await initEngine(d.rule !== undefined ? d.rule : currentRule); }
      catch(err) { self.postMessage({ type:'error', text: String(err) }); }
      break;

    // AI 走棋
    case 'move':
      try {
        var result = await requestMove(d.board, d.boardSize, d.timeLimit);
        self.postMessage({ type: 'move', move: result.move, score: result.score });
      } catch(err) {
        self.postMessage({ type: 'error', text: String(err) });
      }
      break;

    // 提示（與 move 完全相同的引擎指令 → 結果一致）
    case 'hint':
      try {
        var result = await requestMove(d.board, d.boardSize, d.timeLimit);
        self.postMessage({ type: 'hint', move: result.move, score: result.score });
      } catch(err) {
        self.postMessage({ type: 'error', text: String(err) });
      }
      break;
  }
};
