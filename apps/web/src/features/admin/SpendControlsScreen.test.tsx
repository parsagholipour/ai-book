import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  SpendControlsPanel,
  draftFromControls,
  parseSpendDraft,
  type SpendControlsView
} from "./SpendControlsScreen.js";

const defaults = {
  paused: false,
  softDailyCapUsd: 5,
  hardDailyCapUsd: 12,
  freeMonthlyCapUsd: 150,
  paidHardDailyCapUsd: 60,
  freeUserDailyCapUsd: 1.5,
  paidUserDailyCapUsd: 30
};

const quietDay: SpendControlsView["today"] = {
  day: "2026-10-13",
  resetsAt: "2026-10-14T00:00:00.000Z",
  state: "normal",
  paidState: "normal",
  freeUsd: 0,
  paidUsd: 0,
  unattributedUsd: 0,
  freeSpendUsd: 0,
  totalUsd: 0
};

function view(overrides: Partial<SpendControlsView> = {}): SpendControlsView {
  return {
    controls: { ...defaults, version: 0, note: null, updatedBy: null, updatedAt: null },
    defaults,
    today: { ...quietDay, state: "soft", freeUsd: 5.2, unattributedUsd: 1, freeSpendUsd: 6.2, paidUsd: 14.5, totalUsd: 20.7 },
    month: { month: "2026-10", resetsAt: "2026-11-01T00:00:00.000Z", freeSpendUsd: 75 },
    topSpenders: [
      { userId: "user-b", email: "b@example.com", spendUsd: 1.75, paidPlan: true },
      { userId: "user-a", email: null, spendUsd: 0.004, paidPlan: false }
    ],
    ...overrides
  };
}

function render(value: SpendControlsView, draft = draftFromControls(value.controls)) {
  return renderToStaticMarkup(
    <SpendControlsPanel
      view={value}
      draft={draft}
      note=""
      busy={false}
      onDraftChange={() => undefined}
      onNoteChange={() => undefined}
      onSave={() => undefined}
    />
  );
}

describe("spend controls panel", () => {
  it("shows today's spend by plan, the month against its ceiling, the state of each plan and who is spending it", () => {
    const html = render(view());

    expect(html).toContain("Today (2026-10-13, UTC)");
    expect(html).toContain("<strong>$6.20</strong> of free spend so far ($5.20 by free readers, $1.00 unattributed)");
    expect(html).toContain("<strong>$14.50</strong> of paid-plan spend · paid cap $60.00");
    expect(html).toContain("Soft cap reached — free accounts held to standard work");
    expect(html).toContain("This month (2026-10, UTC)");
    expect(html).toContain("<strong>$75.00</strong> of free spend of the $150.00 monthly ceiling (50%)");
    expect(html).toMatch(/Paid plans:.*Normal/s);
    expect(html).toContain("<td>Paid</td>");
    expect(html).toContain("<td>Free</td>");
    expect(html).toContain("b@example.com");
    expect(html).toContain("$1.75");
    expect(html).toContain("(no email)");
    expect(html).toContain("$0.00400");
    expect(html).toContain("built-in defaults");
  });

  it("offers the pause switch and every cap with its default", () => {
    const html = render(view({ today: quietDay, topSpenders: [] }));

    expect(html).toContain("AI work running");
    expect(html).toContain("Soft cap (free spend, per day) — default $5.00");
    expect(html).toContain("Hard cap (free spend, per day) — default $12.00");
    expect(html).toContain("Monthly ceiling (free spend, per UTC month) — default $150.00");
    expect(html).toContain("Paid cap (paid-plan spend, per day) — default $60.00");
    expect(html).toContain("Per reader, free plan — default $1.50");
    expect(html).toContain("Per reader, paid plan — default $30.00");
    expect(html).toContain("No reader has spent anything today.");
    // Nothing changed yet, so there is nothing to save.
    expect(html).toMatch(/<button[^>]*disabled[^>]*>.*Save controls/s);
  });

  it("names a pause the operator set", () => {
    const paused = view({
      controls: { ...defaults, paused: true, version: 3, note: null, updatedBy: "operator-console", updatedAt: "2026-10-13T09:00:00.000Z" },
      today: { ...quietDay, state: "paused", paidState: "paused" }
    });

    const html = render(paused);

    expect(html).toContain("AI work paused");
    expect(html).toContain("Paused by the operator");
    expect(html).toContain("Current version 3");
  });

  it("names the paid cap and the monthly ceiling when either is reached", () => {
    const html = render(
      view({
        today: { ...quietDay, state: "monthly", paidState: "capped", paidUsd: 61, totalUsd: 61 },
        month: { month: "2026-10", resetsAt: "2026-11-01T00:00:00.000Z", freeSpendUsd: 151 }
      })
    );

    expect(html).toContain("Monthly ceiling reached — free accounts start no new AI work this month");
    expect(html).toContain("Paid cap reached — paying readers start no new AI work today");
  });

  it("refuses a draft the API would refuse", () => {
    const draft = draftFromControls(defaults);
    expect(parseSpendDraft(draft)).toEqual({ caps: defaults });
    expect(parseSpendDraft({ ...draft, softDailyCapUsd: "50" })).toEqual({ problem: "The soft cap has to be at or below the hard cap." });
    expect(parseSpendDraft({ ...draft, freeUserDailyCapUsd: "" })).toMatchObject({ problem: expect.stringContaining("Per reader, free plan") });
    expect(parseSpendDraft({ ...draft, paidUserDailyCapUsd: "-1" })).toMatchObject({ problem: expect.stringContaining("0 or more") });
    expect(parseSpendDraft({ ...draft, freeMonthlyCapUsd: "lots" })).toMatchObject({ problem: expect.stringContaining("Monthly ceiling") });
    expect(parseSpendDraft({ ...draft, paidHardDailyCapUsd: " " })).toMatchObject({ problem: expect.stringContaining("Paid cap") });
  });
});
