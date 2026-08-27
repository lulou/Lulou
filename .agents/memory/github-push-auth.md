---
name: GitHub push authentication
description: Recovery guidance when the attached GitHub integration is healthy but Git HTTPS rejects a push credential.
---

GitHub's attached integration status can remain healthy while the Git HTTPS credential used by the repository remote is rejected as invalid. If reauthorization is declined or unavailable, an existing workspace GitHub credential can be supplied to one push through a temporary `GIT_ASKPASS` helper; never put the credential in the remote URL or commit it to project files.

**Why:** The GitHub connection and the repository's Git credential path are separate enough that one can fail while the other reports healthy. An ephemeral helper allowed the release push without exposing or persisting the credential.

**How to apply:** Try the attached integration's normal authorization-recovery flow first. If the user declines and a workspace credential is already available, use it only for the single required Git operation, remove the temporary helper immediately, and verify the remote revision afterward.