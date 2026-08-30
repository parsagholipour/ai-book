# Operator routes

The older operator API behind the `WEB_PASSWORD` cookie, used by `apps/web`. This is **not** the
product surface — that is `src/mobile/routes/`.

## Ownership is not authorization here

Every handler in this directory calls `requireOperatorActor`. A mobile bearer token is rejected
before any handler runs (`isOperatorOnlyPath` in `src/auth.ts` is the exact complement of
`allowsMobileBearer` in `src/requestAuth.ts`), and that is load-bearing: these handlers scope to
`actor.userId`, so the app's own user would otherwise reach exactly its own books — through routes
that charge nothing. `POST /api/plans/:id/approve` starts a whole book with no credit reservation
and no free-tier image slot, and `GET /api/projects/:id/export/*` sends the file without the
entitlement its `/api/mobile/*` twin takes. The actor's *kind* is the authorization.

`projectAssets.ts` is the one exception and the only file here still calling `resolveProjectActor`:
the mobile serializers hand the app URLs under `/assets/images/` and `/assets/voice/`, so those two
prefixes are a genuinely shared surface.

## Exports

Unlike the mobile export routes — which never render, and queue a repair instead — the operator
routes **do** render inline, through a single-flight helper. The console downloads via a plain link,
where a 404 would just break the download.

## The inline export render

The operator routes still render inline, through a single-flight
helper keyed `projectId:format:contentRevision`: the console downloads via a plain link where a
404 would just break the download. **That inline render publishes exactly the way a compile
does**, and for the same reason — it runs for minutes against a project that is COMPLETE, which
is the one state in which a reader may edit. The revision is in the key because an edit deletes
the compiled files, so the request arriving a moment later found them missing for a *new* reason
and must not be answered from the render already in flight; and the render goes to
`.book-<uuid>.{pdf,epub}` and is renamed onto `book.pdf` only inside `publishRebuiltExport`'s
transaction, which compare-and-sets `contentRevision` and requires COMPLETE or REVIEW_REQUIRED —
the same two statuses a detached compile may publish over, refused for the same reason
(`applyBookEdit` holds the pre-edit revision for as long as it is rewriting pages). Writing
straight to `book.pdf` meant a render that started before an edit could land *after* the worker's
recompile published and leave the book sitting finished with its pre-edit PDF until some later
revision bump rebuilt it. A render that loses the claim publishes nothing and answers with
whatever is on disk now, falling back to its own bytes — a stale download beats a broken link,
but it may not become the book. It also passes `projectId` to `generatePdf`, so the renderer's
file access is scoped to that book's own illustrations as it is in the worker. An unmeasured
rebuild (saved `book.md`, no anchor plan) replaces translatable ranges with a cover-numbering
stub rather than leaving a map from the Contents-reprinted pass — same manuscript is not the
same pagination, but chrome still needs to know whether the CSS skipped the cover.
**The export barrier blocks the revision it names, not every revision, and only an expired
publication lease lets recovery retire it.** The claim also tests the text-edit invalidation
barrier — against *its own* revision, never for emptiness:
`OR: [{ exportInvalidationRevision: null }, { exportInvalidationRevision: { not: contentRevision } }]`.
A text edit commits its new manuscript before deleting the old shared files, and a barrier naming
the revision this rename claims *is* that window, so the inline publisher and the provenance repair
both stand down inside it. A barrier naming any other revision cannot be that window — the revision
CAS beside it pins the row to this one — so it belongs to a tail that died without a redelivery, and
refusing on it would lock the book out of rebuilds until the worker's delayed, lease-aware stranded
sweep retires an abandoned current barrier. Both `OR` arms are load-bearing: Prisma compiles a bare
`{ not: n }` to `"exportInvalidationRevision" <> $1`, which is UNKNOWN — and so excludes the row —
for the null every healthy project has.
