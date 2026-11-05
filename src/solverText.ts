import {
    DIRECTIONS,
    RANKS,
    SUITS,
    type Card,
    type Contract,
    type Doubling,
    type PlayedCard,
    type SolverInput,
    type EngineSolverResult, type EnginePositionAnalysis,
    type Suit,
} from "./bridge";
import { getTrickWinner } from "./play";

/** Short suit labels used to keep the command-line replay compact. */
const SUIT_ABBREVIATIONS: Record<Suit, string> = {
    spades: "S",
    hearts: "H",
    diamonds: "D",
    clubs: "C",
};

/** Contract suffixes used in the command-line summary. */
const DOUBLING_SUFFIXES: Record<Doubling, string> = {
    undoubled: "",
    doubled: "x",
    redoubled: "xx",
};

export const formatCard = (card: Card): string =>
    `${card.rank === "T" ? "10" : card.rank}${SUIT_ABBREVIATIONS[card.suit]}`;

/** Formats one play with the player's seat and a compact rank-suit label. */
export const formatPlayedCard = (play: PlayedCard): string =>
    `${play.player} ${formatCard(play.card)}`;

export const formatContract = (contract: Readonly<Contract>): string => {
    const strain = contract.strain === "no-trump" ? "NT" : SUIT_ABBREVIATIONS[contract.strain];
    return `${contract.level}${strain}${DOUBLING_SUFFIXES[contract.doubling]} by ${contract.declarer}`;
};

export const formatHands = (
    hands: SolverInput["hands"],
    heading = "Initial hands (Spades.Hearts.Diamonds.Clubs):",
): string => [
    heading,
    ...DIRECTIONS.map((direction) => {
        const suits = SUITS.map((suit) =>
            [...RANKS].reverse().filter((rank) => hands[direction][suit].includes(rank)).join("") || "-",
        );
        return `${direction}: ${suits.join(".")}`;
    }),
].join("\n");

export const formatAnalysisStatistics = (result: EnginePositionAnalysis): string => {
    const stats = result.statistics;
    return "engine" in stats
        ? `${(stats.elapsedMilliseconds / 1_000).toFixed(2)}s (library DDS; ${stats.positionsEvaluated} position calls)`
        : `${(stats.elapsedMilliseconds / 1_000).toFixed(2)}s (${stats.nodesVisited.toLocaleString()} nodes)`;
};

/** Formats a solver result as a readable trick-by-trick command-line replay. */
export const formatSolverResult = (
    input: SolverInput,
    result: EngineSolverResult,
): string => {
    if (result.line.length % 4 !== 0) {
        throw new Error("The solver result must contain complete four-card tricks.");
    }

    const totalTricks = result.line.length / 4;
    const lines = [
        `Contract: ${formatContract(input.contract)}`,
        `Contract makeable: ${result.canMakeContract ? "yes" : "no"}`,
        `Required tricks: ${result.requiredTricks}`,
        `Optimal declarer-side tricks: ${result.optimalDeclarerTricks} / ${totalTricks}`,
        `Declarer tricks in this line: ${result.declarerTricksInLine} / ${totalTricks}`,
        "One optimal line; equally optimal alternatives omitted:",
    ];

    for (let offset = 0; offset < result.line.length; offset += 4) {
        const trick = result.line.slice(offset, offset + 4);
        const trickNumber = offset / 4 + 1;
        const winner = getTrickWinner(trick, input.contract);
        const plays = trick.map(formatPlayedCard).join(", ");
        lines.push(`Trick ${trickNumber}: ${plays} | winner: ${winner}`);
    }

    if (totalTricks === 0) {
        lines.push("(No cards to play.)");
    }

    return lines.join("\n");
};
