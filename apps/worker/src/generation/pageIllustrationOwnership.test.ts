import { describe, expect, it, vi } from "vitest";
import {
  mayRetireLegacyGeneratedIllustration,
  ownsPageIllustration,
  pageIllustrationKeeperToken,
  pageIllustrationKeeperTokens,
  retireGeneratedPageIllustrations
} from "./pageIllustrationOwnership.js";

const keeper = {
  projectId: "project-1",
  pageId: "page-1",
  title: "A shared title",
  markdown: "Identical prose.",
  summary: "Identical summary.",
  imagePrompt: "The same scene",
  revision: 2
};

describe("page illustration keeper identity", () => {
  it("does not collide for identical-content pages or projects", () => {
    expect(pageIllustrationKeeperToken(keeper)).not.toBe(
      pageIllustrationKeeperToken({ ...keeper, pageId: "page-2" })
    );
    expect(pageIllustrationKeeperToken(keeper)).not.toBe(
      pageIllustrationKeeperToken({ ...keeper, projectId: "project-2" })
    );
  });

  it("stays with the stable page when its structural index changes", () => {
    const pageBeforeMove = { ...keeper, index: 3 };
    const pageAfterMove = { ...keeper, index: 11 };
    const beforeMove = pageIllustrationKeeperToken(pageBeforeMove);
    const afterMove = pageIllustrationKeeperToken(pageAfterMove);

    expect(afterMove).toBe(beforeMove);
  });

  it("accepts a queued content-only token only as a migration alias", () => {
    const [currentToken, oldToken] = pageIllustrationKeeperTokens(keeper);

    expect(currentToken).toMatch(/^v2-[0-9a-f]{24}$/);
    expect(oldToken).toMatch(/^[0-9a-f]{24}$/);
    expect(ownsPageIllustration(keeper, oldToken)).toBe(true);
    expect(pageIllustrationKeeperToken(keeper)).toBe(currentToken);
  });

  it("lets a stable legacy owner veto numeric-filename retirement", () => {
    expect(mayRetireLegacyGeneratedIllustration(null, "page-1")).toBe(true);
    expect(mayRetireLegacyGeneratedIllustration({ legacyGeneratedPageId: "page-1" }, "page-1")).toBe(true);
    expect(mayRetireLegacyGeneratedIllustration({ legacyGeneratedPageId: "source-page" }, "page-1")).toBe(false);
  });

  it("retires every generated ownership namespace while preserving manual and moved assets", async () => {
    const [currentToken, legacyToken] = pageIllustrationKeeperTokens(keeper);
    const assets = [
      {
        id: "current-token-metadata",
        path: "/assets/images/project-1/generated.webp",
        metadata: { keeperToken: currentToken }
      },
      {
        id: "legacy-token-path",
        path: `/assets/images/project-1/page-page-1-${legacyToken}.png`,
        metadata: null
      },
      {
        id: "tokenless-job-path",
        path: "/assets/images/project-1/page-page-1-legacy-job-1.webp",
        metadata: null
      },
      {
        id: "stable-owner-after-reindex",
        path: "/assets/images/project-1/page-12.png",
        metadata: { legacyGeneratedPageId: "page-1" }
      },
      {
        id: "numeric-unmarked",
        path: "/assets/images/project-1/page-3.jpg",
        metadata: null
      },
      {
        id: "numeric-same-owner",
        path: "/assets/images/project-1/page-3.svg",
        metadata: { legacyGeneratedPageId: "page-1" }
      },
      {
        id: "numeric-owned-by-moved-page",
        path: "/assets/images/project-1/page-3.webp",
        metadata: { legacyGeneratedPageId: "source-page" }
      },
      {
        id: "manual-operation",
        path: "/assets/images/project-1/page-3-op-7-user-edit.webp",
        metadata: { operationId: "op-7" }
      },
      {
        id: "unrelated-generated-keeper",
        path: "/assets/images/project-1/generated-other.webp",
        metadata: { keeperToken: "v2-another-keeper" }
      }
    ];
    const findMany = vi.fn(async () => assets);
    const deleteMany = vi.fn(async () => ({ count: 6 }));

    await retireGeneratedPageIllustrations({ imageAsset: { findMany, deleteMany } } as never, {
      pageIndex: 3,
      priorKeeper: keeper
    });

    expect(findMany).toHaveBeenCalledWith({
      where: {
        projectId: "project-1",
        pageId: "page-1",
        type: { in: ["SCENE_ILLUSTRATION", "DIAGRAM"] }
      },
      select: { id: true, path: true, metadata: true }
    });
    expect(deleteMany).toHaveBeenCalledWith({
      where: {
        id: {
          in: [
            "current-token-metadata",
            "legacy-token-path",
            "tokenless-job-path",
            "stable-owner-after-reindex",
            "numeric-unmarked",
            "numeric-same-owner"
          ]
        },
        projectId: "project-1",
        pageId: "page-1"
      }
    });
  });
});
