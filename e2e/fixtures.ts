import { expect, type Page } from "@playwright/test";

export const openApp = async (page: Page): Promise<void> => {
    await page.goto("./");
    await page.waitForFunction(() => globalThis.crossOriginIsolated);
    await expect(page.getByRole("tab", { name: "Solver / Challenge", exact: true })).toBeVisible();
};

export const fillKnownExampleHands = async (page: Page): Promise<void> => {
    await page.locator("#advisor-declarer").selectOption("West");
    await page.locator("#advisor-level").selectOption("1");
    await page.locator("#advisor-strain").selectOption("no-trump");
    await page.locator("#advisor-doubling").selectOption("undoubled");
    await page.locator("#advisor-own-hand").fill("AJ.AQ5.96543.Q72");
    await page.locator("#advisor-dummy-hand").fill("Q7652.32.JT.KT63");
    await page.getByRole("combobox", { name: "Dealer", exact: true }).selectOption("West");
    await page.getByRole("combobox", { name: "Vulnerability", exact: true }).selectOption("none");
    await page.getByRole("textbox", { name: "Complete auction, starting with dealer", exact: true }).fill("1NT P P P");
}

export const startAdvisor = async (page: Page): Promise<void> => {
    await page.getByRole("tab", { name: "Single-dummy advisor", exact: true }).click();
    await fillKnownExampleHands(page);
    await page.getByRole("button", { name: "Start advisor", exact: true }).click();
    await page.getByRole("button", { name: "Record KD played by North", exact: true }).click();
};

export const enterFullDeal = async (page: Page): Promise<void> => {
    await page.getByRole("button", { name: "Text entry", exact: true }).click();
    const hands = {
        North: "9.JT986.KQ82.A54", East: "Q7652.32.JT.KT63",
        South: "KT843.K74.A7.J98", West: "AJ.AQ5.96543.Q72",
    };
    for (const [seat, hand] of Object.entries(hands)) {
        await page.getByLabel(`${seat} hand, suits in SHDC order`).fill(hand);
    }
    await page.locator("#contract-level").selectOption("1");
    await page.getByRole("group", { name: "Contract strain", exact: true })
        .getByRole("button", { name: "No trump", exact: true }).click();
    await page.getByRole("group", { name: "Declarer", exact: true })
        .getByRole("button", { name: "W West", exact: true }).click();
};
