import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  update: vi.fn(async () => ({}))
}));

vi.mock("@book-maker/db", () => ({ prisma: { researchSource: { update: mocks.update } } }));

const { researchCitationsForExport } = await import("./researchLinks.js");

const WRAPPER = "https://vertexaisearch.cloud.google.com/grounding-api-redirect/AbC123";

afterEach(() => {
  vi.unstubAllGlobals();
  mocks.update.mockClear();
});

function stubFetch(response: () => Response) {
  const fetchMock = vi.fn(async () => response());
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("researchCitationsForExport", () => {
  it("unwraps a stored grounding redirect and writes the direct link back", async () => {
    stubFetch(() => new Response(null, { status: 302, headers: { location: "https://audubon.org/owls" } }));

    const citations = await researchCitationsForExport([
      { id: "source-1", title: "audubon.org", url: WRAPPER, summary: "Owls hunt at night." },
      { id: "source-2", title: "Planner note", url: null, summary: "No link." }
    ]);

    expect(citations).toEqual([
      { title: "audubon.org", url: "https://audubon.org/owls", summary: "Owls hunt at night." },
      { title: "Planner note", url: undefined, summary: "No link." }
    ]);
    expect(mocks.update).toHaveBeenCalledWith({
      where: { id: "source-1" },
      data: { url: "https://audubon.org/owls" }
    });
  });

  it("touches nothing when every stored link is already direct", async () => {
    const fetchMock = stubFetch(() => new Response(null, { status: 302 }));

    const citations = await researchCitationsForExport([
      { id: "source-1", title: "audubon.org", url: "https://audubon.org/owls", summary: "Owls." }
    ]);

    expect(citations[0]?.url).toBe("https://audubon.org/owls");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("keeps an expired wrapper and still compiles when the write-back fails", async () => {
    stubFetch(() => new Response("gone", { status: 404 }));
    mocks.update.mockRejectedValueOnce(new Error("row vanished"));

    const citations = await researchCitationsForExport([
      { id: "source-1", title: "audubon.org", url: WRAPPER, summary: "Owls." }
    ]);

    expect(citations[0]?.url).toBe(WRAPPER);
  });
});
