import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
    createEmptyHands, DIRECTIONS, RANKS, SUITS,
    type Contract, type Hands, type PlayedCard, type Rank, type Suit,
} from "../src/bridge";
import { buildPlayState, getLegalCards } from "../src/play";
import { openApp, startAdvisor } from "./fixtures";

const validationFixtureFiles = (): {
    name: string;
    mimeType: string;
    buffer: Buffer;
}[] => {
    const hands: Hands = createEmptyHands();
    for (let card = 0; card < 52; card += 1) {
        const seat = DIRECTIONS[Math.floor(card / 13)];
        const suit = SUITS[Math.floor(card / 13)];
        const rank = RANKS[card % 13];
        if (seat === undefined || suit === undefined || rank === undefined) {
            throw new Error("Could not create a validation UI fixture.");
        }
        hands[seat][suit].push(rank);
    }

    const contract: Contract = { level: 1, strain: "no-trump", declarer: "West", doubling: "undoubled" };
    const input = { hands, contract };
    const plays: PlayedCard[] = [];
    let state = buildPlayState(input, plays);
    while (!state.isComplete) {
        const card = getLegalCards(state)[0];
        if (card === undefined) throw new Error("Could not finish the validation UI fixture.");
        plays.push({ player: state.playerToMove, card });
        state = buildPlayState(input, plays);
    }

    const cardId = (suit: Suit, rank: Rank): number =>
        SUITS.indexOf(suit) * 13 + RANKS.indexOf(rank);
    const record = {
        schema: "bridge-human-play/v2",
        hands: Object.fromEntries(DIRECTIONS.map((seat) => [
            seat,
            SUITS.flatMap((suit) => hands[seat][suit].map((rank) => cardId(suit, rank)))
                .sort((left, right) => left - right),
        ])),
        dealer: "West",
        vulnerability: "none",
        auction: ["1NT", "P", "P", "P"],
        plays: plays.map((play) => ({ player: play.player, card: cardId(play.card.suit, play.card.rank) })),
        claim: null,
        metadata: {},
    };
    const shardName = "validation-000000.jsonl";
    const shardContents = `${JSON.stringify(record)}\n`;
    const manifest = {
        schema: "bridge-human-play-dataset/v2",
        splits: {
            validation: {
                shards: [{
                    file: shardName,
                    sha256: createHash("sha256").update(shardContents).digest("hex"),
                }],
            },
        },
    };
    return [
        { name: "manifest.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(manifest)) },
        { name: shardName, mimeType: "application/x-ndjson", buffer: Buffer.from(shardContents) },
    ];
};

test("separate advisor uses only two visible hands and restores reproducible advice after undo", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await openApp(page);
    await startAdvisor(page);
    await expect(page.locator(".advisor-analysis [role=status]")).toContainText("Analysis complete.");
    await expect(page.locator(".advisor-results tbody tr")).toHaveCount(2);
    const original = await page.locator(".advisor-results tbody").innerText();
    await expect(page.getByRole("region", { name: "East Dummy hand", exact: true })).toBeVisible();
    await expect(page.getByRole("region", { name: "North Declarer hand", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Play JD from East", exact: true }).click();
    await expect(page.getByRole("region", { name: "Record South's observed card", exact: true })).toBeVisible();
    await expect(page.locator(".advisor-play-history")).toContainText("Trick 1");
    await expect(page.locator(".advisor-play-history")).toContainText("In progress · 2/4 cards");
    await expect(page.locator(".advisor-history-card")).toHaveCount(2);
    await expect(page.locator(".advisor-play-history")).toContainText("North");
    await expect(page.locator(".advisor-play-history")).toContainText("KD");
    await expect(page.locator(".advisor-play-history")).toContainText("East");
    await expect(page.locator(".advisor-play-history")).toContainText("JD");
    await expect(page.getByRole("button", { name: "Record KS played by South", exact: true })).toBeVisible();
    const visibleCards = await page.locator(".advisor-visible-hands .advisor-card").allTextContents();
    const unseenCards = await page.locator(".advisor-observed-hand .advisor-card").allTextContents();
    expect(unseenCards.every((card) => !visibleCards.includes(card))).toBe(true);
    await page.getByRole("button", { name: "Record KS played by South", exact: true }).click();
    await expect(page.locator(".advisor-analysis [role=status]")).toContainText("Analysis complete.");
    await expect(page.locator(".advisor-history-card")).toHaveCount(3);
    await expect(page.locator(".advisor-play-history")).toContainText("In progress · 3/4 cards");
    await page.getByRole("button", { name: "Undo one card", exact: true }).click();
    await expect(page.getByRole("region", { name: "Record South's observed card", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Undo one card", exact: true }).click();
    await expect(page.locator(".advisor-analysis [role=status]")).toContainText("Analysis complete.");
    await expect(page.locator(".advisor-results tbody")).toHaveText(original, { useInnerText: true });
    await page.locator("#advisor-samples").selectOption("500");
    await expect(page.locator(".advisor-analysis [role=status]")).toContainText("500/500");
    await expect(page.locator(".advisor-analysis [role=status]")).toContainText("Analysis complete.");
    await page.getByRole("tab", { name: "Solver / Challenge", exact: true }).click();
    await expect(page.locator("#advisor-panel")).toBeHidden();
    await expect(page.getByRole("button", { name: "Run solver", exact: true })).toBeVisible();
    await page.getByRole("tab", { name: "Single-dummy advisor", exact: true }).click();
    await expect(page.locator(".advisor-analysis [role=status]")).toContainText("Analysis complete.");
    expect(errors).toEqual([]);
});

test("loads a local validation board with its auction and opening lead without exposing defender hands", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await openApp(page);
    await page.getByRole("tab", { name: "Single-dummy advisor", exact: true }).click();
    await page.locator("#advisor-validation-folder").setInputFiles(validationFixtureFiles());
    await expect(page.locator(".advisor-validation-picker [role=status]"))
        .toContainText("Selected 2 local files");
    await page.getByRole("button", { name: "Pick random validation board", exact: true }).click();
    await expect(page.locator(".advisor-validation-picker [role=status]"))
        .toContainText("Loaded 1NT by West");
    await expect(page.locator(".advisor-analysis")).toBeVisible();
    await expect(page.getByRole("region", { name: "West Declarer hand", exact: true })).toBeVisible();
    await expect(page.getByRole("region", { name: "East Dummy hand", exact: true })).toBeVisible();
    await expect(page.getByRole("region", { name: "North Declarer hand", exact: true })).toHaveCount(0);
    await expect(page.locator(".advisor-validation-picker")).toContainText("Auction: 1NT P P P.");
    await expect(page.getByRole("button", { name: "Start interactive hybrid play", exact: true })).toBeEnabled();
    await expect(page.locator(".advisor-analysis [role=status]")).toContainText("Analysis complete.");
    await page.locator(".advisor-visible-hands button:not([disabled])").first().click();
    await expect(page.getByRole("region", { name: "Record South's observed card", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Start interactive hybrid play", exact: true })).toBeEnabled();
    await page.getByText("Auction context", { exact: true }).click();
    await expect(page.locator("details.advisor-context")).toContainText("West: 1NT");
    expect(errors).toEqual([]);
});

test("invalid visible hands and invalid analysis options surface errors", async ({ page }) => {
    await openApp(page);
    await page.getByRole("tab", { name: "Single-dummy advisor", exact: true }).click();
    await page.getByRole("button", { name: "Load example hands" }).click();
    await page.locator("#advisor-dummy-hand").fill("AJ.AQ5.96543.Q72");
    await page.getByRole("button", { name: "Start advisor", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("more than once");
    await page.getByRole("button", { name: "Load example hands" }).click();
    await page.getByRole("button", { name: "Start advisor", exact: true }).click();
    await page.getByRole("button", { name: "Record KD played by North", exact: true }).click();
    await page.getByLabel("Random seed", { exact: true }).fill("-1");
    await expect(page.getByRole("alert")).toContainText("Seed");
    await page.getByLabel("Random seed", { exact: true }).fill("1");
    await expect(page.locator(".advisor-analysis [role=status]")).toContainText("Analysis complete.");
    await expect(page.getByRole("alert")).toHaveCount(0);
});

test("records validated public context and exports only versioned actor-visible model features", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await openApp(page);
    await page.getByRole("tab", { name: "Single-dummy advisor", exact: true }).click();
    await page.getByRole("button", { name: "Load example hands" }).click();
    await expect(page.getByRole("textbox", { name: "Public auction explanations / alerts", exact: true })).toHaveCount(0);
    await expect(page.getByRole("textbox", { name: "North / South bidding system", exact: true })).toHaveCount(0);
    await expect(page.getByRole("textbox", { name: "East / West bidding system", exact: true })).toHaveCount(0);
    await expect(page.getByRole("textbox", { name: "North / South leads and signals", exact: true })).toHaveCount(0);
    await expect(page.getByRole("textbox", { name: "East / West leads and signals", exact: true })).toHaveCount(0);
    await page.getByRole("textbox", { name: "Complete auction, starting with dealer", exact: true }).fill("1NT P P P");
    await page.getByRole("button", { name: "Start advisor", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("dealer");
    await page.getByRole("combobox", { name: "Dealer", exact: true }).selectOption("North");
    await page.getByRole("button", { name: "Start advisor", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("declarer");
    await page.getByRole("textbox", { name: "Complete auction, starting with dealer", exact: true }).fill("P P P 1NT P P");
    await page.getByRole("button", { name: "Start advisor", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("complete auction");
    await page.getByRole("textbox", { name: "Complete auction, starting with dealer", exact: true }).fill("P P P 1NT P P P");
    await page.getByRole("combobox", { name: "Vulnerability", exact: true }).selectOption("east-west");
    await page.getByRole("button", { name: "Start advisor", exact: true }).click();
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Download model features" })).toBeDisabled();
    await page.getByText("Auction context", { exact: true }).click();
    await expect(page.locator("details.advisor-context")).toContainText("No trained model is loaded.");
    await expect(page.locator("details.advisor-context")).toContainText("West: 1NT");
    await expect(page.locator("details.advisor-context")).not.toContainText("bidding system");
    await expect(page.locator("details.advisor-context")).not.toContainText("leads and signals");
    await page.getByRole("button", { name: "Record KD played by North", exact: true }).click();
    await expect(page.locator(".advisor-analysis [role=status]")).toContainText("Analysis complete.");
    await expect(page.locator(".advisor-analysis")).toContainText("Auction context is not used.");
    const downloadReady = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download model features" }).click();
    const download = await downloadReady;
    expect(download.suggestedFilename()).toBe("bridge-belief-features-v1.json");
    const path = await download.path();
    if (path === null) throw new Error("The feature download did not produce a file.");
    const contents = await readFile(path, "utf8");
    const features: unknown = JSON.parse(contents);
    expect(features).toMatchObject({
        schema: "bridge-declarer-features/v1", observer: "West", actor: "East", dummy: "East",
        hiddenSeats: ["North", "South"], played: [{ player: "North", card: 37 }],
        context: {
            dealer: "North", vulnerability: "east-west",
            auction: [
                { player: "North", call: "P" }, { player: "East", call: "P" }, { player: "South", call: "P" },
                { player: "West", call: "1NT" }, { player: "North", call: "P" },
                { player: "East", call: "P" }, { player: "South", call: "P" },
            ],
        },
    });
    expect(features).not.toHaveProperty("hands");
    expect(features).not.toHaveProperty("candidates");
    await page.getByRole("tab", { name: "Solver / Challenge", exact: true }).click();
    await page.getByRole("tab", { name: "Single-dummy advisor", exact: true }).click();
    await expect(page.locator("details.advisor-context")).toContainText("West: 1NT");
    await page.getByRole("button", { name: "Edit visible hands" }).click();
    await expect(page.getByRole("textbox", { name: "Complete auction, starting with dealer", exact: true })).toHaveValue("P P P 1NT P P P");
    expect(errors).toEqual([]);
});
