# Agent Runbook

Use this runbook for every phase in this folder.

## First Actions

1. Read this file.
2. Read `README.md`.
3. Read the current phase file.
4. Run `git status --short`.
5. Explore the relevant repo code before editing.
6. Make a short implementation plan.
7. Implement only the current phase.
8. Run the validation commands listed in the phase.
9. Leave concise handoff notes for the next phase if anything changes.

## Repository Rules

- Keep all work in this repository.
- Put the Flutter app in `apps/mobile`.
- Keep backend services in TypeScript.
- Keep shared backend logic in the current package style.
- Prefer extending existing API, worker, Prisma, and core patterns over adding new frameworks.
- Do not add a second backend unless a later human decision explicitly changes the architecture.

## Product Rules

- Optimize first for a realistic USD 1,000/month product.
- Make mobile UX simple and buyer-focused.
- Hide technical AI controls from normal users.
- Use product presets instead of raw model/provider settings.
- Do not sell unlimited usage.
- Assume AI provider cost is a core product constraint.

## Safety And Compliance Rules

- Backend must enforce ownership, credits, entitlements, safety, and asset access.
- Flutter must never be the only place where paid access or safety is enforced.
- Generated content needs report/flag paths before public launch.
- Avoid child-directed launch positioning until a dedicated child-safety review is complete.
- Keep public wording focused on supported book categories and creation outcomes.

## Phase Completion Standard

A phase is complete only when:

- Its acceptance criteria are met.
- Its listed validation commands have been run, or failures are documented.
- The next phase can begin without guessing about unfinished decisions.
- Any changed assumptions are written in this folder.

## Suggested Handoff Note Format

At the end of a phase, update or create a small note in this folder only if useful:

```md
# Phase XX Output Notes

## Completed

- ...

## Decisions

- ...

## Known Follow-Ups

- ...

## Validation

- ...
```
