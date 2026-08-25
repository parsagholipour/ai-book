import { creditCostForOperation } from "@book-maker/core";
import { prisma } from "@book-maker/db";
import type { LibraryCharacterModel, Prisma } from "@book-maker/db";
import { libraryMentionInclude } from "@book-maker/db/libraryMentions";
import type { FastifyInstance } from "fastify";
import { contentRestrictedError, copyrightRestrictionsEnabled } from "../../contentRestrictions.js";
import { assertCharacterContentAllowed } from "../characterContentScreen.js";
import {
  LIBRARY_CHARACTER_LIMIT_PER_USER,
  mobileCharacterCreateBodySchema,
  mobileCharacterCreateOpenApiBody,
  mobileCharacterUpdateBodySchema,
  mobileCharacterUpdateOpenApiBody
} from "../characterSchemas.js";
import { fieldsFromJson, serializeLibraryCharacter } from "../characterSerializer.js";
import { deleteLibraryCharacterFile } from "../characterStorage.js";
import { ownedCharacter, portraitClaimIsLive, PORTRAIT_OPEN_STATUSES } from "../characterImageStore.js";
import type { MobileLibraryCharacterDto, MobileLibraryCharacterListDto } from "../dto.js";
import {
  hitAuthenticatedLimit,
  requireMobileAuth,
  sendMobileError,
  sendUnreadableBodyError
} from "../httpErrors.js";
import type { MobileRouteContext } from "../routeContext.js";
import { idParamsSchema, mobileAuthError } from "../schemas.js";
import { replaceLibraryMentions } from "../libraryMentionLinks.js";
import { survivingMentionIds } from "../libraryMentionRows.js";
import {
  rewriteIncomingLibraryMentions,
  unlinkIncomingLibraryMentions
} from "../libraryMentionRewrites.js";
import {
  CharacterDeleteClaimLostError,
  CharacterRowMovedError,
  characterClaimSubject,
  characterRetryTransactionOptions,
  type CharacterTransactionOptions,
  claimCharacterRow,
  sendCharacterEditConflict,
  sendCharacterNotFound,
  sendCharacterWriteBusy,
  sendCharacterWriteError,
  sendPortraitInProgress
} from "../characterWriteConflicts.js";

/**
 * The account-wide character library ("consistent characters"): the record
 * itself — reading the list, creating, editing and deleting one.
 *
 * Every route here is free, and every one of them is about the character's
 * *prose*: the description, its durable `@mentions`, and the sibling
 * descriptions that mention it back. That is what makes this a lane rather than
 * a CRUD file — a write here claims its own row and, on a rename or a delete,
 * up to 99 others, all inside one client budget
 * (`characterWriteConflicts.ts`). The pictures live in `routes/characterImages.ts`
 * and share nothing with it but the row they hang off; the one priced character
 * route is over there too.
 *
 * Characters belong to the user, not to any project — books snapshot them at
 * build time and never hold a foreign key back, so deleting one here cannot
 * break a book.
 */

/**
 * Which portrait job owned the row when a delete's claim came back empty.
 *
 * The two columns and no more, because that is the whole of what
 * `portraitClaimIsLive` asks — and they are read inside the losing transaction
 * rather than taken off the row the request was built from, which is the same
 * rule PATCH follows for the description it writes back: a claim asserts what it
 * names and is evidence about nothing else. `null` is a row that is no longer
 * there to read.
 */
type LostPortraitClaim = Pick<LibraryCharacterModel, "portraitStatus" | "portraitJobId"> | null;

/**
 * One delete attempt: it committed — carrying the retained file names it read
 * under its own lock — or it lost its claim to this.
 */
type DeleteAttempt = { deleted: true; files: string[] } | { deleted: false; found: LostPortraitClaim };

/**
 * One column of the row a PATCH leaves behind: what it will hold, and whether
 * the request asked for it to be written at all.
 *
 * The two are not the same question and the update depends on both. What the
 * screen assesses is the *effective* value — the patch merged onto the row the
 * claim found — while the `update` may only carry the columns the body sent, or
 * a `{name}` PATCH would write the description, the appearance and the fields
 * back over whatever landed from another device in the meantime. Keeping them
 * in one place is what stops the second half from being re-derived: `merged`,
 * `stored` and the `update` data used to spell `body.data.X ?? live.X` three
 * times in three shapes, so a column added to `LibraryCharacter` had to be
 * added to all three — and a value screened but never written, or written but
 * never screened, is exactly what this handler was restructured to prevent.
 */
type PatchedColumn<Value> = { value: Value; sent: boolean };

/**
 * The patch merged onto the row under the claim, one column at a time.
 *
 * **Presence decides, never the value.** Sent-and-empty is a deliberate clear
 * — the appearance the reader just erased — so the caller normalizes what it
 * sends ("" to null) and this only asks whether it sent anything.
 */
function patchedColumn<Value>(sent: Value | undefined, live: Value): PatchedColumn<Value> {
  return sent === undefined ? { value: live, sent: false } : { value: sent, sent: true };
}

/** One PATCH's columns, as the two readings below take them. */
type PatchedColumns = Record<string, PatchedColumn<unknown>>;

/**
 * Every column's effective value: the row the screen assesses.
 *
 * Mechanical on purpose — a column added to the object it is handed reaches
 * this reading and the one below without being named again, which is the whole
 * of what `PatchedColumn` buys. The assertion is `Object.fromEntries`' own: it
 * answers a string-keyed record for a key set the compiler already has, and
 * nothing here narrows a type the caller has not already stated.
 */
function patchedValues<Columns extends PatchedColumns>(
  columns: Columns
): { [Key in keyof Columns]: Columns[Key]["value"] } {
  return Object.fromEntries(
    Object.entries(columns).map(([key, column]) => [key, column.value])
  ) as { [Key in keyof Columns]: Columns[Key]["value"] };
}

/** The same reading minus the columns nothing sent: the row the `update` writes. */
function patchedWrites<Columns extends PatchedColumns>(
  columns: Columns
): Partial<{ [Key in keyof Columns]: Columns[Key]["value"] }> {
  return Object.fromEntries(
    Object.entries(columns).flatMap(([key, column]) => (column.sent ? [[key, column.value]] : []))
  ) as Partial<{ [Key in keyof Columns]: Columns[Key]["value"] }>;
}

export async function registerMobileCharacterRoutes(
  fastify: FastifyInstance,
  context: MobileRouteContext
): Promise<void> {
  const { appConfig } = context;

  fastify.get(
    "/api/mobile/characters",
    { schema: { tags: ["mobile"], response: { 401: mobileAuthError } } },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) {
        return;
      }
      const characters = await prisma.libraryCharacter.findMany({
        where: { userId: auth.user.id },
        include: libraryMentionInclude,
        orderBy: { createdAt: "asc" }
      });
      return {
        characters: characters.map((character) => serializeLibraryCharacter(character)),
        portraitCredits: creditCostForOperation("CHARACTER_PORTRAIT_GENERATION")
      } satisfies MobileLibraryCharacterListDto;
    }
  );

  fastify.post(
    "/api/mobile/characters",
    {
      // The Zod parse below is this body's only gate, and the `errorHandler`
      // covers the one refusal that never reaches it — see
      // `sendUnreadableBodyError`. Both are what the 400 declared underneath
      // costs: without them ajv and the JSON parser answer in Fastify's shape,
      // through a schema that cannot hold it, and a mistyped name comes back a
      // 500. The documented body is still the coercion ajv applies and still
      // the contract `/docs` publishes; it has stopped being the gate.
      attachValidation: true,
      errorHandler: sendUnreadableBodyError,
      schema: {
        tags: ["mobile"],
        body: mobileCharacterCreateOpenApiBody,
        // Every status this handler can actually reach, and only those.
        // fast-json-stringify serializes an answer through the schema its code
        // names, so a status left out is documented at `/docs` as impossible
        // while being served through the default serializer — the same
        // mismatch `contentRestrictedError` exists to close one level down,
        // where an undeclared `reason` was dropped from the body outright. The
        // three writes share one catch (`sendCharacterWriteError`), so the map
        // is read off what *this* handler can throw into that ladder rather
        // than off the ladder's full set of rungs.
        response: {
          201: {},
          // The mention catch below answers 404 for a target that is gone or
          // deleted under the write's own insert, and 400 for a description
          // that no longer holds its `@Name` or for a `LibraryMention` CHECK
          // this side should have caught; 429 is the shared `character-write`
          // bucket, 403 the library cap, and 503 the transaction running out of
          // time — the same answer its siblings give.
          400: mobileAuthError,
          401: mobileAuthError,
          403: mobileAuthError,
          404: mobileAuthError,
          409: mobileAuthError,
          422: contentRestrictedError,
          429: mobileAuthError,
          503: mobileAuthError
        }
      }
    },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) {
        return;
      }
      if (!hitAuthenticatedLimit(context.draftLimiter, request, reply, auth.user.id, "character-write")) {
        return;
      }
      const body = mobileCharacterCreateBodySchema.safeParse(request.body ?? {});
      if (!body.success) {
        return sendMobileError(reply, 400, "VALIDATION_ERROR", "Give the character a name.");
      }
      // Two pool acquisitions that need nothing from each other, so they cost
      // one round trip rather than two: the cap read says whether there is room
      // for another character, and the flag is what both screens below are
      // assessed against — read out here, for the reason PATCH reads it out
      // here, because the screen inside the transaction runs while the new
      // row's lock is held.
      const [count, copyrightRestricted] = await Promise.all([
        prisma.libraryCharacter.count({ where: { userId: auth.user.id } }),
        copyrightRestrictionsEnabled()
      ]);
      try {
        // The prose the reader typed, screened before a row exists to refuse.
        // This is the door nearly every refusal leaves through, and it used to
        // be inside: a body that was never going to be stored opened a
        // transaction, wrote the row and its link set and rolled all of it back
        // — holding the new row's lock for as long as that took. The screen
        // below it is not this one and does not replace it; see there.
        //
        // **In front of the cap, which is the order `sendCharacterWriteError`
        // documents — the refusal first.** Both answers are already in hand
        // above, so the sequence costs nothing and decides only what a request
        // that is *both* is told. Behind the cap, a reader at
        // `LIBRARY_CHARACTER_LIMIT_PER_USER` was answered 403 for prose that
        // was never going to be stored: they deleted a character to make room
        // and only then learned the text was refused, with the `reason`
        // `contentRestrictedError` exists to carry never sent. PATCH screens
        // ahead of its own claim for the same reason.
        assertCharacterContentAllowed(
          {
            name: body.data.name,
            description: body.data.description,
            appearance: body.data.appearance,
            fields: body.data.fields
          },
          copyrightRestricted
        );
        if (count >= LIBRARY_CHARACTER_LIMIT_PER_USER) {
          return sendMobileError(
            reply,
            403,
            "CHARACTER_LIMIT_REACHED",
            `Your library holds up to ${LIBRARY_CHARACTER_LIMIT_PER_USER} characters. Delete one to add another.`
          );
        }
        // Deliberately on Prisma's default ceiling rather than
        // `CHARACTER_MENTION_TRANSACTION_OPTIONS`, which pays for work that
        // grows with the library: PATCH and DELETE claim every character whose
        // description mentions this one — up to 99 — and rewrite the ones that
        // moved. Creation has no such set, because nothing can mention a row
        // that does not exist yet; it writes a fixed handful whatever the
        // library holds — the row, one bounded read of the mentioned ids, the
        // link set, the canonicalized description. A wider window buys that
        // nothing and costs it something, since the ceiling is also how long a
        // stalled attempt keeps its pool connection and the new row's lock. It
        // still needs an answer when it *does* expire, which is the 503 below.
        const character = await prisma.$transaction(async (tx) => {
          const created = await tx.libraryCharacter.create({
            data: {
              userId: auth.user.id,
              name: body.data.name,
              description: body.data.description,
              // Null rather than "": "no appearance recorded" is a state the
              // planner prompt branches on, so it gets one representation.
              appearance: body.data.appearance || null,
              fields: body.data.fields
            }
          });
          // The links this create writes, and the prose to store beside them —
          // both in hand, so nothing reads the row back to serialize them. See
          // `ReplacedLibraryMentions`.
          const links = body.data.mentionedCharacterIds.length
            ? await replaceLibraryMentions(tx, {
                sourceCharacterId: created.id,
                userId: auth.user.id,
                description: body.data.description,
                mentionedCharacterIds: body.data.mentionedCharacterIds,
                // `created.id` is a cuid this statement minted and this
                // transaction has not committed, so nothing anywhere can hold a
                // link to it. The "did these links already move" read that
                // spares PATCH a `deleteMany`/`createMany` pair therefore
                // answers empty here every time, from inside the transaction
                // holding the new row's lock.
                sourceCreatedInThisTransaction: true
              })
            : null;
          const description = links?.description ?? body.data.description;
          // The row as it stands after the create, and after the canonicalized
          // prose lands over it — `update` hands back what it wrote, which is
          // the whole of what the reload used to be for.
          let stored = created;
          if (description !== body.data.description) {
            // The string that actually lands, screened where it is produced.
            // `replaceLibraryMentions` respells every claimed `@name` to its
            // target's own spelling, so this is not the prose the door above
            // read — respelled in *case* alone today, which case-blind rules
            // cannot tell apart, and that is exactly why the ordering is pinned
            // by the string screened rather than by the verdict
            // (`characterContentScreen.test.ts`). A rule that stops being
            // case-blind, or a canonicalization that stops being case-only,
            // changes the answer here and nowhere else; the rollback is what
            // keeps such a refusal from leaving half a character behind. Where
            // the two strings are equal there is nothing here the door has not
            // already read, which is every create that mentions nobody.
            assertCharacterContentAllowed(
              { name: body.data.name, description, appearance: body.data.appearance, fields: body.data.fields },
              copyrightRestricted
            );
            stored = await tx.libraryCharacter.update({ where: { id: created.id }, data: { description } });
          }
          return { ...stored, outgoingMentions: links?.mentions ?? [] };
        });
        return reply.code(201).send({ character: serializeLibraryCharacter(character) satisfies MobileLibraryCharacterDto });
      } catch (error) {
        // One ladder for all three writes — a refusal arrives as a throw so the
        // row and the links written above it roll back with it, and everything
        // else this transaction can hand back is answered exactly as PATCH and
        // DELETE answer it. See `sendCharacterWriteError`.
        if (sendCharacterWriteError(reply, error)) {
          return;
        }
        throw error;
      }
    }
  );

  fastify.patch(
    "/api/mobile/characters/:id",
    {
      // Both for the reason create sets them.
      attachValidation: true,
      errorHandler: sendUnreadableBodyError,
      schema: {
        tags: ["mobile"],
        body: mobileCharacterUpdateOpenApiBody,
        // Create's set minus the 403 only the library cap gives: a PATCH adds
        // no character. 429 is the same `character-write` bucket all three
        // writes are rationed on, and it was undeclared on every one of them.
        response: {
          400: mobileAuthError,
          401: mobileAuthError,
          404: mobileAuthError,
          409: mobileAuthError,
          422: contentRestrictedError,
          429: mobileAuthError,
          503: mobileAuthError
        }
      }
    },
    async (request, reply) => {
      // The whole request answers inside one client budget, so the clock starts
      // before the first thing that can wait on the pool — which is the session
      // read, not the character read. Taken after `requireMobileAuth`, a request
      // that spent seconds on its `MobileSession` lookup handed
      // `characterRetryTransactionOptions` an elapsed of ~0 and opened the full
      // ceiling behind it: the `CHARACTER_EDIT_BUSY` that ceiling exists to
      // leave room for was written past the app's 20 s receive timeout, to a
      // device that had already given up with a bare network error.
      const laneStartedAt = Date.now();
      const auth = await requireMobileAuth(request, reply);
      if (!auth) {
        return;
      }
      if (!hitAuthenticatedLimit(context.draftLimiter, request, reply, auth.user.id, "character-write")) {
        return;
      }
      const { id } = idParamsSchema.parse(request.params);
      const body = mobileCharacterUpdateBodySchema.safeParse(request.body ?? {});
      if (!body.success) {
        return sendMobileError(reply, 400, "VALIDATION_ERROR", "Send at least one change.");
      }
      // Two pool acquisitions that need nothing from each other, and both are
      // spent out of the one budget the transaction below is then sized from —
      // so they are one round trip rather than two waits for a connection under
      // exactly the pressure that makes waiting expensive.
      const [character, copyrightRestricted] = await Promise.all([
        // The id and the name, because that is all this read is still for — see
        // `characterClaimSubject`.
        characterClaimSubject(id, auth.user.id),
        // Read out here because the screen runs inside the transaction:
        // assessing is synchronous, but the flag behind it is a query on
        // another pool connection — the last thing to want while holding up to
        // 99 row locks.
        copyrightRestrictionsEnabled()
      ]);
      if (!character) {
        return sendCharacterNotFound(reply);
      }
      // What the two reads above left of the client budget. Null is a window
      // too small for a claim and a rewrite to commit in, and the honest answer
      // to that is the 503 now rather than a transaction that cannot finish and
      // a reply the device has stopped listening for — see
      // `characterRetryTransactionOptions`.
      const patchOptions = characterRetryTransactionOptions(Date.now() - laneStartedAt);
      if (!patchOptions) {
        return sendCharacterWriteBusy(reply);
      }
      try {
        // What the request itself carries, screened before a single row is
        // claimed. This whole screen used to live inside the transaction, below
        // `rewriteIncomingLibraryMentions` and `replaceLibraryMentions` — so an
        // edit that was always going to be refused first claimed up to 99
        // sibling rows, rewrote the ones that moved, and rolled every one of
        // them back, holding every other character write on the account behind
        // its lock window for the length of it. The screen below still runs and
        // still has to: it is the only one that ever sees a
        // `{mentionedCharacterIds}` PATCH's stored prose, which this request
        // never carried. `name` is the row's current one where the body sends
        // none, because that is the name the update writes back.
        assertCharacterContentAllowed(
          {
            name: body.data.name ?? character.name,
            description: body.data.description ?? "",
            appearance: body.data.appearance,
            fields: body.data.fields ?? []
          },
          copyrightRestricted
        );
        // Accepting the suggestion, rewriting it, and turning it down all
        // retire it: it describes a description the user has now settled, and
        // an offer that survives being taken is offered forever.
        const clearsSuggestion = body.data.description !== undefined || body.data.dismissSuggestion === true;
        const updated = await prisma.$transaction(async (tx) => {
          // Before a single sibling description is touched: this is both the
          // lock every write below runs under and the proof that `@Luna` is
          // still what those descriptions say. A rename that landed since
          // `characterClaimSubject` read it would make the rewrite match nothing
          // and strand its markers — see `claimCharacterRow`.
          if (!(await claimCharacterRow(tx, { id: character.id, userId: auth.user.id, name: character.name }))) {
            throw new CharacterRowMovedError();
          }
          // The row as the claim found it, for the same reason
          // `claimedMentionSources` re-reads every sibling it rewrites: the claim
          // asserts the *name* and nothing else, so a description saved on
          // another device between the read above and this lock is still there.
          // Every field the request did not send is written back from what this
          // read found — driving them from the outer snapshot reverted that
          // save, prose and links together, under a claim that had succeeded.
          const live = await tx.libraryCharacter.findFirst({
            where: { id: character.id, userId: auth.user.id },
            include: libraryMentionInclude
          });
          // Narrowing rather than a guard: the claim locked this row, and this
          // predicate is a subset of the one it matched — see `claimCharacterRow`.
          if (!live) throw new Error("The claimed character row could not be re-read.");
          // The row the update is about to leave behind, as the claim found it
          // merged with what the request sends — screened here, which is the
          // first line where it can be read and the last one before it costs
          // anything to refuse.
          //
          // *Under the claim*, because `live` is the only place a description
          // saved on another device is legible at all, and that prose is the
          // whole reason a second screen exists. *Before*
          // `rewriteIncomingLibraryMentions`, because held below it a refusal
          // first claimed every character whose description mentions this one —
          // up to 99 — rewrote the ones whose `@OldName` moved, replaced the
          // link set, and rolled all of it back, with every other character
          // write on the account queued behind that lock window for a request
          // that was never going to be stored. That is the exact cost the door
          // in front of the transaction was moved out to avoid, paid over again
          // by the requests the door cannot answer.
          //
          // It also fixes the order `sendCharacterWriteError` documents — the
          // refusal first: a rename that is both refused here *and* too long for
          // a sibling's description used to answer the 409 the rewrite raised on
          // the way past it.
          //
          // **One decision per column, and both readers derive from it.** The
          // screen wants the effective value and the `update` wants only the
          // columns the body sent, so a `PatchedColumn` carries both and
          // `patchedValues`/`patchedWrites` are the two readings — see
          // `PatchedColumn`. Sent-and-empty is a deliberate clear, which is why
          // the appearance normalizes its own "" to null on the way in and
          // presence alone decides the write.
          const next = {
            name: patchedColumn(body.data.name, live.name),
            description: patchedColumn(body.data.description, live.description),
            appearance: patchedColumn(
              body.data.appearance === undefined ? undefined : body.data.appearance || null,
              live.appearance
            ),
            fields: patchedColumn(body.data.fields, fieldsFromJson(live.fields))
          };
          const merged = patchedValues(next);
          assertCharacterContentAllowed(merged, copyrightRestricted);
          await rewriteIncomingLibraryMentions(tx, character.id, live.name, merged.name);

          const requestedMentionIds = body.data.mentionedCharacterIds ??
            (next.description.sent ? survivingMentionIds(merged.description, live) : null);
          // The link set this save owns afterwards, in hand rather than read
          // back: a PATCH that touches no link keeps the rows the claim found,
          // and one that does keeps the rows it just wrote. See
          // `ReplacedLibraryMentions`.
          const links = requestedMentionIds
            ? await replaceLibraryMentions(tx, {
                sourceCharacterId: character.id,
                userId: auth.user.id,
                description: merged.description,
                mentionedCharacterIds: requestedMentionIds
              })
            : null;
          // The row that actually lands: the merge above with the canonicalized
          // prose over it, where there is one. **The column's decision is
          // retaken rather than inherited**, because a canonicalization is a
          // write the body did not ask for — a `{mentionedCharacterIds}` PATCH
          // carries no description of its own and still stores one — and the
          // same two readings then answer for the screen and for the `update`.
          //
          // Screened where it is produced, for the reason create screens its
          // own: `replaceLibraryMentions` respells every claimed `@name` to its
          // target's own spelling, so this is not the prose the screen above
          // read — respelled in *case* alone today, which case-blind rules
          // cannot tell apart, and that is exactly why the ordering is pinned
          // by the string screened rather than by the verdict
          // (`characterContentScreen.test.ts`). Where the two are equal there is
          // nothing here the screen above has not already read, which is every
          // PATCH that rewrites no `@name`.
          const written = { ...next, description: patchedColumn(links?.description, merged.description) };
          const stored = patchedValues(written);
          if (stored.description !== merged.description) {
            assertCharacterContentAllowed(stored, copyrightRestricted);
          }
          const row = await tx.libraryCharacter.update({
            where: { id: character.id },
            data: {
              ...patchedWrites(written),
              ...(clearsSuggestion ? { suggestedDescription: null } : {})
            }
          });
          return { ...row, outgoingMentions: links?.mentions ?? live.outgoingMentions };
        }, patchOptions);
        return { character: serializeLibraryCharacter(updated) satisfies MobileLibraryCharacterDto };
      } catch (error) {
        if (sendCharacterWriteError(reply, error)) {
          return;
        }
        throw error;
      }
    }
  );

  fastify.delete(
    "/api/mobile/characters/:id",
    {
      schema: {
        tags: ["mobile"],
        // Narrower than its two siblings on purpose. This handler shares their
        // catch, so `sendCharacterWriteError` can answer 400 and 422 from
        // here — but only for throws this transaction cannot produce: it
        // screens no content (`ContentRestrictedError` is the 422) and writes
        // no `LibraryMention` row at all, so neither `LibraryMentionError` nor
        // a mention CHECK violation (the two 400s) has a statement to come out
        // of. `unlinkIncomingLibraryMentions` only rewrites sibling
        // descriptions and the cascade takes the rows. Declaring a refusal the
        // route cannot give is the same lie as omitting one it can, so the day
        // a mention write lands in this lane, both come back.
        // 429 is the `character-write` bucket this route shares with POST and
        // PATCH, and the one status all three were missing.
        response: {
          401: mobileAuthError,
          404: mobileAuthError,
          409: mobileAuthError,
          429: mobileAuthError,
          503: mobileAuthError
        }
      }
    },
    async (request, reply) => {
      // Before the session read, for the reason PATCH starts its clock there:
      // every read here and both delete attempts answer inside one client
      // budget (`characterRetryTransactionOptions`), and `requireMobileAuth` is
      // itself a pool acquisition under the pressure that budget is sized for.
      const laneStartedAt = Date.now();
      const auth = await requireMobileAuth(request, reply);
      if (!auth) {
        return;
      }
      // Where POST and PATCH take theirs — before the owner read — and for the
      // reason they take one at all. This is the most expensive write in the
      // group and was once the only one with no ceiling: one token can loop it
      // against a well-connected character and get `ownedCharacter` and then up
      // to *two* transactions per request, each claiming the row plus every
      // character whose description mentions it — up to
      // `LIBRARY_CHARACTER_LIMIT_PER_USER - 1` — and rewriting every one this
      // name is stripped out of, holding those locks for as much of the budget
      // as `characterRetryTransactionOptions` still has to hand out, with every
      // other character write on the account queued behind them.
      //
      // Its own bucket, though, not the `character-write` one the other four
      // spend. Emptying a full library is a hundred confirmed taps against a
      // ceiling of 120 sized for drafting, so the edits and promotes either side
      // of a cleanup answered 429 — on a destructive gesture, with the character
      // screen unable to say why some rows went and some did not. Why a delete
      // can be given a wider ceiling than the writes it used to share one with
      // is argued at `DEFAULT_CHARACTER_DELETE_RATE_LIMIT`.
      if (!hitAuthenticatedLimit(context.characterDeleteLimiter, request, reply, auth.user.id, "character-delete")) {
        return;
      }
      const { id } = idParamsSchema.parse(request.params);
      const character = await ownedCharacter(id, auth.user.id);
      if (!character) {
        return sendCharacterNotFound(reply);
      }
      // The conditional claim is the real guard, and it carries both halves:
      // the worker owns the row while a portrait is in flight and must find it
      // when it finishes, and the strip below is an exact-token match on the
      // name this claim re-asserts. It runs *before* the sibling descriptions
      // rather than after them, which is the lock order PATCH takes too.
      const deleteCharacter = async (
        portraitGuard: Prisma.LibraryCharacterWhereInput,
        options: CharacterTransactionOptions
      ): Promise<DeleteAttempt> => {
        try {
          return await prisma.$transaction(async (tx): Promise<DeleteAttempt> => {
            const claimed = await claimCharacterRow(tx, {
              id: character.id,
              userId: auth.user.id,
              name: character.name,
              where: portraitGuard
            });
            if (!claimed) {
              // Which half of the claim failed decides the answer, so the row
              // is read rather than assumed: a portrait in flight is the escape
              // hatch below, a row that is gone is the 404 this has always
              // given, and a rename under us is a conflict worth retrying.
              //
              // **The portrait columns come back with the name**, and the
              // caller is handed them rather than reading the row it was built
              // from — the delete's copy of the rule PATCH keeps for the prose
              // it writes back. `ownedCharacter` runs before the transaction
              // opens and behind whatever the pool made the session read wait
              // for, so a Redraw tapped on another device in that window leaves
              // it saying READY with no job on it. Asked of *that*, the question
              // answered "stale claim" without ever looking at the job now
              // holding the row, the second attempt dropped the guard, and the
              // character went out from under a portrait that was still being
              // drawn — the one answer this two-attempt lane exists to give,
              // never given.
              //
              // It **returns** where the throw below is a throw, and the
              // difference is what each has written: this branch matched no row
              // and issued nothing, so there is nothing for an unwind to take
              // back and an exception would only be carrying a value.
              const current = await tx.libraryCharacter.findFirst({
                where: { id: character.id, userId: auth.user.id },
                select: { name: true, portraitStatus: true, portraitJobId: true }
              });
              if (current && current.name !== character.name) throw new CharacterRowMovedError();
              return { deleted: false, found: current };
            }
            await unlinkIncomingLibraryMentions(tx, character.id, character.name);
            // Every retained file's name, read here and nowhere earlier. The
            // cascade takes these rows with the character and nothing sweeps
            // that tree, so a name missed here is bytes no route, no prune and
            // no sweep can reach again — and this lane used to read them before
            // the transaction opened, which is a window `PUT /:id/photo` fits
            // inside whole: it inserts its version row and writes its file,
            // finds the character still there on its own closing read, and the
            // delete then cascades a row whose file it never learned the name
            // of. That upload closes the other half of the same race, where the
            // delete commits first and its read comes back empty; this is the
            // half that lives here.
            //
            // Under the `FOR UPDATE` `unlinkIncomingLibraryMentions` has just
            // taken on this row, which is what makes the read exact rather than
            // merely later: an insert's own foreign key check takes
            // `FOR KEY SHARE` on the parent, so a version row already committed
            // is visible to this statement and one still coming waits for this
            // transaction to end — and then meets a parent that is gone, which
            // is the 404 that upload already answers.
            //
            // Through `tx` rather than `loadCharacterImages`, which would be a
            // second pool connection taken while this lock is held, for an
            // ordering nothing here has any use for: what is wanted is a set of
            // names.
            const retained = await tx.libraryCharacterImage.findMany({
              where: { characterId: character.id, userId: auth.user.id },
              select: { fileName: true }
            });
            const deleted = await tx.libraryCharacter.deleteMany({
              where: { id: character.id, userId: auth.user.id }
            });
            // Every sibling description this attempt just rewrote has to go
            // back with it, which is why this one throws. It also has nothing
            // to report: the row the claim was holding is gone, so there is no
            // portrait claim left to ask about.
            if (deleted.count !== 1) throw new CharacterDeleteClaimLostError();
            return { deleted: true, files: retained.map((image) => image.fileName) };
          }, options);
        } catch (error) {
          if (error instanceof CharacterDeleteClaimLostError) return { deleted: false, found: null };
          throw error;
        }
      };
      let retainedFiles: readonly string[] = [];
      try {
        const firstOptions = characterRetryTransactionOptions(Date.now() - laneStartedAt);
        if (!firstOptions) {
          return sendCharacterWriteBusy(reply);
        }
        const claim = await deleteCharacter(
          { portraitStatus: { notIn: [...PORTRAIT_OPEN_STATUSES] } },
          firstOptions
        );
        retainedFiles = claim.deleted ? claim.files : retainedFiles;
        if (!claim.deleted) {
          // A claim can outlive its job: a worker killed hard never runs its
          // failure path, and nothing else resets an account-level row. When the
          // backing job is no longer open the claim is stale, and delete is the
          // user's escape hatch rather than a wedge.
          //
          // Asked of the two columns the lost claim itself read. The snapshot is
          // spread underneath them only to make the row shape the question
          // takes; nothing else of it is looked at.
          if (claim.found && (await portraitClaimIsLive({ ...character, ...claim.found }))) {
            return sendPortraitInProgress(reply);
          }
          // The retry drops the status guard and pins the claim it was just told
          // is dead. `portraitJobId` is that claim's identity — it is written
          // only where a portrait is enqueued and cleared nowhere, so a row
          // still naming that job is the row the question was answered about,
          // whatever its status has moved to since, and a row naming another one
          // has been claimed again since the answer. Unpinned, this is a second
          // window a Redraw can start inside, and it takes the character out
          // from under the new job exactly as the stale snapshot did. A `found`
          // of null is the row having gone, which pins nothing because there is
          // nothing left to pin: the retry finds no row and answers the 404.
          // What the first attempt and the liveness question left. Null here is
          // the case the floor used to overrun: an attempt that spent its whole
          // window leaves too little for a second one to commit in, and opening
          // it anyway put the answer past the receive timeout — so the 503 goes
          // now, while there is still someone to read it.
          const retryOptions = characterRetryTransactionOptions(Date.now() - laneStartedAt);
          if (!retryOptions) {
            return sendCharacterWriteBusy(reply);
          }
          const retry = await deleteCharacter(
            claim.found ? { portraitJobId: claim.found.portraitJobId } : {},
            retryOptions
          );
          if (!retry.deleted) {
            // Still there, and the claim moved again under the pin — a Redraw
            // landing between the two attempts is what that looks like. The
            // reader re-sends this; it is not a character that is gone, and
            // saying so would be the one sentence they cannot act on.
            if (retry.found) {
              return sendCharacterEditConflict(reply);
            }
            return sendCharacterNotFound(reply);
          }
          retainedFiles = retry.files;
        }
      } catch (error) {
        if (sendCharacterWriteError(reply, error)) {
          return;
        }
        throw error;
      }
      // One round of I/O, not a dozen. The row is committed and gone, so every
      // name here is independent and every unlink is idempotent and cannot
      // reject — `deleteLibraryCharacterFile` resolves an unsafe handle to
      // nothing and swallows `rm --force`'s own failure — which is what makes
      // `Promise.all` the right shape and a settled-per-file walk unnecessary.
      // Awaited one at a time it was a sequential round trip per retained
      // version on a possibly bind-mounted `IMAGE_STORAGE_DIR`, and a character
      // at the retention limit leaves the whole history plus both pointers.
      // None of that is inside the window `characterRetryTransactionOptions`
      // hands the two transactions, and `CHARACTER_WRITE_RESERVE_MS` holds back
      // 2 s for the reply and the liveness question and nothing for this — so a
      // lane that spent its budget and then met slow storage answered past the
      // app's 20 s receive timeout, and the reader saw a bare network error for
      // a delete that had already committed.
      //
      // The two pointers ride along belt-and-braces: one can name a file whose
      // row was lost to a crash between `recordCharacterImage`'s two writes, and
      // the cascade has already taken the rows that would otherwise have named
      // it.
      await Promise.all(
        [...retainedFiles, character.photoPath, character.portraitPath].map((fileName) =>
          deleteLibraryCharacterFile(appConfig.IMAGE_STORAGE_DIR, auth.user.id, fileName)
        )
      );
      return { deleted: true };
    }
  );
}
