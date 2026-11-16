# ADR-0004. The bench answers its own gates, in temporary repositories only

Status: accepted · Date: 2026-11-16

## Context

ADR-0001 says that a person starts every task and decides at both gates, and that Warband does not run unattended batches.

The bench (`warband bench`, see `bench/README.md`) has to measure an agent: run a fixed set of tasks through every stage and tell whether a change of skill, model or prompt made it better or worse. A run that stops at the plan gate and again at acceptance measures the person, not the agent. Approving 8 to 9 runs by hand takes as long as reading them, and the answers would differ between runs.

## Decision

The bench answers the gates itself: no answers to the planner's questions, the plan approved, the result accepted. This is a deliberate exception to ADR-0001, with these limits:

- **A person starts it.** `warband bench` lists the tasks and runs, shows the number of model calls to expect (without reworks and at most), and runs nothing until the person answers yes. There is no flag to skip the question.
- **Only temporary repositories, by construction.** The automatic gate (`autoGate` in `src/bench/repo.ts`) accepts only a `BenchRepo`. A `BenchRepo` can only be made by `BenchRepo.create`, which copies a task's `setup/` into a new folder under the system temp folder, makes it a fresh git repository and records it. `autoGate` checks both that record and that the folder is inside the temp folder. No path, option or flag turns a person's project into a `BenchRepo`. `warband run` and the window have no automatic gate.
- **A small set.** The tasks are the folders in `bench/tasks`, eight in v1. Each run starts from a fresh copy and is deleted afterwards. Only its `events.jsonl` is kept, next to the report.
- **No parallelism.** Runs go strictly one at a time. That keeps use of a subscription the way one person would use it (ADR-0001), and keeps timings comparable.
- **The same engine.** The bench calls `runTask` as `warband run` does, with the same stages, checks, protected paths and review. Only the gates and, for the review tasks, scripted stand-ins in the planner and implementer roles differ. The stand-ins are scripted runners and call no model.

## Alternatives

- **A flag on `warband run`, such as `--yes`.** It is one keystroke away from a real project, so it was rejected.
- **The person answers the gates during a bench.** That gives faithful runs, but it is slow, and the answers vary between runs, so the results do not compare.
- **Measure only with the scripted agents of the tests.** That checks Warband, not the agent. The tests do this already.

## Consequences

- A bench run spends real subscription usage: up to 63 model calls for the v1 set with every rework used, about 27 without reworks. The question before the start shows this.
- Because the gates are answered automatically, the bench cannot measure what a person would have rejected. It measures whether verify passes.
- The exception is all in `src/bench/`. A change that lets `autoGate` take any other repository changes this ADR.
