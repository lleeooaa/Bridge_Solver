import { expect, test } from "@playwright/test";
import { enterFullDeal, openApp } from "./fixtures";

test("guided play and challenge use real DDS and survive undo and tab changes", async ({ page }) => {
    await openApp(page);
    await enterFullDeal(page);
    await page.getByRole("button", { name: "Run solver", exact: true }).click();
    await expect(page.locator(".play-board-panel")).toContainText("library DDS");
    await expect(page.locator(".play-optimum")).toContainText("6 / 13");
    const buttons = page.locator(".play-board-panel button").filter({ hasText: "Best" });
    await expect(buttons.first()).toBeEnabled();
    await buttons.first().click();
    await expect(page.locator(".play-board-panel")).toContainText("library DDS");
    await page.getByRole("button", { name: "Undo one card", exact: true }).click();
    await expect(page.locator(".play-optimum")).toContainText("6 / 13");
    await page.getByRole("tab", { name: "Single-dummy advisor", exact: true }).click();
    await page.getByRole("tab", { name: "Solver / Challenge", exact: true }).click();
    await expect(page.locator(".play-optimum")).toContainText("6 / 13");
    await page.getByRole("button", { name: "Start challenge", exact: true }).click();
    await expect(page.locator(".challenge-feedback")).toContainText("Challenge ready");
    await expect(page.locator(".play-optimum")).toHaveCount(0);
    await expect(page.locator(".challenge-feedback")).not.toContainText("6 / 13");
});
