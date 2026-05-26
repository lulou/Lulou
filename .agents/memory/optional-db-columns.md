---
name: Optional DB columns guard
description: How to safely handle DB columns that may not exist yet (e.g. post-migration columns like latitude/longitude).
---

## The Rule
Never include column names in a Supabase SELECT string that may not exist in the live DB.
A SELECT with a non-existent column returns `{ error: { message: "column does not exist" } }`.
The caller returns `[]`, making the entire list appear empty — no exception, no crash, silent failure.

**Why:** The `latitude`/`longitude` columns were added to the Drizzle schema and POOL_COLS/WHEEL_COLS/MATCH_PROFILE_COLS/LIKES_PROFILE_COLS before the Supabase SQL migration was run. Every query to `/api/discover`, `/api/popular`, and `/api/matches` failed silently → zero profiles shown everywhere.

## How to Apply
1. Add a module-level boolean flag (e.g. `let _hasLatLngColumns = false`) and an exported setter.
2. At server startup, query `SELECT <optional_cols> LIMIT 1`. If it errors with "does not exist", leave flag false; otherwise set true.
3. Build column lists dynamically: `[...baseColsList, ...(_hasFlag ? ["col_a", "col_b"] : [])].join(", ")`.
4. Gate any in-memory logic that uses those values on the same flag.
5. Log clearly so the operator knows which path is active.

## Age Filter Gotcha
PostgreSQL `NULL >= 18` is `false`, so `.gte("age", min)` silently excludes profiles with null age.
Fix: use `.or("age.is.null,age.gte.${min}").or("age.is.null,age.lte.${max}")` at DB level,
and `if (candidateAge != null && (candidateAge < min || candidateAge > max))` in-memory
(null age = pass through, not exclude).
