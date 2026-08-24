---
name: Candidate-feed header metadata
description: Safe empty-state metadata is attached to candidate arrays from response headers.
---

When a candidate endpoint intentionally remains an array response for backward compatibility, safe metadata such as an empty reason and the member's configured radius can be attached as non-enumerable properties after parsing response headers. Candidate queries using this pattern must set `structuralSharing: false`.

**Why:** React Query's default structural sharing compares enumerable array items. An empty array can therefore be reused after a refetch even when the server returned new non-enumerable metadata, which leaves distance-empty copy showing a stale reason or radius.

**How to apply:** Keep the array wire contract for existing consumers, expose only aggregate/current-member metadata in CORS-exposed headers, and apply the no-structural-sharing option to every query that reads those properties.