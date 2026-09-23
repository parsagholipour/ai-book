import { existsSync } from "node:fs";
import { chromium } from "@playwright/test";
import { createServer } from "vite";
import { expect, it } from "vitest";
import { materializeGenerationStages } from "@book-maker/core/generationTextModelRouting";
import { generationQualityResponse } from "./generationQualityTestFixtures.js";

it("edits independent stage efforts, saves only those fields, and keeps them on reload", async () => {
  const server = await createServer({ root: new URL("../../../", import.meta.url).pathname,
    logLevel: "silent", server: { host: "127.0.0.1", port: 0 } });
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === "string") throw new Error("Missing test server address");
  const executablePath = [process.env.PUPPETEER_EXECUTABLE_PATH, chromium.executablePath(), "/usr/bin/chromium", "/opt/google/chrome/chrome"]
    .find((path) => path && existsSync(path));
  const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}), args: ["--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const current = generationQualityResponse();
  const model = { provider: "openai", model: "gpt-5.6-sol", thinkingEffort: "medium" } as const;
  current.models.ultra.writer = model;
  current.models = materializeGenerationStages(current.models);
  current.modelOptions.push({ provider: model.provider, model: model.model, label: "GPT Sol", thinkingEfforts: [
    { value: "none", label: "Off" }, { value: "low", label: "Low" }, { value: "medium", label: "Medium", default: true },
    { value: "high", label: "High" }, { value: "max", label: "Max" }
  ] });
  current.features.push({ id: "planThinkingBoost", label: "Deeper plan thinking", summary: "Retired", retired: true });
  let savedBody: unknown;
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/auth/status") return route.fulfill({ json: { enabled: true, authenticated: true } });
    if (path !== "/api/admin/generation-quality") return route.abort();
    if (request.method() === "PATCH") {
      savedBody = request.postDataJSON();
      current.models.ultra.stages!["plan-book"]!.primary = { ...model, thinkingEffort: "high" };
      current.models.ultra.stages!["edit-chapter"]!.primary = { ...model, thinkingEffort: "low" };
      current.version += 1;
    }
    return route.fulfill({ json: current });
  });
  try {
    await page.goto(`http://127.0.0.1:${address.port}/admin/quality`);
    const plan = page.getByLabel("Ultra Book plan Effort", { exact: true });
    const edit = page.getByLabel("Ultra Chapter editing Effort", { exact: true });
    const draft = page.getByLabel("Ultra Chapter drafting Effort", { exact: true });
    await plan.waitFor();
    expect(await plan.inputValue()).toBe("medium");
    expect(await draft.inputValue()).toBe("medium");
    expect(await page.getByRole("group", { name: "Deeper plan thinking", exact: true }).count()).toBe(0);
    await plan.selectOption("high");
    await edit.selectOption("low");
    await page.getByRole("group", { name: "Stage settings tier" }).getByRole("button", { name: "Balanced", exact: true }).click();
    await page.getByLabel("Balanced Book plan Effort", { exact: true }).waitFor();
    await page.getByRole("group", { name: "Stage settings tier" }).getByRole("button", { name: "Ultra", exact: true }).click();
    expect(await plan.inputValue()).toBe("high");
    expect(await edit.inputValue()).toBe("low");
    expect(await draft.inputValue()).toBe("medium");
    await page.getByRole("button", { name: "Save setting", exact: true }).click();
    await page.getByText("Saved as generation quality version 4.").waitFor();
    expect(savedBody).toMatchObject({ models: { ultra: { stages: {
      "plan-book": { primary: { thinkingEffort: "high" } },
      "edit-chapter": { primary: { thinkingEffort: "low" } }
    } } } });
    expect((savedBody as { models: unknown }).models).toEqual({ ultra: { stages: {
      "plan-book": { primary: { thinkingEffort: "high" } },
      "edit-chapter": { primary: { thinkingEffort: "low" } }
    } } });
    await page.reload();
    await plan.waitFor();
    expect(await plan.inputValue()).toBe("high");
    expect(await edit.inputValue()).toBe("low");
    expect(await draft.inputValue()).toBe("medium");
    const setAll = page.getByRole("group", { name: "Set all stages", exact: true });
    await setAll.getByLabel("Set all stages model Effort", { exact: true }).selectOption("max");
    await setAll.getByRole("button", { name: "Set all Ultra stages", exact: true }).click();
    expect(await plan.inputValue()).toBe("max");
    expect(await edit.inputValue()).toBe("max");
    expect(await draft.inputValue()).toBe("max");
    await setAll.getByLabel("Set all stages target", { exact: true }).selectOption("fallback");
    await setAll.getByLabel("Set all stages model Effort", { exact: true }).selectOption("none");
    await setAll.getByRole("button", { name: "Set all Ultra stages", exact: true }).click();
    expect(await page.getByLabel("Ultra Book plan fallback Effort", { exact: true }).inputValue()).toBe("none");
    expect(await draft.inputValue()).toBe("max");
    await setAll.getByLabel("Set all stages target", { exact: true }).selectOption("primary");
    await setAll.getByRole("button", { name: "Add recommended effort rule" }).click();
    await setAll.getByLabel("Rule 1 model Effort", { exact: true }).selectOption("low");
    await setAll.getByRole("button", { name: "Add recommended effort rule" }).click();
    await setAll.getByLabel("Rule 2 minimum recommended effort", { exact: true }).selectOption("5");
    expect(await setAll.getByRole("button", { name: "Apply rules to Ultra stages", exact: true }).isDisabled()).toBe(true);
    await setAll.getByLabel("Rule 2 minimum recommended effort", { exact: true }).selectOption("8");
    await setAll.getByLabel("Rule 2 model Effort", { exact: true }).selectOption("high");
    await setAll.getByRole("button", { name: "Apply rules to Ultra stages", exact: true }).click();
    expect(await plan.inputValue()).toBe("high");
    expect(await edit.inputValue()).toBe("max");
    expect(await draft.inputValue()).toBe("max");
    expect(await page.getByLabel("Ultra Page titles and summaries Effort", { exact: true }).inputValue()).toBe("low");
    expect(await page.getByLabel("Ultra Book plan fallback Effort", { exact: true }).inputValue()).toBe("none");
    await edit.selectOption("low");
    expect(await edit.inputValue()).toBe("low");
    // The shortcut updates the draft without issuing a save of its own.
    expect(current.version).toBe(4);
    await page.getByRole("heading", { name: "Models and reasoning by stage" }).scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: "/tmp/generation-stage-settings-desktop.png" });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: "/tmp/generation-stage-settings-mobile.png" });
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
    await server.close();
  }
}, 30_000);
