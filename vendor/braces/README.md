# Local security patch for braces

This private package is a fork of `braces@3.0.3`, installed under the dependency
name `braces` through the root npm override. It retains the upstream MIT license
and implementation, with a bounded nesting patch for
[GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm).
It is not a released or upstream-approved fix.

The root development dependency anchors the relative file location; the
`$braces` override makes transitive consumers use that same package. This avoids
resolving the file path relative to a consumer inside `node_modules`.

Upstream source: https://github.com/micromatch/braces/tree/3.0.3

Original npm tarball: https://registry.npmjs.org/braces/-/braces-3.0.3.tgz

Original integrity:
`sha512-yQbXgO/OSZVD2IsiLlro+7Hf6Q18EJrKSEsdoMzKePKXct3gvD8oLcOQdIzGupr5Fj+EDe8gO/lxc1BzfMpxvA==`

## Changes

- The parser limits combined brace and parenthesis nesting to 100 before adding
  another container. This also protects recursive helpers used during parsing.
- Compilation, expansion and stringification check traversal depth themselves,
  including when supplied an AST directly rather than a pattern. AST traversal
  permits a root, 100 containers and their leaf. Cyclic child-node trees therefore
  fail within the same bound.
- Excessive nesting throws a `SyntaxError` with code `ERR_BRACES_MAX_DEPTH`,
  rather than exhausting the JavaScript call stack. Caller options cannot raise
  the limit. The existing 10,000-character and range-expansion limits remain.

The override applies on clean `npm ci`, including installs with scripts disabled;
it does not rely on modifying `node_modules` in an install hook. This dependency
is currently used only by development lint tooling.

Registry vulnerability audits do not assess the source of local packages. A clean
audit after this override is not independent verification of this fork. The
security and compatibility regression tests live in
`tests/unit/bracesSecurity.test.ts`; run them with
`node --import tsx --test tests/unit/bracesSecurity.test.ts`.

When an upstream release fixes this advisory, replace the override with that
release, remove this fork, and rerun these regressions and the lint integration
check before updating the lockfile. Do not remove the override solely because an
audit omits the local package.
