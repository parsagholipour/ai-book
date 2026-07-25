# API

Fastify. Validates requests, reads/writes Postgres, enqueues jobs. It must not call AI providers
for anything long-running — that belongs in the worker.

The short-lived exceptions are deliberate and time-boxed: creation-chat turns and the book advisor
call a fast model inline with an explicit timeout (see `mobile/creationBuild.ts` and
`mobileCreation.ts`). Anything that can take more than a few seconds gets a job.

## Route surfaces

- `src/mobile/routes/` — `/api/mobile/*`, used by the Flutter app. This is the product surface.
- `src/routes/projects.ts` — the older operator API behind `WEB_PASSWORD`, used by `apps/web`.

`src/mobileProjects.ts` is the composition root: it builds one `MobileRouteContext` and calls each
`registerMobile*Routes(fastify, context)` in turn. They run on the same Fastify instance rather
than through `fastify.register`, so they share one encapsulation context — the `application/octet-stream`
parser registered there covers the attachment upload routes. Moving to `register` would break that.

## Adding a mobile route

1. Put the handler in the matching group under `src/mobile/routes/`, or add a group and call it
   from `mobileProjects.ts`.
2. Body validation: a Zod schema in `src/mobile/schemas.ts`. If the route is documented, add the
   parallel JSON-schema fragment there too — Fastify's OpenAPI output uses that copy, so the two
   drift unless changed together.
3. Response shape: a DTO type in `src/mobile/dto.ts`, returned with `satisfies`.
4. Auth: `requireMobileAuth(request, reply)` and bail when it returns null.
5. Anything priced goes through the credit reserve/commit/refund flow in `@book-maker/db/billing`.

## Serializers are the API contract

`src/mobile/projectSerializers.ts` decides what the app sees. Provider names, model ids, raw queue
state and internal error text stay out of mobile responses — the `serialize*` functions there, and
`sanitizePublicChatMetadata` in `src/mobile/projectChat.ts`, exist to enforce that. Widen them
deliberately, not by spreading a row.

## Tests

`src/mobile/*.test.ts` share `src/mobile/testing/mobileApiHarness.ts`. Add fixtures and record
factories there rather than duplicating them per suite.

`src/mobile/testing/mobileApiMocks.ts` must import only `vitest`. Its factories run inside
`vi.mock(...)`, so importing anything that transitively reaches a mocked module deadlocks the
suite — it hangs rather than failing, which is slow to diagnose.
