# Legacy minimatch callers with the patched upstream engine

All pattern matching is delegated to official `minimatch@11.0.1`, which fixes
[GHSA-g3hv-75wg-m249](https://github.com/isaacs/minimatch/security/advisories/GHSA-g3hv-75wg-m249).
No old matching implementation or regular-expression compiler is retained.

The root npm override routes both older and newer transitive callers through
this adapter. ESLint plugins still require a callable CommonJS export. The
older glob used by browser-profile cleanup also reads `_glob` from parsed
pattern portions and calls `String.match()`; its compatibility hook delegates
to upstream's `Matcher.test()` without creating a regular expression.
The adapter preserves those interfaces while retaining the upstream Matcher
instances and their nonrecursive matching behavior.

The npm alias `minimatch-engine` identifies the actual upstream dependency;
this local package has its own name and version. Regression tests exercise
linting patterns, glob traversal and real temporary browser-profile deletion.
