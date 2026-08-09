'use strict';
// Build script: bundles src/main.js (ES modules) into js/game.js as a single
// self-contained IIFE, so index.html works from file:// and the Node sim can
// keep eval'ing the bundled output unchanged.
const esbuild = require('esbuild');

const watch = process.argv.includes('--watch');
const minify = process.argv.includes('--minify');

const options = {
  entryPoints: ['src/main.js'],
  bundle: true,
  format: 'iife',
  outfile: 'js/game.js',
  legalComments: 'none',
  charset: 'utf8',
  logLevel: 'info',
  minify,
};

if (watch) {
  esbuild.context(options).then((ctx) => ctx.watch()).then(() => {
    console.log('[build] watching src/ ...');
  });
} else {
  esbuild.build(options).then((r) => {
    const fs = require('fs');
    const bytes = fs.statSync('js/game.js').size;
    console.log('[build] js/game.js written,', bytes, 'bytes');
  }).catch((e) => {
    console.error('[build] FAILED:', e.message);
    process.exit(1);
  });
}
