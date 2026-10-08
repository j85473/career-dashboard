'use strict';

// Reserve one AST level for a leaf inside the deepest allowed container.
// This fixed ceiling cannot be raised through caller-supplied options.
const MAX_NESTING_DEPTH = 100;

module.exports = depth => {
  if (depth > MAX_NESTING_DEPTH + 1) {
    const error = new SyntaxError(`Brace pattern nesting exceeds the limit of ${MAX_NESTING_DEPTH}`);
    error.code = 'ERR_BRACES_MAX_DEPTH';
    throw error;
  }
};
