import type { FastifyBaseLogger, FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import {
  PAGE_REVIEW_PROMPT_MODES,
  PAGE_REVIEW_PROMPT_MODE_DEFAULTS,
  QUALITY_EFFORT_TIERS,
  QUALITY_FEATURE_DEFAULTS,
  QUALITY_FEATURE_IDS,
  GENERATION_PIPELINE_STAGES,
  PLANNING_STAGES,
  QUALITY_FEATURES,
  autoStrategyRoutingMatrix,
  bookGenerationStrategies,
  pipelineForStrategy,
  type BookGenerationStrategy,
  compiledGenerationTextModelRouting,
  generationTextModelOptions,
  loadConfig,
  parsePageReviewPromptModes,
  parseQualityFeatureSettings,
  resolveGenerationTextModelRouting,
  type GenerationTextModelOption,
  type GenerationTextModelRouting,
  type QualityEffortTier,
  type PageReviewPromptMode,
  type QualityFeatureSettings
} from "@book-maker/core";
import { prisma, type Prisma } from "@book-maker/db";
import { z } from "zod";
import { requireOperatorActor } from "../requestAuth.js";
import {
  GenerationModelSelectionError,
  generationModelsPatchOpenApi,
  generationModelsPatchSchema,
  mergeGenerationModelPatch,
  resetGenerationModels,
  unknownGenerationModelPaths,
  type GenerationModelsPatch
} from "./adminGenerationQualityModels.js";

/**
 * Derived from `QUALITY_EFFORT_TIERS`, for the reason the feature ids below are.
 * Zod takes a `readonly string[]` here, so the compiled tuple goes in whole and
 * its union comes back out — no second list, and no cast anyone has to keep
 * honest against one. Spelled
 * by hand, a fifth tier compiled everywhere that would have caught it
 * (`QUALITY_FEATURE_DEFAULTS` is an exhaustive Record, the OpenAPI copy spreads
 * the tuple, the console maps over it), and only this enum still said four — so
 * every PATCH carrying the new tier failed `safeParse` and every save from the
 * console 400'd.
 */
const effortTierSchema = z.enum(QUALITY_EFFORT_TIERS);
const featureTiersSchema = z.array(effortTierSchema).optional();
const pageReviewPromptModeSchema = z.enum(PAGE_REVIEW_PROMPT_MODES);
type PageReviewPromptModePatch = {
  [K in QualityEffortTier]?: PageReviewPromptMode | undefined;
};
const pageReviewPromptModesPatchSchema = z
  .object(
    Object.fromEntries(
      QUALITY_EFFORT_TIERS.map((tier) => [tier, pageReviewPromptModeSchema.optional()])
    ) as Record<QualityEffortTier, z.ZodOptional<typeof pageReviewPromptModeSchema>>
  )
  .strict()
  .refine((modes) => Object.keys(modes).length > 0, {
    message: "Name at least one effort tier whose model-page-review prompt mode should change."
  });

/**
 * Derived from `QUALITY_FEATURE_IDS`, like the OpenAPI copy below, because the
 * two halves have to name the same features and only one of them ever errored
 * when they did not. Hand-listed here, a new feature id compiled fine — the
 * compiler checks `QUALITY_FEATURE_DEFAULTS`, an exhaustive Record, and not
 * this — and then every save from the console 400'd.
 *
 * **Every feature key is optional, and that is what makes the deploy order
 * free rather than lockstep.** Deriving the list only closed the direction
 * where this build gains a feature: a required key still 400s the operator
 * whose console bundle — or saved curl — is one release behind and sends ten
 * features to an eleven-feature build, which is the same failure by a different
 * road. So a body names the features it means, `mergeQualityFeatureSettings`
 * lays them over the stored revision, and a feature nobody named keeps exactly
 * what the last save left it. Merging onto the *stored* row is the whole point:
 * `parseQualityFeatureSettings` backfills a missing id from the compiled
 * defaults, which is right for reading a revision written before the feature
 * existed and wrong for a save — it would quietly revert the one box an
 * operator had unchecked from a newer console.
 *
 * `.strict()` is the opposite skew, where an id this build does not know is a
 * typo rather than a setting — and it is not what an operator meets, because
 * Fastify's AJV gets there first: under `additionalProperties: false` it
 * *strips* the unknown key before Zod sees the body. The typo is refused by
 * name in the `preValidation` hook `refuseUnknownBodyKeys` builds below — one
 * per route, and both routes in this file take one — for the one reason that
 * is the last moment the misspelled key still exists. `.strict()` stays
 * underneath it as the schema's own statement, for a `safeParse` that did not
 * arrive through the route.
 */
const qualitySettingsBodySchema = z
  .object(
    Object.fromEntries(QUALITY_FEATURE_IDS.map((id) => [id, featureTiersSchema])) as Record<
      (typeof QUALITY_FEATURE_IDS)[number],
      typeof featureTiersSchema
    >
  )
  .strict();

/**
 * The change note's ceiling, spelled once. Both Zod schemas bound it, both
 * OpenAPI copies publish it, and the refusal below quotes it — an operator who
 * pasted a long note is told the number they have to get under, and there is no
 * second 500 for that sentence to drift away from.
 */
const NOTE_MAX_LENGTH = 500;

/**
 * A save has to claim something, or it is not a save.
 *
 * Optional feature keys are what freed the deploy order, and they also made
 * `{}` a valid body: `mergeQualityFeatureSettings` handed the stored settings
 * straight back and the insert minted version N+1 with a null note — a row the
 * revision history renders exactly like an operator who had moved a box. A
 * saved curl replayed against the wrong environment, or a console that posted
 * its form before it had loaded one, filled that history with no-ops.
 *
 * So a PATCH names at least one feature, or carries a note. It is *refused*
 * rather than absorbed — diffing the merge against the stored revision and
 * skipping the insert would also swallow a save an operator meant, a box
 * toggled and toggled back while reviewing and then saved with a note about it.
 * This table stores no `changed` map the way `CreditPricingRevision` does, so a
 * revision here records that a save happened, by whom and when, and not only
 * what differed; prices are numbers, where equality is unambiguous, and these
 * are lists, where it would be a fresh decision about order and duplicates that
 * nothing else in this file has to make. A 200 that stored nothing also tells a
 * broken client it succeeded, which is how this arrived in the first place.
 *
 * **A note and no features is a real save.** `note` is content on the revision
 * — the GET returns it, the console prints it beside the version — so a body
 * carrying only one is an operator writing down why the settings that stand
 * should stand, which is otherwise unsayable without touching a box. A note
 * blank once trimmed is not one: it stores as `null`, which is the empty body
 * wearing a hat. Zod trims before this runs, so the claim test is the value.
 */
const EMPTY_PATCH_ERROR = "Name at least one generation-quality feature, model role, or a note, to save.";

const patchGenerationQualitySchema = qualitySettingsBodySchema
  .extend({
    pageReviewPromptModes: pageReviewPromptModesPatchSchema.optional(),
    models: generationModelsPatchSchema.optional(),
    note: z.string().trim().max(NOTE_MAX_LENGTH).optional()
  })
  .strict()
  // `[]` is a claim like any other — it is how a feature is switched off — so
  // this is the same presence test the merge makes, never a truthiness one.
  .refine(
    (body) => Boolean(body.note) || body.models !== undefined || body.pageReviewPromptModes !== undefined ||
      QUALITY_FEATURE_IDS.some((id) => body[id] !== undefined),
    { message: EMPTY_PATCH_ERROR }
  );

/**
 * What one PATCH claims. Anything absent is left as the stored revision has it,
 * and a body that claims nothing at all never reaches the merge.
 */
type QualityFeatureAssignments = z.infer<typeof qualitySettingsBodySchema>;

const resetGenerationQualitySchema = z
  .object({
    note: z.string().trim().max(NOTE_MAX_LENGTH).optional()
  })
  .strict();

/**
 * The published contract, and the coercion AJV applies on the way in. It names
 * no `required` for the same reason the Zod twin marks every feature optional —
 * a body may claim one feature or all eleven — and `minProperties` for the
 * reason the Zod twin refuses an empty claim, so the two only ever move
 * together. AJV is the coarser half of the pair: it counts a whitespace-only
 * `note` as a property where Zod trims it to nothing first. That costs nothing,
 * because AJV never gets the last word here — both routes take
 * `attachValidation`, so its verdict is never read and every refusal is
 * `safeParse`'s, or the hook's in front of it. `additionalProperties: false`
 * stays because it is the published truth about an unknown key: the contract
 * says such a key is invalid, and both routes now say so too. What it turns on
 * is intercepted rather than switched off — the strip is also what coerces
 * every *known* key, and `coerceTypes: "array"` is what a scalar tier arrives
 * through.
 */
const patchGenerationQualityOpenApi = {
  type: "object",
  additionalProperties: false,
  minProperties: 1,
  properties: {
    ...Object.fromEntries(
      QUALITY_FEATURE_IDS.map((id) => [
        id,
        { type: "array", items: { type: "string", enum: [...QUALITY_EFFORT_TIERS] } }
      ])
    ),
    pageReviewPromptModes: {
      type: "object",
      additionalProperties: false,
      minProperties: 1,
      properties: Object.fromEntries(
        QUALITY_EFFORT_TIERS.map((tier) => [
          tier,
          { type: "string", enum: [...PAGE_REVIEW_PROMPT_MODES] }
        ])
      )
    },
    models: generationModelsPatchOpenApi,
    note: { type: "string", maxLength: NOTE_MAX_LENGTH }
  }
} as const;

/**
 * The published contract for a reset, and — like the PATCH twin above — a live
 * schema rather than documentation: AJV compiles it, `RESET_BODY_KEYS` is read
 * off its `properties`, and `additionalProperties: false` publishes that an
 * unknown key is invalid while the hook below is what an operator meets for
 * one. A reset restores every compiled default, so the only thing a body may
 * carry is the note saying why it was reset.
 */
const resetGenerationQualityOpenApi = {
  type: "object",
  additionalProperties: false,
  properties: {
    note: { type: "string", maxLength: NOTE_MAX_LENGTH }
  }
} as const;

/**
 * What each route may be sent, read off the schema AJV compiles rather than
 * restated beside it — so each set is literally what survives that route's
 * strip.
 *
 * They are two sets and not one, which is why the hook below is handed a set
 * rather than closing over a list: a reset names no feature at all, so
 * `styleAuditor` is exactly as much a typo there as `styleAudito` is on the
 * PATCH, and a shared union would accept eleven ids on the route that ignores
 * every one of them.
 */
const PATCH_BODY_KEYS: ReadonlySet<string> = new Set(Object.keys(patchGenerationQualityOpenApi.properties));

const RESET_BODY_KEYS: ReadonlySet<string> = new Set(Object.keys(resetGenerationQualityOpenApi.properties));

/**
 * The keys AJV is about to delete, which is only knowable **before** it runs.
 *
 * Optional keys are what makes this necessary rather than tidy. On the pricing
 * route next door the same strip is harmless because its Zod twin `required`s
 * every key: a misspelled one is deleted, the real one is then missing, and the
 * refusal names it. On both routes here every key is optional on purpose, so a
 * stripped key leaves no trace at all.
 *
 * On the PATCH that is `{ styleAudito: ["fast"] }` reaching `safeParse` as `{}`
 * and being answered "Name at least one generation-quality feature, or a note,
 * to save." over a body that named one, and `{ styleAuditor: ["fast"],
 * beatDedupp: [] }` answered 200 with the typo discarded. On the reset it is
 * shorter and worse: `{ not: "tuning the auditor down for the week" }` parses
 * as the empty body that route is *supposed* to take, so the revision was
 * minted with the canned "Reset to compiled defaults" and the operator was told
 * their save had worked while their note was stored nowhere. So the raw body's
 * keys are compared against the ones that route's schema knows while both still
 * exist, and a body naming any other is refused whole.
 *
 * Refused **whole** is the deliberate half. It also catches the skew the other
 * way round — a console bundle one release *ahead* of the replica it posts to,
 * mid-rolling-deploy — where the old answer stored the ten features that
 * replica knew and dropped the eleventh in silence. Nothing lands, the operator
 * is told which key was not understood, and the save is theirs to make again.
 *
 * A body that is not an object at all is nobody's typo: it falls through to
 * `safeParse`, which has words for it.
 */
function unknownBodyKeys(body: unknown, allowed: ReadonlySet<string>): string[] {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return [];
  }
  return Object.keys(body).filter((key) => !allowed.has(key));
}

/**
 * One route's refusal, as the `preValidation` hook that is the only place it
 * can be made.
 *
 * The mechanism is shared and the key set is not, because the two routes take
 * different bodies and the same hole: the PATCH lost a misspelled feature id to
 * the strip, and the reset — which had no hook at all until the same failure
 * was reported against it — lost a misspelled `note`. Copying the closure would
 * have left the next route in this file to be found the same way a third time.
 * The sentence is per route for the same reason the set is: "not a feature this
 * build knows" is the wrong thing to tell someone whose reset carried no
 * feature.
 *
 * `preValidation` runs before AJV, because AJV strips what this reads. The
 * route's `onRequest` operator hook has already run before body parsing reaches
 * this point, so a mobile bearer is refused as an actor before it can learn
 * anything from body validation.
 */
function refuseUnknownBodyKeys(
  allowed: ReadonlySet<string>,
  message: string,
  nestedUnknown: (body: unknown) => string[] = () => []
) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const unknown = [...unknownBodyKeys(request.body, allowed), ...nestedUnknown(request.body)];
    if (unknown.length === 0) {
      return;
    }
    return reply.code(400).send({ error: `${unknown.join(", ")}: ${message}` });
  };
}

function unknownPageReviewPromptModePaths(body: unknown): string[] {
  if (!isJsonObject(body) || !isJsonObject(body.pageReviewPromptModes)) {
    return [];
  }
  const known = new Set<string>(QUALITY_EFFORT_TIERS);
  return Object.keys(body.pageReviewPromptModes)
    .filter((tier) => !known.has(tier))
    .map((tier) => `pageReviewPromptModes.${tier}`);
}

/** Establish the operator context once, before parsing or validating a body. */
async function requireGenerationQualityOperator(request: FastifyRequest, reply: FastifyReply) {
  const actor = await requireOperatorActor(request, reply);
  if (!actor) {
    return reply;
  }
}

type GenerationQualityRecord = {
  version: number;
  settings: unknown;
  note: string | null;
  updatedBy: string | null;
  createdAt: Date;
};

export const adminGenerationQualityRoutes: FastifyPluginAsync = async (fastify) => {
  const appConfig = loadConfig();
  const modelOptions = generationTextModelOptions(appConfig);
  const compiledModels = compiledGenerationTextModelRouting(appConfig, modelOptions);
  fastify.get("/api/admin/generation-quality", {
    onRequest: requireGenerationQualityOperator,
    schema: { tags: ["admin"] }
  }, async () => {
    const current = (await prisma.generationQualityRevision.findFirst({
      orderBy: { version: "desc" }
    })) as GenerationQualityRecord | null;
    return serializeGenerationQuality(current, compiledModels, modelOptions);
  });

  fastify.patch(
    "/api/admin/generation-quality",
    {
      attachValidation: true,
      onRequest: requireGenerationQualityOperator,
      preValidation: refuseUnknownBodyKeys(
        PATCH_BODY_KEYS,
        UNKNOWN_FEATURE_ERROR,
        (body) => [...unknownGenerationModelPaths(body), ...unknownPageReviewPromptModePaths(body)]
      ),
      schema: { tags: ["admin"], body: patchGenerationQualityOpenApi }
    },
    async (request, reply) => {
      const parsed = patchGenerationQualitySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: patchRejectionMessage(parsed.error.issues) });
      }
      const { note, models, pageReviewPromptModes, ...assignments } = parsed.data;
      return withRevisionConflictReply(request, reply, async () => {
        const record = await appendGenerationQualityRevision(request.log, assignments, note, {
          ...(models ? { models } : {}),
          ...(pageReviewPromptModes ? { pageReviewPromptModes } : {}),
          compiledModels,
          modelOptions
        });
        request.log.info(
          { event: "generation_quality.updated", version: record.version },
          "Generation quality settings updated"
        );
        return serializeGenerationQuality(record, compiledModels, modelOptions);
      });
    }
  );

  fastify.post(
    "/api/admin/generation-quality/reset",
    {
      attachValidation: true,
      onRequest: requireGenerationQualityOperator,
      preValidation: refuseUnknownBodyKeys(RESET_BODY_KEYS, UNKNOWN_RESET_FIELD_ERROR),
      schema: { tags: ["admin"], body: resetGenerationQualityOpenApi }
    },
    async (request, reply) => {
      const parsed = resetGenerationQualitySchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: "Send an optional note." });
      }
      return withRevisionConflictReply(request, reply, async () => {
        const record = await appendGenerationQualityRevision(
          request.log,
          cloneDefaults(),
          parsed.data.note?.trim() || "Reset to compiled defaults",
          { resetPageReviewPromptModes: true, compiledModels, modelOptions }
        );
        request.log.info(
          { event: "generation_quality.reset", version: record.version },
          "Generation quality settings reset to compiled defaults"
        );
        return serializeGenerationQuality(record, compiledModels, modelOptions);
      });
    }
  );

  fastify.post(
    "/api/admin/generation-quality/models/reset",
    {
      attachValidation: true,
      onRequest: requireGenerationQualityOperator,
      preValidation: refuseUnknownBodyKeys(RESET_BODY_KEYS, UNKNOWN_RESET_FIELD_ERROR),
      schema: { tags: ["admin"], body: resetGenerationQualityOpenApi }
    },
    async (request, reply) => {
      const parsed = resetGenerationQualitySchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: "Send an optional note." });
      }
      return withRevisionConflictReply(request, reply, async () => {
        const record = await appendGenerationQualityRevision(
          request.log,
          {},
          parsed.data.note?.trim() || "Reset model routing to compiled defaults",
          { resetModels: true, compiledModels, modelOptions }
        );
        request.log.info(
          { event: "generation_quality.models_reset", version: record.version },
          "Generation text model routing reset to compiled defaults"
        );
        return serializeGenerationQuality(record, compiledModels, modelOptions);
      });
    }
  );
};

/**
 * The tier lists themselves are what was refused: a value that is not a list at
 * all, or an entry of one the enum does not know.
 */
const FEATURE_TIERS_ERROR =
  `Send generation-quality features as lists of effort tiers — ${QUALITY_EFFORT_TIERS.join(", ")}.`;

/**
 * An id no key of the PATCH schema matches, sent by that route's hook, which
 * sees it before AJV deletes it. It says the save did not happen because the
 * refusal is whole — a console one release ahead has ten valid features in the
 * same body, and none of them landed — and it points at the GET, which is where
 * the ids this build does know are listed.
 */
const UNKNOWN_FEATURE_ERROR =
  "Not a generation-quality feature this build knows, so nothing was saved. The GET on this route lists the ids it does.";

/**
 * The same refusal on the reset, where the body is one optional field and the
 * PATCH's sentence would be a category error — a reset carries no feature id,
 * so pointing at the list of them explains nothing. It says what a reset does,
 * because that is what makes the note the only thing left to send: an operator
 * who misspelled it is being told their words were the whole body.
 */
const UNKNOWN_RESET_FIELD_ERROR =
  "Not a field the reset takes, so nothing was reset. It restores every compiled default, and an optional note is all it reads.";

const NOTE_TOO_LONG_ERROR = `Keep the change note to ${NOTE_MAX_LENGTH} characters or fewer.`;

/** No `safeParse` failure reaches this; it is what the compiler gets for indexing an array. */
const UNREADABLE_PATCH_ERROR = "That generation-quality save could not be read.";

/**
 * A body that claimed nothing is told so; every other shape failure names the
 * field it was refused for.
 *
 * `field: sentence` is the answer `sendValidationError` gives on the pricing
 * route next door (`adminPricing.ts`), and this body needs it the more of the
 * two: a pricing save is a flat map of integers where every refusal is the same
 * kind of refusal, while one PATCH here carries eleven tier lists *and* a note.
 * One sentence for all of them therefore blamed the wrong thing. A 600-character
 * change note arrives as `too_big` at `["note"]` — the refinement does not run
 * once the shape has failed, so `claimedNothing` is false — and the console
 * printed "Send generation-quality features as lists of effort tiers." over
 * eleven checkbox rows that were every one of them valid, with the single field
 * that was wrong named nowhere.
 *
 * The sentences are written here rather than lifted from Zod, unlike the
 * neighbour's, because these are the shapes an operator actually reaches and
 * Zod's wording names no remedy: "Too big: expected string to have <=500
 * characters" is the number without the field, and "Invalid option: expected
 * one of …" is the tiers without the feature. Anything unforeseen still falls
 * through to exactly the neighbour's answer — the path, then Zod's own message —
 * so a shape nobody predicted is at least not answered with a sentence about
 * tiers.
 *
 * The refinement is tested first, and by `code` as well as by path, because it
 * is not the only issue this schema can raise at the root: `.strict()` reports
 * an unknown key there too, carrying the key it refused in `keys` rather than
 * in the path — the one field name a path-join scheme cannot find. No request
 * reaches that issue, since the `preValidation` hook refuses an unknown key
 * before AJV strips it and long before Zod runs, which is why this has no arm
 * for it: an arm nothing can enter is the shape that made the typo's answer
 * wrong in the first place. Zod's own message names the keys well enough for a
 * caller that reached `safeParse` some other way.
 */
function patchRejectionMessage(issues: readonly z.core.$ZodIssue[]): string {
  const claimedNothing = issues.some((issue) => issue.code === "custom" && issue.path.length === 0);
  if (claimedNothing) {
    return EMPTY_PATCH_ERROR;
  }
  const issue = issues[0];
  if (!issue) {
    return UNREADABLE_PATCH_ERROR;
  }
  // Zod's own renderer, so a nested path reads the way the body an operator
  // sent does: `note`, `styleAuditor`, `styleAuditor[0]`.
  const field = z.core.toDotPath(issue.path);
  // Length is the only note refusal worth its own sentence, and the only one an
  // operator meets: AJV coerces a scalar to a string before Zod sees it, so a
  // wrong-typed note is a body no console builds and reads better as Zod's own
  // "expected string, received object" than as a sentence about the cap.
  if (issue.path[0] === "note" && issue.code === "too_big") {
    return `${field}: ${NOTE_TOO_LONG_ERROR}`;
  }
  if (issue.path[0] === "pageReviewPromptModes") {
    return `${field}: Send each model-page-review prompt mode as normal or compact.`;
  }
  if (isQualityFeatureId(issue.path[0])) {
    // `styleAuditor` when the value is not a list at all, `styleAuditor[0]`
    // when it is a list and one entry of it is not a tier.
    return `${field}: ${FEATURE_TIERS_ERROR}`;
  }
  return field ? `${field}: ${issue.message}` : issue.message;
}

/** A path segment naming one of this build's features — the keys `.strict()` accepts. */
function isQualityFeatureId(segment: PropertyKey | undefined): boolean {
  return typeof segment === "string" && (QUALITY_FEATURE_IDS as readonly string[]).includes(segment);
}

/**
 * One replay, for the reason `PLAN_VERSION_CONFLICT_RETRIES`
 * (`apps/worker/src/generation/pageRestructure.ts`) is one — see below.
 */
const REVISION_CONFLICT_REPLAYS = 1;

/**
 * Two saves claimed the same revision number twice running.
 *
 * `currentVersion` is the newest version this request *saw* — the head its last
 * attempt merged onto — and it is a floor rather than a promise, since whoever
 * won that second race has already written past it.
 *
 * **The remedy the message names is re-sending, not re-deciding.** A PATCH
 * carries only the features it actually changed, so the body this refused is
 * still the right body for the newer head — `mergeQualityFeatureSettings` lays
 * it over whatever the winner stored and both operators keep their work, which
 * is the whole reason the feature keys are optional. Saying "reload" named a
 * step only a browser can take, and understated that: the console rebases its
 * untouched gates onto the head itself and asks for one more press, while a
 * curl has nothing to reload and needs only to send the same body again.
 * `currentVersion` rides along as a strict lower bound — the head is at least
 * one past it — so a client can say what it merged onto without claiming to
 * know what is stored now.
 */
class GenerationQualityVersionConflictError extends Error {
  readonly currentVersion: number;

  constructor(currentVersion: number) {
    super("Another operator saved generation-quality settings first. Re-send your change to merge it onto the stored revision.");
    this.name = "GenerationQualityVersionConflictError";
    this.currentVersion = currentVersion;
  }
}

/**
 * The version number is claimed by the insert rather than held by a lock, and a
 * save that loses the claim is **re-merged** onto the winner's revision.
 *
 * This used to be a `findFirst` and a `create` inside one `prisma.$transaction`,
 * described as a read "inside the lock". There was no lock: under READ COMMITTED
 * a plain `SELECT` takes none, so two operators saving different boxes within
 * the same second both read version 7, both computed 8, and the second insert
 * met `GenerationQualityRevision.version`'s `Int @unique` and came back `P2002`.
 * Nothing caught it, so that operator got a bare 500 and their unchecked box was
 * silently never stored. The transaction bought nothing it was credited with —
 * it wrapped a single insert, which is atomic on its own.
 *
 * `SELECT … FOR UPDATE` is not the fix on its own either: on a fresh install
 * there is no head row to lock, so the first two saves a deployment ever takes
 * would race exactly as before. What settles it is the unique index doing the
 * refusing — the loser wrote nothing — and this replaying underneath it: a new
 * head read, the body merged onto **that** revision, an insert numbered past it.
 * Replay, not retry: the first attempt's settings were computed against version
 * 7, and reinserting them at 9 would erase the box the winner had just
 * unchecked. That is the lost update `mergeQualityFeatureSettings` exists to
 * prevent, arriving one number later.
 *
 * The shape is the one `nextPlanVersion`'s callers take. `applyStructuralPageChange`
 * (`apps/worker/src/generation/pageRestructure.ts`) takes its whole shift again
 * on `PlanVersion`'s `@@unique([projectId, version])`, and `saveCreditPricing`
 * (`packages/db/src/creditPricing.ts`) re-reads the head and re-diffs for the
 * pricing revision table the console renders next door. One replay, like both of
 * them: a second conflict means saves are arriving faster than this table can
 * number them, and the 409 that answers it tells the operator to reload — which
 * they have to do regardless, their console now being two versions behind.
 *
 * The conflict test is a bare `P2002`, not one narrowed to the `version` index
 * the way `isPlanVersionNumberConflict` is. That predicate guards a transaction
 * that also writes pages and chapters, whose own unique indexes a replay cannot
 * repair; this writes one row to one table, and its only other unique index is
 * the cuid `id`, for which taking the read and the insert again is equally the
 * right answer. Like that predicate it reads the error's own `code` rather than
 * asking `instanceof Prisma.PrismaClientKnownRequestError`, so a failure that is
 * anything else — a dropped connection, a timeout — answers "no" without
 * depending on the class it was handed.
 */
async function appendGenerationQualityRevision(
  log: FastifyBaseLogger,
  assignments: QualityFeatureAssignments,
  note: string | undefined,
  modelChange: {
    models?: GenerationModelsPatch | undefined;
    pageReviewPromptModes?: PageReviewPromptModePatch | undefined;
    resetPageReviewPromptModes?: boolean | undefined;
    resetModels?: boolean | undefined;
    compiledModels: GenerationTextModelRouting;
    modelOptions: readonly GenerationTextModelOption[];
  }
): Promise<GenerationQualityRecord> {
  for (let attempt = 0; ; attempt += 1) {
    // Re-read per attempt, and merge per attempt: the base is what makes the
    // replay a merge with the winner rather than an overwrite of them.
    const current = await prisma.generationQualityRevision.findFirst({
      orderBy: { version: "desc" },
      select: { version: true, settings: true }
    });
    const baseVersion = current?.version ?? 0;
    try {
      const settings = mergeQualityFeatureSettings(current?.settings, assignments);
      if (modelChange.pageReviewPromptModes) {
        settings.pageReviewPromptModes = mergePageReviewPromptModes(
          current?.settings,
          modelChange.pageReviewPromptModes
        );
      } else if (modelChange.resetPageReviewPromptModes) {
        settings.pageReviewPromptModes = { ...PAGE_REVIEW_PROMPT_MODE_DEFAULTS };
      }
      if (modelChange.models) {
        settings.models = mergeGenerationModelPatch(
          current?.settings,
          modelChange.models,
          modelChange.compiledModels,
          modelChange.modelOptions
        );
      } else if (modelChange.resetModels) {
        settings.models = resetGenerationModels(current?.settings, modelChange.compiledModels);
      }
      return (await prisma.generationQualityRevision.create({
        data: {
          version: baseVersion + 1,
          settings,
          note: note?.trim() || null,
          updatedBy: "operator-console"
        }
      })) as GenerationQualityRecord;
    } catch (error) {
      if (!isRevisionNumberConflict(error)) {
        throw error;
      }
      if (attempt >= REVISION_CONFLICT_REPLAYS) {
        throw new GenerationQualityVersionConflictError(baseVersion);
      }
      log.warn(
        { event: "generation_quality.version_conflict", version: baseVersion + 1 },
        "Generation quality save lost the revision number and is re-merging onto the newer one"
      );
    }
  }
}

/** A unique-index violation from the revision insert, and nothing else. */
function isRevisionNumberConflict(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  return (error as { code?: unknown }).code === "P2002";
}

/**
 * 409, the way the pricing route next door answers its own version conflict.
 *
 * Neither route in this file declares a `response` map, so this reply is served
 * by Fastify's default serializer exactly as the 400s beside it are — declaring
 * a status here would mean declaring them all, and a 200 schema would start
 * filtering the settings payload it does not describe.
 */
async function withRevisionConflictReply<T>(
  request: { log: FastifyBaseLogger },
  reply: FastifyReply,
  run: () => Promise<T>
): Promise<T | FastifyReply> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof GenerationModelSelectionError) {
      return reply.code(400).send({ error: error.message });
    }
    if (error instanceof GenerationQualityVersionConflictError) {
      request.log.warn(
        { event: "generation_quality.save_conflict", currentVersion: error.currentVersion },
        "Generation quality save lost the revision number twice and was refused"
      );
      return reply.code(409).send({ error: error.message, currentVersion: error.currentVersion });
    }
    throw error;
  }
}

/**
 * A named feature takes the body's validated tiers; everything else keeps the
 * stored JSON exactly as this replica read it.
 *
 * Parsing the stored row through this build's feature and tier lists before a
 * merge loses data written by a newer replica: both a future feature id and a
 * future tier on a known feature disappear when an operator changes some other
 * gate. Existing known ids that are absent still receive their compiled
 * defaults, so revisions from before a feature was introduced retain the same
 * read behaviour.
 */
function mergeQualityFeatureSettings(
  stored: unknown,
  assignments: QualityFeatureAssignments
): Record<string, Prisma.InputJsonValue> {
  const settings = isJsonObject(stored) ? { ...stored } : {};
  for (const id of QUALITY_FEATURE_IDS) {
    // `[]` is a real assignment — it is how a feature is switched off — so the
    // test is presence, never truthiness.
    const assigned = assignments[id];
    if (assigned !== undefined) {
      settings[id] = [...assigned];
    } else if (!(id in settings)) {
      settings[id] = [...QUALITY_FEATURE_DEFAULTS[id]];
    }
  }
  return settings as Record<string, Prisma.InputJsonValue>;
}

function mergePageReviewPromptModes(
  stored: unknown,
  assignments: PageReviewPromptModePatch
): Record<string, PageReviewPromptMode> {
  const storedModes = isJsonObject(stored) && isJsonObject(stored.pageReviewPromptModes)
    ? stored.pageReviewPromptModes
    : {};
  const modes: Record<string, PageReviewPromptMode> = {};
  for (const [tier, mode] of Object.entries(storedModes)) {
    if (typeof mode === "string" && (PAGE_REVIEW_PROMPT_MODES as readonly string[]).includes(mode)) {
      modes[tier] = mode as PageReviewPromptMode;
    }
  }
  for (const tier of QUALITY_EFFORT_TIERS) {
    modes[tier] = assignments[tier] ?? modes[tier] ?? PAGE_REVIEW_PROMPT_MODE_DEFAULTS[tier];
  }
  return modes;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneDefaults(): QualityFeatureSettings {
  const settings = {} as QualityFeatureSettings;
  for (const id of QUALITY_FEATURE_IDS) {
    settings[id] = [...QUALITY_FEATURE_DEFAULTS[id]];
  }
  return settings;
}

function serializeGenerationQuality(
  record: GenerationQualityRecord | null,
  compiledModels: GenerationTextModelRouting,
  modelOptions: readonly GenerationTextModelOption[]
) {
  return {
    version: record?.version ?? 0,
    settings: serializeQualityFeatureSettings(record?.settings),
    pageReviewPromptModes: parsePageReviewPromptModes(record?.settings),
    models: resolveGenerationTextModelRouting(record?.settings, compiledModels),
    modelOptions,
    usingCompiledDefaults: record == null,
    features: QUALITY_FEATURES,
    pipelines: serializeGenerationPipelines(),
    note: record?.note ?? null,
    updatedBy: record?.updatedBy ?? null,
    updatedAt: record?.createdAt.toISOString() ?? null
  };
}

/**
 * Keep the response shape consumable by old consoles while exposing compatible
 * future settings. Known ids always serialize as string arrays (falling back to
 * the normal parser for malformed legacy data); unknown ids are included only
 * when their value is the same tier-list shape the console understands.
 */
function serializeQualityFeatureSettings(stored: unknown): Record<string, string[]> {
  const record = isJsonObject(stored) ? stored : {};
  const known = parseQualityFeatureSettings(stored);
  const settings: Record<string, string[]> = {};
  for (const id of QUALITY_FEATURE_IDS) {
    const value = record[id];
    settings[id] = isStringArray(value) ? [...value] : [...known[id]];
  }
  for (const [id, value] of Object.entries(record)) {
    if (!isQualityFeatureId(id) && isStringArray(value)) {
      settings[id] = [...value];
    }
  }
  return settings;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}


/**
 * The pipelines behind the gate rows: every strategy and the pipeline it
 * writes by, what "Auto" resolves to per category and page band, and each
 * pipeline's stages with the purposes they spend under and the gates that
 * switch them. Read-only, compiled from core, and what lets the console say
 * which books a checkbox reaches instead of listing rows per tier alone.
 */
function serializeGenerationPipelines() {
  return {
    strategies: (bookGenerationStrategies as readonly BookGenerationStrategy[]).map((strategy) => ({
      id: strategy.id,
      label: strategy.label,
      executionMode: strategy.executionMode,
      pipeline: pipelineForStrategy(strategy),
      strengthScore: strategy.strengthScore,
      recommendedPageRange: strategy.recommendedPageRange,
      researchDepth: strategy.researchDepth ?? null
    })),
    routing: autoStrategyRoutingMatrix(),
    stages: {
      planning: PLANNING_STAGES,
      "per-page": GENERATION_PIPELINE_STAGES["per-page"],
      composed: GENERATION_PIPELINE_STAGES.composed
    }
  };
}
