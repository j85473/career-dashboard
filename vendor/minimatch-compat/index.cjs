'use strict';

// All matching uses upstream's patched, nonrecursive engine. Keep the callable
// CommonJS export required by ESLint plugins and glob 7 (browser profile cleanup).
const engine = require('minimatch-engine');

class Minimatch extends engine.Minimatch {
  parse(pattern) {
    const part = super.parse(pattern);
    if (part && typeof part === 'object') {
      // glob 7 reads the original portion and calls String.match(portion).
      // Preserve the actual Matcher instance for the modern engine's own use.
      part._glob = pattern;
      part[Symbol.match] = value => part.test(value) ? [value] : null;
    }
    return part;
  }
}
Minimatch.GLOBSTAR = engine.GLOBSTAR;

function minimatch(path, pattern, options) {
  return engine.minimatch(path, pattern, options);
}

Object.assign(minimatch, engine, { Minimatch });
module.exports = minimatch;
