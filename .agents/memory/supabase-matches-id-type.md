---
name: Supabase matches.id type
description: matches.id is TEXT in Supabase, not UUID — RPC function parameters must use TEXT
---

The `matches.id` column in Supabase is **TEXT**, not UUID.

Any PostgreSQL function that takes a match ID parameter must declare it as TEXT:
```sql
p_match_id TEXT  -- correct
p_match_id UUID  -- causes: operator does not exist: text = uuid
```

**Why:** Original schema used TEXT for IDs. PostgreSQL does not implicitly cast TEXT → UUID in plpgsql WHERE clauses.

**How to apply:** Always use TEXT for match ID params in any Supabase function. JS client passes plain string → maps to TEXT correctly.
