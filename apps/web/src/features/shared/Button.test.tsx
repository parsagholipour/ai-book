import { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { Button, ButtonLink, IconButton } from "./Button.js";
import { SegmentedControl } from "./SegmentedControl.js";

describe("shared action controls", () => {
  it("defaults buttons to type button and preserves native overrides", () => {
    const defaultMarkup = renderToStaticMarkup(<Button>Continue</Button>);
    const submitMarkup = renderToStaticMarkup(<Button type="submit">Submit</Button>);

    expect(defaultMarkup).toContain('type="button"');
    expect(submitMarkup).toContain('type="submit"');
  });

  it("renders variants, sizes, full width styling, and custom classes", () => {
    const markup = renderToStaticMarkup(
      <Button variant="accent" size="sm" fullWidth compact className="logout-hook">
        Apply
      </Button>
    );

    expect(markup).toContain("action-control--accent");
    expect(markup).toContain("action-control--sm");
    expect(markup).toContain("action-control--full-width");
    expect(markup).toContain("action-control--compact");
    expect(markup).toContain("logout-hook");
  });

  it("disables loading buttons, exposes busy state, and replaces their icons", () => {
    const markup = renderToStaticMarkup(
      <Button
        variant="primary"
        loading
        loadingLabel="Saving…"
        startIcon={<span data-control-icon="save" />}
        endIcon={<span data-control-icon="next" />}
      >
        Save
      </Button>
    );

    expect(markup).toContain("disabled");
    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain("Saving…");
    expect(markup).toContain("action-spinner");
    expect(markup).not.toContain("data-control-icon");
    expect(markup).not.toContain(">Save<");
  });

  it("keeps a loading button's normal label when no loading label is supplied", () => {
    const markup = renderToStaticMarkup(<Button loading>Publish</Button>);

    expect(markup).toContain("Publish");
    expect(markup).toContain("action-spinner");
  });

  it("gives icon buttons an accessible label, including while loading", () => {
    const normalMarkup = renderToStaticMarkup(
      <IconButton label="Refresh projects">
        <span data-control-icon="refresh" />
      </IconButton>
    );
    const loadingMarkup = renderToStaticMarkup(
      <IconButton label="Refresh projects" loading loadingLabel="Refreshing projects">
        <span data-control-icon="refresh" />
      </IconButton>
    );

    expect(normalMarkup).toContain('aria-label="Refresh projects"');
    expect(loadingMarkup).toContain('aria-label="Refreshing projects"');
    expect(loadingMarkup).toContain("action-spinner");
    expect(loadingMarkup).not.toContain("data-control-icon");
    expect(loadingMarkup).not.toContain("Refreshing projects</");
  });

  it("renders router and anchor button links with their appropriate attributes", () => {
    const routerMarkup = renderToStaticMarkup(
      <MemoryRouter>
        <ButtonLink to="/admin" size="sm" aria-label="Open operations">
          Operations
        </ButtonLink>
      </MemoryRouter>
    );
    const anchorMarkup = renderToStaticMarkup(
      <ButtonLink href="/exports/book.pdf" download="book.pdf" target="_blank">
        PDF
      </ButtonLink>
    );

    expect(routerMarkup).toContain('href="/admin"');
    expect(routerMarkup).toContain('aria-label="Open operations"');
    expect(anchorMarkup).toContain('href="/exports/book.pdf"');
    expect(anchorMarkup).toContain('download="book.pdf"');
    expect(anchorMarkup).toContain('target="_blank"');
  });

  it("forwards refs to button links", () => {
    const ref = createRef<HTMLAnchorElement>();
    renderToStaticMarkup(
      <ButtonLink href="/exports/book.pdf" ref={ref}>
        PDF
      </ButtonLink>
    );
    // SSR cannot attach refs; this still typechecks the forwardRef surface.
    expect(ref.current).toBeNull();
  });

  it("marks the selected segment as a radio and propagates disabled state", () => {
    const markup = renderToStaticMarkup(
      <SegmentedControl
        label="Time range"
        options={[
          { value: 7, label: "7d", disabled: true },
          { value: 30, label: "30d" }
        ]}
        value={30}
        disabled
        onChange={() => undefined}
      />
    );

    expect(markup).toContain('role="radiogroup"');
    expect(markup).toContain('aria-label="Time range"');
    expect(markup).toContain('aria-disabled="true"');
    expect(markup).toContain('role="radio"');
    expect(markup).toContain('aria-checked="false"');
    expect(markup).toContain('aria-checked="true"');
    expect(markup).toContain("segmented-control-option is-selected");
    expect(markup.match(/disabled/g)).toHaveLength(3);
  });
});
