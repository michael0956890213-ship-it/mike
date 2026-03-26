'use strict';

var Module = null;
var engineReady = false;
var pendingMove = null;
var readyResolvers = [];
var currentRule = 0;

function handleLine(line) {
  line = line.trim();
  if (!line) return;
  if (/^\d+,\d+$/.test(line)) {
    var p = line.split(',');
    if (pendingMove) {
      var cb = pendingMove; pendingMove = null;
      cb.resolve({ c: parseInt(p[0], 10), r: parseInt(p[1], 10) });
    }
    return;
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
  await new Promise(function(resolve) {
    var t = setInterval(function(){
      if (typeof Rapfi !== 'undefined') { clearInterval(t); resolve(); }
    }, 30);
  });
  self.postMessage({ type: 'status', text: '初始化引擎...' });
  Module = await Rapfi({
    print:    function(t){ handleLine(t); },
    printErr: function(t){ },
  });
  if (!Module.calledRun) {
    await new Promise(function(resolve){ Module.onRuntimeInitialized = resolve; });
  }

  // 根據規則載入對應 config
  var configName;
  if (currentRule === 1) {
    configName = 'gomocalc-classical220723.toml';
  } else {
    configName = 'gomocalc-mix9svq.toml';
  }
  await fetchToFS('./nnue/' + configName, 'config.toml');

  // 載入 model bin
  self.postMessage({ type: 'status', text: '載入模型...' });
  await fetchToFS('./nnue/model210901.bin', 'model210901.bin');
  await fetchToFS('./nnue/model220723.bin', 'model220723.bin');

  // 載入 NNUE 權重
  self.postMessage({ type: 'status', text: '載入 NNUE 權重...' });
  await fetchToFS('./nnue/mix9svqfreestyle_bsmix.bin.lz4',    'mix9svqfreestyle_bsmix.bin.lz4');
  await fetchToFS('./nnue/mix9svqstandard_bs15.bin.lz4',      'mix9svqstandard_bs15.bin.lz4');
  await fetchToFS('./nnue/mix9svqrenju_bs15_black.bin.lz4',   'mix9svqrenju_bs15_black.bin.lz4');
  await fetchToFS('./nnue/mix9svqrenju_bs15_white.bin.lz4',   'mix9svqrenju_bs15_white.bin.lz4');

  cmd('START 15');
  cmd('INFO rule ' + currentRule);
  cmd('INFO timeout_turn 5000');
  cmd('INFO timeout_match 300000');
  cmd('INFO max_memory 314572800');
  await waitReady();
  self.postMessage({ type: 'ready' });
}

async function doMove(board) {
  await waitReady();
  cmd('BOARD');
  for (var i = 0; i < board.length; i++) {
    var m = board[i];
    cmd(m.c + ',' + m.r + ',' + (m.p === 1 ? 1 : 2));
  }
  cmd('DONE');
  return new Promise(function(resolve) {
    pendingMove = { resolve: resolve };
    setTimeout(function(){
      if (pendingMove) { pendingMove = null; resolve(null); }
    }, 10000);
  });
}

async function newGame(rule) {
  if (rule !== undefined) currentRule = rule;
  engineReady = false;
  cmd('START 15');
  cmd('INFO rule ' + currentRule);
  cmd('INFO timeout_turn 5000');
  cmd('INFO max_memory 314572800');
  await waitReady();
  self.postMessage({ type: 'ready' });
}

self.onmessage = async function(e) {
  var d = e.data;
  try {
    switch (d.type) {
      case 'init':    await initEngine(d.rule); break;
      case 'move':    var m = await doMove(d.board); self.postMessage({ type: 'move', move: m }); break;
      case 'newgame': await newGame(d.rule); break;
      case 'stop':    cmd('STOP'); break;
    }
  } catch(err) {
    self.postMessage({ type: 'error', text: err.message || String(err) });
  }
};
