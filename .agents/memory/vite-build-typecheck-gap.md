---
name: Vite build type-check gap
description: Why successful production builds do not prove renamed TypeScript identifiers are valid in this project.
---

**Rule:** Do not rely on the production Vite build to catch undefined or stale
TypeScript identifiers. When renaming a variable used in hooks, dependency
arrays, or render expressions, add a focused regression or run an explicit type
check/search for the old identifier.

**Why:** The build transpiles with esbuild without a full TypeScript type-check,
so an undefined identifier reached production and caused an immediate React
error-boundary crash only when the affected component mounted.

**How to apply:** For identifier migrations, search every active read/write and
dependency array, then add a regression that rejects the obsolete identifier.