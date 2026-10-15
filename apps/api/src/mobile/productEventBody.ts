import { z } from "zod";
import {
  INSTALL_ATTRIBUTION_TOKEN_PATTERN,
  PAYWALL_TRIGGERS,
  PRODUCT_EVENT_NAMES,
  PRODUCT_EVENT_SKU_PATTERN,
  PURCHASE_FAILURE_REASONS,
  type ProductEventName
} from "../productEventNames.js";
import { toOpenApiRequestBody } from "./schemas.js";
import { SHARE_SLUG_PATTERN } from "./shares/shareSlug.js";

/**
 * The body of `POST /api/mobile/events`. One flat object rather than a union
 * per name: Fastify's Ajv runs with `removeAdditional`, which strips a `oneOf`
 * branch's properties while it tries the others, so the OpenAPI copy has to be
 * an object it cannot mangle. Which fields a name needs is decided by
 * `productEventFromBody` below.
 *
 * Every field is a closed list or a narrow pattern: an event carries what kind
 * of thing happened, never anything a reader wrote.
 */
const attributionToken = z.string().regex(INSTALL_ATTRIBUTION_TOKEN_PATTERN);
const sku = z.string().regex(PRODUCT_EVENT_SKU_PATTERN);

export const productEventBodySchema = z
  .object({
    name: z.enum(PRODUCT_EVENT_NAMES),
    /** `paywall_viewed`: what opened it. */
    trigger: z.enum(PAYWALL_TRIGGERS).optional(),
    /** `purchase_*`: the Play product. */
    sku: sku.optional(),
    /** `purchase_started`: bought through the intro offer. */
    intro: z.boolean().optional(),
    /** `purchase_started`: the paywall the checkout was started from. */
    surface: z.enum(PAYWALL_TRIGGERS).optional(),
    /** `purchase_failed`: why, as a class. */
    reason: z.enum(PURCHASE_FAILURE_REASONS).optional(),
    /** `install_attributed`: the Play install referrer's `utm_source`. */
    source: attributionToken.optional(),
    medium: attributionToken.optional(),
    campaign: attributionToken.optional(),
    /** `install_attributed`: the share page the install came from. */
    shareSlug: z.string().regex(SHARE_SLUG_PATTERN).optional()
  })
  .strict();

export const productEventOpenApiBody = toOpenApiRequestBody(productEventBodySchema);

export type ProductEventBody = z.infer<typeof productEventBodySchema>;

export type RecordableProductEvent = { name: ProductEventName; properties: Record<string, string> };

/**
 * The row an event body becomes, or null when the name is missing a field it
 * needs. Fields another name uses are dropped rather than refused, so a newer
 * app adding one to an older name still records.
 */
export function productEventFromBody(body: ProductEventBody): RecordableProductEvent | null {
  switch (body.name) {
    case "paywall_viewed":
      return body.trigger ? { name: body.name, properties: { trigger: body.trigger } } : null;
    case "purchase_started":
      if (!body.sku || body.intro === undefined) return null;
      return {
        name: body.name,
        properties: { sku: body.sku, intro: body.intro ? "true" : "false", surface: body.surface ?? "other" }
      };
    case "purchase_cancelled":
      return body.sku ? { name: body.name, properties: { sku: body.sku } } : null;
    case "purchase_failed":
      return body.sku ? { name: body.name, properties: { sku: body.sku, reason: body.reason ?? "other" } } : null;
    case "install_attributed":
      if (!body.source) return null;
      return {
        name: body.name,
        properties: {
          source: body.source,
          medium: body.medium ?? "none",
          ...(body.campaign ? { campaign: body.campaign } : {}),
          ...(body.shareSlug ? { shareSlug: body.shareSlug } : {})
        }
      };
  }
}
