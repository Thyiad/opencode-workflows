---
description: Refine a draft plan.md through independent plan review until approved, then write refine-report.md
agent: plan-editor
---

Usage: /refine-plan <milestone-directory> [max-rounds] [--also <file> ...]

The arguments are: `$ARGUMENTS`

The first argument is one milestone directory, for example `specs/35-foo`; the plan to refine is its `plan.md`. The optional second argument is the maximum number of review rounds, the last one included (default 5). Any `--also <file>` arguments name more documents you may change.

Before anything else, verify that the milestone directory argument is present, that `<milestone-directory>/plan.md` and `specs/00-conventions.md` exist, and that `<milestone-directory>/STATUS` does NOT exist (an implemented milestone is not refined). If not, stop and show the correct usage; do not guess another path.

You drive the whole loop yourself in this session. The steps below are all you need to know about the workflow: do not read the source of the `refine-plan` command, `.opencode/` or the run logs to work out how it works. Follow the rules of your agent instructions ("Rules for every task", "Task: revise", "Task: report").

# 1. Start

The steps below use the `refine-plan` command of the opencode-workflows package (installed globally with `npm link`). If the shell says it is not found, stop and tell the user to install it.

Run:

    refine-plan --start <milestone-directory> --max-rounds <max-rounds>

followed by the `--also <file>` arguments, if any. It saves the original documents and prints the record directory (`记录目录`, called `<run>` below), the documents in scope and the check of the `## 验收命令` block. The documents it lists are the only files you may change. Run it exactly once, and do not create `<run>` or its files any other way. From here on, write only the documents in scope and the files in `<run>` the steps below name.

# 2. Rounds

For round `n` = 1, 2, … up to the maximum:

1. Run `refine-plan --check <run>`. It records the version of the documents this review will see (an approval only counts for that version) and checks the `## 验收命令` block as it is now. Do not change any document between this step and saving the review.
2. Invoke the `plan-reviewer` subagent. Its message must contain:
   - `# Plan review, round <n> of at most <max-rounds>`
   - the milestone directory and the list of documents in scope (review these; the editor may change only these)
   - `Shared rules: specs/00-conventions.md`
   - the complete output of the `--check` command, labelled as the milestone runner's own parse of the `## 验收命令` block
   - from round 2 on: the paths of every earlier `<run>/round-<k>-review.md` and `<run>/round-<k>-response.md`, oldest first, with "Read these before you start"
   - `Number your issues R<n>-1, R<n>-2, …, and follow the output format in your instructions exactly: the first line of your response is the verdict.`
   - in the last round: `This is the last round: whatever you list as blocking goes to the user unresolved.`

   Do not summarize the plan for the reviewer or argue for it; it reads the documents itself.
3. Save the reviewer's complete response, verbatim and unedited, with the write tool to `<run>/round-<n>-review.md`. If `plan-reviewer-fallback` gave it, also write the single line `plan-reviewer-fallback` to `<run>/round-<n>-reviewer`.
4. The verdict is the first line of that response:
   - `APPROVED`: go to step 3 (Finish).
   - `CHANGES_REQUESTED` in the last round: go to step 3 (Finish); the remaining issues go to the user.
   - `CHANGES_REQUESTED` otherwise: do the revise task of your instructions for this review, save your answer in the required `## 处理结果` format with the write tool to `<run>/round-<n>-response.md`, and start round `n + 1`.

A review counts only if it is the response of the reviewer subagent in this session. Never write a verdict yourself, never treat a failed review as approval, never skip a round's review, and never start a round beyond the maximum.

## When the reviewer fails

- It answers with neither verdict: invoke the same reviewer once more with the same message. If it still gives no verdict, stop and report the blocker.
- The invocation fails with a transient network or server error (timeout, connection reset, 5xx, interrupted stream): retry the same reviewer once. If that also fails transiently, treat the model as unavailable.
- Its model is unavailable (model or provider not found, authentication failure, quota or rate limit, provider outage): switch to the `plan-reviewer-fallback` subagent with the identical message, and use it for every remaining round. If the fallback is unavailable too, stop and report the blocker.

A `CHANGES_REQUESTED` verdict is not a failure, and repository, permission or tool errors are not a reason to switch reviewers. When you stop, run step 3.2 anyway if at least one review was saved, so the user gets the report.

# 3. Finish

1. If any round has a response file: for each document in scope, look at the changes with `git diff --no-index -- <run>/baseline/<document> <document>`, then do the report task of your instructions and save the report body with the write tool to `<run>/report-body.md`. Skip this when round 1 was approved.
2. Run `refine-plan --finish <run>`. It checks the run (no file outside the documents in scope changed since `--start`, every round has its `--check` and a review with a verdict, the round limit held, nothing changed after the last review, the `## 验收命令` block still parses) and writes `<milestone-directory>/refine-report.md` with the result of that check, the rounds, your report body, every `需人工决定` item, the unresolved issues and the full diff. When the check finds problems it exits with code 1 and lists them: do not try to repair the records, report the problems.

Do not commit. Your final response: the outcome the `--finish` command printed, any problems it listed, the report path, and the `需人工决定` items in one line each.
