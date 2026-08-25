import swagger from "@fastify/swagger";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import {
  mobileCharacterCreateOpenApiBody,
  mobileCharacterPortraitOpenApiBody,
  mobileCharacterUpdateOpenApiBody
} from "./characterSchemas.js";
import {
  mobileAudiobookStartOpenApiBody,
  mobileChatUndoOpenApiBody,
  mobileCreationBranchOpenApiBody,
  mobileCreationBuildOpenApiBody,
  mobileCreationMessageBodySchema,
  mobileCreationMessageOpenApiBody,
  mobileCreationSessionStartOpenApiBody,
  mobileEditProposalActionOpenApiBody,
  mobileGenerationRetryOpenApiBody,
  mobileManualBookEditOpenApiBody,
  mobileOperationRetryOpenApiBody,
  mobilePlanApprovalBodySchema,
  mobilePlanApprovalOpenApiBody,
  mobilePlanRevisionOpenApiBody,
  mobileProjectChatBranchOpenApiBody,
  mobileProjectChatMessageBodySchema,
  mobileProjectChatMessageOpenApiBody,
  mobileProjectCreateBodySchema,
  mobileProjectCreateOpenApiBody,
  mobileVoiceCallProgressOpenApiBody,
  mobileVoiceCallStartOpenApiBody
} from "./schemas.js";

type JsonSchema = {
  $schema?: string;
  type?: string;
  additionalProperties?: boolean;
  default?: unknown;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  required?: string[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
};

const asJsonSchema = (value: unknown): JsonSchema => value as JsonSchema;

const property = (body: unknown, name: string): JsonSchema => {
  const value = asJsonSchema(body).properties?.[name];
  expect(value, `${name} is missing from the generated request body`).toBeDefined();
  return value ?? {};
};

const requestBodies = [
  mobileGenerationRetryOpenApiBody,
  mobileProjectCreateOpenApiBody,
  mobileAudiobookStartOpenApiBody,
  mobilePlanApprovalOpenApiBody,
  mobileOperationRetryOpenApiBody,
  mobilePlanRevisionOpenApiBody,
  mobileProjectChatMessageOpenApiBody,
  mobileProjectChatBranchOpenApiBody,
  mobileCreationBranchOpenApiBody,
  mobileCreationSessionStartOpenApiBody,
  mobileCreationMessageOpenApiBody,
  mobileCreationBuildOpenApiBody,
  mobileEditProposalActionOpenApiBody,
  mobileChatUndoOpenApiBody,
  mobileManualBookEditOpenApiBody,
  mobileVoiceCallStartOpenApiBody,
  mobileVoiceCallProgressOpenApiBody,
  mobileCharacterCreateOpenApiBody,
  mobileCharacterUpdateOpenApiBody,
  mobileCharacterPortraitOpenApiBody
] as const;

describe("generated mobile request schemas", () => {
  it("publishes all 20 as strict OpenAPI 3 objects that Fastify and Swagger accept", async () => {
    expect(requestBodies).toHaveLength(20);
    for (const body of requestBodies) {
      expect(body.type).toBe("object");
      expect(body.additionalProperties).toBe(false);
      expect(body.$schema).toBeUndefined();
    }

    const app = Fastify();
    await app.register(swagger, { openapi: { info: { title: "schema test", version: "1" } } });
    requestBodies.forEach((body, index) => {
      app.post(`/generated-body-${index}`, { schema: { body } }, async (request) => request.body);
    });

    try {
      await app.ready();
      const document = app.swagger();
      expect(Object.keys(document.paths ?? {})).toHaveLength(requestBodies.length);
      expect(JSON.stringify(document)).not.toContain('"$schema"');
    } finally {
      await app.close();
    }
  });

  it("uses the input side of the transformed project schema", () => {
    const body = asJsonSchema(mobileProjectCreateOpenApiBody);

    expect(body.required).toEqual(["bookType", "prompt"]);
    expect(property(body, "lengthPreset").default).toBe("standard");
    expect(property(body, "qualityPreset").default).toBe("balanced");
    expect(property(body, "pageCountMode").default).toBe("auto");
    expect(property(body, "language").default).toBe("en");
    expect(property(body, "imagesEnabled").default).toBeUndefined();

    expect(
      mobileProjectCreateBodySchema.parse({ bookType: "lead_magnet", prompt: "A practical guide to better pricing." })
    ).toMatchObject({
      imagesEnabled: true,
      coverEnabled: true,
      illustrationsEnabled: true
    });
  });

  it("keeps property defaults optional and strips Fastify-incompatible root defaults", () => {
    expect(asJsonSchema(mobilePlanApprovalOpenApiBody).default).toBeUndefined();
    expect(asJsonSchema(mobilePlanApprovalOpenApiBody).required).toBeUndefined();
    expect(property(mobileCreationMessageOpenApiBody, "message").default).toBe("");
    expect(asJsonSchema(mobileVoiceCallProgressOpenApiBody).required).toEqual(["elapsedSeconds"]);
    expect(mobilePlanApprovalBodySchema.parse(undefined)).toEqual({});
  });

  it("preserves nested strictness and supported bounds", () => {
    const readerContext = property(mobileProjectChatMessageOpenApiBody, "readerContext");
    const manualPage = property(mobileManualBookEditOpenApiBody, "pages").items;

    expect(readerContext.additionalProperties).toBe(false);
    expect(readerContext.properties?.pdfPage).toMatchObject({ type: "integer", minimum: 1, maximum: 20_000 });
    expect(manualPage?.additionalProperties).toBe(false);
    expect(manualPage?.required).toEqual(["id", "title", "markdown", "baseRevision"]);
    expect(property(mobileVoiceCallProgressOpenApiBody, "elapsedSeconds").maximum).toBe(24 * 60 * 60);
  });
});

describe("mobile chat body schemas", () => {
  it("accepts a reply on both chat surfaces", () => {
    expect(
      mobileProjectChatMessageBodySchema.safeParse({
        message: "What does that mean?",
        replyToMessageId: "chat-1"
      }).success
    ).toBe(true);
    expect(
      mobileCreationMessageBodySchema.safeParse({
        message: "The second one",
        replyToMessageId: "m1"
      }).success
    ).toBe(true);
  });

  it("accepts the reader's open-file identity alongside a physical sheet", () => {
    expect(
      mobileProjectChatMessageBodySchema.safeParse({
        message: 'Rewrite "the storm broke".',
        readerContext: { pdfPage: 7, contentRevision: 3, pdfDigest: "a".repeat(64) }
      }).success
    ).toBe(true);
  });

  it("rejects an unknown field rather than silently dropping it", () => {
    expect(
      mobileProjectChatMessageBodySchema.safeParse({
        message: "hi",
        replyToMessageID: "chat-1"
      }).success
    ).toBe(false);
  });
});
