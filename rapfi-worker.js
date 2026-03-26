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
      var cb = pendingMove;
      pendingMove = null;
      cb.resolve({ c: parseInt(p[0], 10), r: parseInt(p[1], 10) });
    }
    return;
  }

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

// 使用 sendCommand 發送指令
function cmd(s) {
  if (Module && Module.sendCommand) Module.sendCommand(s + '\n');
}

function waitReady() {
  if (engineReady) return Promise.resolve();
  return new Promise(function(r){ readyResolvers.push(r); });
}

async function initEngine(rule) {
  currentRule = (rule === undefined) ? 0 : rule;
  self.postMessage({ type: 'status', text: '載入 WASM...' });

  importScripts('./rapfi-multi-simd128-relaxed.js');

  // 等 Rapfi 函式出現
  await new Promise(function(resolve) {
    var t = setInterval(function(){
      if (typeof Rapfi !== 'undefined') { clearInterval(t); resolve(); }
    }, 30);
  });

  self.postMessage({ type: 'status', text: '初始化引擎...' });

  // 直接 await Rapfi，並使用 onReceiveStdout
  Module = await Rapfi({
    onReceiveStdout: function(t) { handleLine(t); },
    onReceiveStderr: function(t) { /* 忽略 stderr */ }
  });

  // 設定規則（如果需要切換）
  if (currentRule === 1) {
    cmd('config classical220723.toml');
  }

  cmd('isready');
  await waitReady();
  self.postMessage({ type: 'ready' });
}

function requestMove(moves, boardSize, timeLimit) {
  return new Promise(function(resolve) {
    var sz = boardSize || 15;
    var timeSec = Math.max(1, Math.round((timeLimit || 3000) / 1000));
    var turn = (moves.length % 2 === 0) ? 'black' : 'white';

    pendingMove = {
      lastScore: null,
      resolve: function(pos) {
        var sc = pendingMove ? pendingMove.lastScore : null;
        pendingMove = null;
        resolve({ move: pos, score: sc });
      }
    };

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

    case 'move':
      try {
        var result = await requestMove(d.board, d.boardSize, d.timeLimit);
        self.postMessage({ type: 'move', move: result.move, score: result.score });
      } catch(err) {
        self.postMessage({ type: 'error', text: String(err) });
      }
      break;

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