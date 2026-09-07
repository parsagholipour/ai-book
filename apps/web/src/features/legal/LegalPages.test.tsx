import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { TermsPage } from "./LegalPages.js";

describe("legal pages", () => {
  it("discloses the default Balanced planning credit charge", () => {
    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <TermsPage />
      </MemoryRouter>
    );

    expect(markup).toContain("Building a book plan uses credits");
    expect(markup).toContain("Balanced planning uses 40 credits");
  });
});
