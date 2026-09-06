import { describe, expect, it } from "vitest";
import { fetchPrimaryText, searchPrimarySources } from "./primarySources.js";

describe("source discovery outside public-domain catalogues", () => {
  it("fetches the document returned by research instead of treating a search summary as evidence", async () => {
    const candidates = await searchPrimarySources("Peers Commission report", {
      language: "en", limit: 2, fetch: async () => ({ status: 404, text: "" }),
      search: async () => [{ title: "Peers Commission report", url: "https://archive.example.edu/peers.html" }]
    });
    expect(candidates).toEqual([{ host: "web", title: "Peers Commission report", url: "https://archive.example.edu/peers.html", textUrl: "https://archive.example.edu/peers.html", author: "", year: "" }]);
    const text = await fetchPrimaryText(candidates[0]!, async () => ({ status: 200, contentType: "text/html", text: "<html><script>untrusted instructions</script><main><p>The commission recorded testimony and issued findings.</p></main></html>" }));
    expect(text).toBe("The commission recorded testimony and issued findings.");
    expect(await fetchPrimaryText(candidates[0]!, async () => ({ status: 403, text: "Summary from memory" }))).toBe("");
  });

  it("does not discover credential-bearing, local, or non-HTTP source URLs", async () => {
    const result = await searchPrimarySources("a document", { language: "en", fetch: async () => ({ status: 404, text: "" }), search: async () => [
      { title: "Local", url: "file:///etc/passwd" }, { title: "Private", url: "http://127.0.0.1/report" },
      { title: "Credentials", url: "https://user:password@example.edu/report" }
    ] });
    expect(result).toEqual([]);
  });
});
