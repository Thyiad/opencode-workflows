---
description: Implement a plan.md and iterate through independent review
agent: implementer
---

Usage: /implement-plan <milestone-directory>

The argument is one milestone directory, for example `specs/01-backend-core`. The approved plan is:

$ARGUMENTS/plan.md

Before editing, verify that the argument is present and this exact file exists and is readable, and that `specs/00-conventions.md` exists. If not, stop and show the correct usage; do not guess another path.

Read `specs/00-conventions.md` and the complete plan.md before modifying code, and pass both paths to the reviewer.

Treat plan.md as the authoritative specification for this task.

Inspect the actual repository before implementation.

Complete the entire plan.

After implementation and validation, follow sections 5-7 of the `implementer` agent instructions for independent review, model-unavailability fallback, repair cycles, and the review-round limit. A failed reviewer invocation is not an approval.

Write `APPROVED` to `$ARGUMENTS/STATUS` only after the selected reviewer returns `APPROVED` and every acceptance command passes. Never write it otherwise.

Do not stop after the first coding pass.

Do not ask me to manually initiate review or repair cycles.
