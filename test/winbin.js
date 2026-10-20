// The tests stand in for claude, codex and gh with small node scripts. Windows can't run a script by its
// shebang, so next to each one write a .cmd shim like the ones npm creates; src/bin.js knows how to read it.
'use strict';
if (process.platform === 'win32') {
  const fs = require('fs');
  const path = require('path');
  const write = fs.writeFileSync;
  fs.writeFileSync = function (file, data, opts) {
    const r = write.apply(this, arguments);
    if (opts && opts.mode === 0o755 && typeof data === 'string' && data.startsWith('#!/usr/bin/env node') && !/\.\w+$/.test(String(file)))
      write.call(fs, file + '.cmd', `@ECHO off\r\nnode "%~dp0${path.basename(String(file))}" %*\r\n`);
    return r;
  };
}
