import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isGroundingRedirectUrl,
  resolveGroundingRedirect,
  resolveGroundingRedirects
} from "./groundingRedirect.js";

const WRAPPER = "https://vertexaisearch.cloud.google.com/grounding-api-redirect/AbC123";

function redirectTo(location: string): Response {
  return new Response(null, { status: 302, headers: { location } });
}

function htmlPage(body: string): Response {
  return new Response(body, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
}

function stubFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) =>
    handler(String(input), init)
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("isGroundingRedirectUrl", () => {
  it("recognises grounding wrappers without claiming ordinary Google links", () => {
    expect(isGroundingRedirectUrl(WRAPPER)).toBe(true);
    expect(isGroundingRedirectUrl("https://eu.vertexaisearch.cloud.google.com/grounding-api-redirect/x")).toBe(true);
    expect(isGroundingRedirectUrl("https://www.google.com/search?q=owls")).toBe(false);
    expect(isGroundingRedirectUrl("https://example.com/article")).toBe(false);
    expect(isGroundingRedirectUrl("not a url")).toBe(false);
    expect(isGroundingRedirectUrl(undefined)).toBe(false);
  });
});

describe("resolveGroundingRedirect", () => {
  it("reads the publisher address out of the redirect without following the site further", async () => {
    const fetchMock = stubFetch((url) => {
      expect(url).toBe(WRAPPER);
      return redirectTo("https://www.audubon.org/news/owls");
    });

    await expect(resolveGroundingRedirect(WRAPPER)).resolves.toBe("https://www.audubon.org/news/owls");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]?.redirect).toBe("manual");
  });

  it("follows a chain of wrappers and stops at the first address outside them", async () => {
    const second = "https://vertexaisearch.cloud.google.com/grounding-api-redirect/second";
    const fetchMock = stubFetch((url) =>
      url === WRAPPER ? redirectTo(second) : redirectTo("https://nature.com/articles/owls")
    );

    await expect(resolveGroundingRedirect(WRAPPER)).resolves.toBe("https://nature.com/articles/owls");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reads an interstitial that carries the destination in markup instead of a header", async () => {
    stubFetch(() =>
      htmlPage('<html><head><meta http-equiv="refresh" content="0; url=https://bbc.co.uk/a?x=1&amp;y=2">')
    );

    await expect(resolveGroundingRedirect(WRAPPER)).resolves.toBe("https://bbc.co.uk/a?x=1&y=2");
  });

  it("gives no answer when the wrapper fails, is not a wrapper, or leads somewhere unusable", async () => {
    stubFetch(() => {
      throw new Error("network down");
    });
    await expect(resolveGroundingRedirect(WRAPPER)).resolves.toBeUndefined();

    const fetchMock = stubFetch(() => redirectTo("https://example.com/article"));
    await expect(resolveGroundingRedirect("https://example.com/article")).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();

    stubFetch(() => htmlPage('<meta http-equiv="refresh" content="0; url=javascript:alert(1)">'));
    await expect(resolveGroundingRedirect(WRAPPER)).resolves.toBeUndefined();
  });

  it("stops rather than looping when the wrappers never lead out", async () => {
    const fetchMock = stubFetch((url) => redirectTo(`${url}/again`));

    await expect(resolveGroundingRedirect(WRAPPER)).resolves.toBeUndefined();
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(4);
  });
});

describe("resolveGroundingRedirects", () => {
  it("unwraps every source, fetching a repeated wrapper once", async () => {
    const other = "https://vertexaisearch.cloud.google.com/grounding-api-redirect/other";
    const fetchMock = stubFetch((url) =>
      redirectTo(url === WRAPPER ? "https://audubon.org/owls" : "https://nature.com/owls")
    );

    const resolved = await resolveGroundingRedirects([
      { title: "audubon.org", url: WRAPPER, summary: "Owls hunt at night." },
      { title: "audubon.org", url: WRAPPER, summary: "They swallow prey whole." },
      { title: "nature.com", url: other, summary: "Feather structure muffles flight." },
      { title: "A planner note", summary: "No link at all." }
    ]);

    expect(resolved.map((source) => source.url)).toEqual([
      "https://audubon.org/owls",
      "https://audubon.org/owls",
      "https://nature.com/owls",
      undefined
    ]);
    expect(resolved[0]?.summary).toBe("Owls hunt at night.");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps the wrapper when it cannot be resolved rather than dropping the citation", async () => {
    stubFetch(() => new Response("nope", { status: 500 }));

    const resolved = await resolveGroundingRedirects([{ title: "audubon.org", url: WRAPPER, summary: "Owls." }]);

    expect(resolved[0]?.url).toBe(WRAPPER);
  });

  it("hands out no work once the batch budget is gone", async () => {
    const fetchMock = stubFetch(() => redirectTo("https://audubon.org/owls"));

    const resolved = await resolveGroundingRedirects([{ title: "audubon.org", url: WRAPPER, summary: "Owls." }], {
      budgetMs: 0
    });

    expect(resolved[0]?.url).toBe(WRAPPER);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
