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

function cmd(s) {
  if (Module && Module.stdin_push) Module.stdin_push(s + '\n');
}

function waitReady() {
  if (engineReady) return Promise.resolve();
  return new Promise(function(r){ readyResolvers.push(r); });
}

async function fetchToFS(url, fsName) {
  try {
    var resp = await fetch(url);
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    var buf = await resp.arrayBuffer();
    var data = new Uint8Array(buf);

    if (url.endsWith('.lz4')) {
      data = decodeLZ4(data);
    }

    if (!Module || !Module.FS) throw new Error('Module.FS not ready');
    Module.FS.writeFile('/' + fsName, data);
    self.postMessage({ type: 'status', text: '✓ ' + fsName });
  } catch(e) {
    self.postMessage({ type: 'status', text: '⚠ 略過 ' + fsName + ': ' + e.message });
  }
}

function decodeLZ4(src) {
  var srcLen = src.length;
  var srcPos = 0;

  if (src[0] === 0x04 && src[1] === 0x22 && src[2] === 0x4D && src[3] === 0x18) {
    var flg = src[4];
    srcPos = 7;
    if (flg & 0x08) srcPos += 8;
  }

  var chunks = [];
  var totalLen = 0;

  while (srcPos < srcLen) {
    var blockSize = src[srcPos] | (src[srcPos+1]<<8) | (src[srcPos+2]<<16) | (src[srcPos+3]<<24);
    srcPos += 4;
    if (blockSize === 0) break;

    var isUncompressed = (blockSize & 0x80000000) !== 0;
    blockSize = blockSize & 0x7FFFFFFF;

    if (isUncompressed) {
      chunks.push(src.slice(srcPos, srcPos + blockSize));
      totalLen += blockSize;
    } else {
      var block = decodeLZ4Block(src, srcPos, blockSize);
      chunks.push(block);
      totalLen += block.length;
    }
    srcPos += blockSize;
  }

  var result = new Uint8Array(totalLen);
  var offset = 0;
  for (var i = 0; i < chunks.length; i++) {
    result.set(chunks[i], offset);
    offset += chunks[i].length;
  }
  return result;
}

function decodeLZ4Block(src, srcStart, srcLen) {
  var dst = [];
  var srcPos = srcStart;
  var srcEnd = srcStart + srcLen;

  while (srcPos < srcEnd) {
    var token = src[srcPos++];
    var litLen = (token >> 4) & 0xF;
    var matchLen = token & 0xF;

    if (litLen === 15) {
      var extra;
      do { extra = src[srcPos++]; litLen += extra; } while (extra === 255);
    }

    for (var i = 0; i < litLen; i++) dst.push(src[srcPos++]);

    if (srcPos >= srcEnd) break;

    var offset = src[srcPos] | (src[srcPos+1] << 8);
    srcPos += 2;

    matchLen += 4;
    if ((token & 0xF) === 15) {
      var extra2;
      do { extra2 = src[srcPos++]; matchLen += extra2; } while (extra2 === 255);
    }

    var matchPos = dst.length - offset;
    for (var j = 0; j < matchLen; j++) dst.push(dst[matchPos + j]);
  }

  return new Uint8Array(dst);
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

  // ✅ 關鍵修正：用變數 m 而非 this
  Module = await new Promise(function(resolve) {
    var m = Rapfi({
      print:    function(t){ handleLine(t); },
      printErr: function(t){},
      onRuntimeInitialized: function() { resolve(m); }
    });
  });

  var configName, nnueFiles;
  if (currentRule === 1) {
    configName = 'gomocalc-classical220723.toml';
    nnueFiles  = [{ url: 'classical220723.bin', fs: 'classical220723.bin' }];
  } else {
    configName = 'gomocalc-mix9svq.toml';
    nnueFiles  = [
      { url: 'mix9svqfreestyle_bsmix.bin.lz4',  fs: 'mix9svqfreestyle_bsmix.bin' },
      { url: 'mix9svqstandard_bs15.bin.lz4',     fs: 'mix9svqstandard_bs15.bin' },
      { url: 'mix9svqrenju_bs15_black.bin.lz4',  fs: 'mix9svqrenju_bs15_black.bin' },
      { url: 'mix9svqrenju_bs15_white.bin.lz4',  fs: 'mix9svqrenju_bs15_white.bin' }
    ];
  }

  await fetchToFS('./nnue/' + configName, 'config.toml');
  self.postMessage({ type: 'status', text: '載入模型...' });

  for (var i = 0; i < nnueFiles.length; i++) {
    await fetchToFS('./nnue/' + nnueFiles[i].url, nnueFiles[i].fs);
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
