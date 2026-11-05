import { describe, expect, it } from "vitest";
import {
    createEmptyHands,
    createSampleHands,
    DIRECTIONS,
    parseHandNotation,
    RANKS,
    SUITS,
    type Contract,
    type Direction,
    type Hands,
    type PlayedCard,
    type Rank,
    type SolverInput,
    type SolverResult,
    type Suit,
} from "./bridge";
import { createAnalysisSession, solveContract, solveTrickTarget, type SolverProgress } from "./solver";
import { buildPlayState, getLegalCards } from "./play";
import { formatSolverResult } from "./solverText";

const DEFAULT_CONTRACT: Contract = {
    level: 1,
    strain: "no-trump",
    declarer: "South",
    doubling: "undoubled",
};

/** Builds a solver input from the cards held by each seat. */
const createInput = (
    deal: Partial<Record<Direction, Partial<Record<Suit, readonly Rank[]>>>>,
    contract: Partial<Contract> = {},
): SolverInput => {
    const hands = createEmptyHands();
    for (const direction of DIRECTIONS) {
        for (const suit of SUITS) {
            hands[direction][suit] = [...(deal[direction]?.[suit] ?? [])];
        }
    }
    return { hands, contract: { ...DEFAULT_CONTRACT, ...contract } };
};

/** Advances clockwise without using the production search's turn helper. */
const nextSeat = (seat: Direction): Direction => {
    const next = DIRECTIONS[(DIRECTIONS.indexOf(seat) + 1) % 4];
    if (next === undefined) {
        throw new Error("Invalid test seat.");
    }
    return next;
};

/** Determines partnership independently of the production search. */
const isDeclarer = (seat: Direction, contract: Readonly<Contract>): boolean =>
    DIRECTIONS.indexOf(seat) % 2 === DIRECTIONS.indexOf(contract.declarer) % 2;

/** Resolves a trick independently of the production bitmask implementation. */
const findWinner = (
    trick: readonly PlayedCard[],
    contract: Readonly<Contract>,
): Direction => {
    let winner = trick[0];
    if (winner === undefined) {
        throw new Error("Empty test trick.");
    }
    for (const play of trick.slice(1)) {
        if (
            (play.card.suit === contract.strain && winner.card.suit !== contract.strain) ||
            (play.card.suit === winner.card.suit &&
                RANKS.indexOf(play.card.rank) > RANKS.indexOf(winner.card.rank))
        ) {
            winner = play;
        }
    }
    return winner.player;
};

/** Exhaustively evaluates a small deal, optionally after a replay prefix. No pruning or cache. */
const exactTricks = (input: SolverInput, prefix: readonly PlayedCard[] = []): number => {
    const hands = createEmptyHands();
    for (const seat of DIRECTIONS) {
        for (const suit of SUITS) hands[seat][suit] = [...input.hands[seat][suit]];
    }
    let seat = nextSeat(input.contract.declarer);
    let won = 0;
    let trick: PlayedCard[] = [];
    for (const play of prefix) {
        hands[play.player][play.card.suit] = hands[play.player][play.card.suit]
            .filter((rank) => rank !== play.card.rank);
        trick.push(play);
        seat = nextSeat(play.player);
        if (trick.length === 4) {
            seat = findWinner(trick, input.contract);
            won += Number(isDeclarer(seat, input.contract));
            trick = [];
        }
    }

    /** Enumerates all legal continuations to terminal trick totals. */
    const search = (player: Direction, current: PlayedCard[], tricksWon: number): number => {
        const hand = hands[player];
        const led = current[0]?.card.suit;
        const suits = led !== undefined && hand[led].length > 0 ? [led] : SUITS;
        const values: number[] = [];
        for (const suit of suits) {
            const original = hand[suit];
            for (const rank of original) {
                hand[suit] = original.filter((candidate) => candidate !== rank);
                const plays = [...current, { player, card: { suit, rank } }];
                if (plays.length === 4) {
                    const winner = findWinner(plays, input.contract);
                    values.push(search(winner, [], tricksWon + Number(isDeclarer(winner, input.contract))));
                } else {
                    values.push(search(nextSeat(player), plays, tricksWon));
                }
            }
            hand[suit] = original;
        }
        return values.length === 0
            ? tricksWon
            : isDeclarer(player, input.contract) ? Math.max(...values) : Math.min(...values);
    };
    return search(seat, trick, won);
};

/** Checks ownership, all 52/remaining cards, follow-suit, turn order, and the reported tally. */
const expectLegalReplay = (input: SolverInput, result: SolverResult): void => {
    const hands = createEmptyHands();
    let count = 0;
    for (const seat of DIRECTIONS) {
        for (const suit of SUITS) {
            hands[seat][suit] = [...input.hands[seat][suit]];
            count += hands[seat][suit].length;
        }
    }
    expect(result.line).toHaveLength(count);
    let player = nextSeat(input.contract.declarer);
    let won = 0;
    const trick: PlayedCard[] = [];
    for (const play of result.line) {
        expect(play.player).toBe(player);
        expect(hands[player][play.card.suit]).toContain(play.card.rank);
        const led = trick[0]?.card.suit;
        if (led !== undefined && hands[player][led].length > 0) {
            expect(play.card.suit).toBe(led);
        }
        hands[player][play.card.suit] = hands[player][play.card.suit]
            .filter((rank) => rank !== play.card.rank);
        trick.push(play);
        if (trick.length === 4) {
            player = findWinner(trick, input.contract);
            won += Number(isDeclarer(player, input.contract));
            trick.length = 0;
        } else {
            player = nextSeat(player);
        }
    }
    expect(trick).toHaveLength(0);
    expect(won).toBe(result.declarerTricksInLine);
    expect(won >= result.requiredTricks).toBe(result.canMakeContract);
};

/** Makes reproducible small deals containing gaps, sequences, voids, and varied partnerships. */
const seededDeal = (seed: number, cardsPerSeat: number): SolverInput => {
    let state = seed;
    const deck = SUITS.flatMap((suit) => RANKS.map((rank) => ({ suit, rank })));
    for (let index = deck.length - 1; index > 0; index -= 1) {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        const other = state % (index + 1);
        const card = deck[index];
        const swap = deck[other];
        if (card === undefined || swap === undefined) {
            throw new Error("Invalid test shuffle.");
        }
        deck[index] = swap;
        deck[other] = card;
    }
    const hands = createEmptyHands();
    DIRECTIONS.forEach((seat, seatIndex) => {
        for (const card of deck.slice(seatIndex * cardsPerSeat, (seatIndex + 1) * cardsPerSeat)) {
            hands[seat][card.suit].push(card.rank);
        }
    });
    const declarer = DIRECTIONS[seed % 4];
    const strain = [...SUITS, "no-trump" as const][seed % 5];
    if (declarer === undefined || strain === undefined) {
        throw new Error("Invalid test contract.");
    }
    return { hands, contract: { ...DEFAULT_CONTRACT, declarer, strain } };
};

/** Builds a full deal with one entire suit per seat. */
const singleSuitDeal = (strain: Contract["strain"]): SolverInput => {
    const hands: Hands = createEmptyHands();
    hands.North.spades = [...RANKS];
    hands.East.diamonds = [...RANKS];
    hands.South.hearts = [...RANKS];
    hands.West.clubs = [...RANKS];
    return { hands, contract: { ...DEFAULT_CONTRACT, declarer: "North", level: 7, strain } };
};

const resistanceDeal = (): SolverInput => createInput({
    North: { spades: ["A"], hearts: ["2"] },
    East: { spades: ["K"], clubs: ["2"] },
    South: { spades: ["Q"], hearts: ["3"] },
    West: { spades: ["J"], clubs: ["3"] },
});

describe("contract proof", () => {
    it("proves a grand slam with trumps and reconstructs all cards after an early proof", () => {
        const input = singleSuitDeal("spades");
        const original = JSON.stringify(input);
        const result = solveContract(input);
        expect(result.canMakeContract).toBe(true);
        expect(result.requiredTricks).toBe(13);
        expect(result.optimalDeclarerTricks).toBe(13);
        expectLegalReplay(input, result);
        expect(JSON.stringify(input)).toBe(original);
    });

    it("finds a defeating strategy for the same deal in no-trump", () => {
        const input = singleSuitDeal("no-trump");
        const result = solveContract(input);
        expect(result.canMakeContract).toBe(false);
        expect(result.optimalDeclarerTricks).toBe(0);
        expect(result.declarerTricksInLine).toBe(0);
        expectLegalReplay(input, result);
    });

    it("uses level + 6 without clamping the target for small deals", () => {
        const input = createInput({
            North: { spades: ["A"] }, East: { spades: ["K"] },
            South: { spades: ["Q"] }, West: { spades: ["2"] },
        });
        const result = solveContract(input);
        expect(result.requiredTricks).toBe(7);
        expect(result.canMakeContract).toBe(false);
        expect(result.optimalDeclarerTricks).toBe(1);
        expectLegalReplay(input, result);
    });

    it("distinguishes guaranteed success from a cooperative making line", () => {
        const input = resistanceDeal();
        expect(exactTricks(input)).toBe(1);
        for (const target of [1, 2]) {
            const result = solveTrickTarget(input, target);
            expect(result.canMakeContract).toBe(target === 1);
            expectLegalReplay(input, result);
        }
    });

    it("shows declarer's strongest attempt even when every attempt fails the target", () => {
        const input = resistanceDeal();
        const lead: PlayedCard = { player: "West", card: { suit: "clubs", rank: "3" } };
        const strongest: PlayedCard = { player: "North", card: { suit: "hearts", rank: "2" } };
        const weaker: PlayedCard = { player: "North", card: { suit: "spades", rank: "A" } };
        expect(exactTricks(input, [lead, strongest])).toBe(1);
        expect(exactTricks(input, [lead, weaker])).toBe(0);
        const result = solveTrickTarget(input, 2);
        expect(result.canMakeContract).toBe(false);
        expect(result.line.slice(0, 2)).toEqual([lead, strongest]);
        expect(result.optimalDeclarerTricks).toBe(1);
        expect(result.declarerTricksInLine).toBe(1);
        expectLegalReplay(input, result);
    });

    it("shows the strongest defense even when every defense allows the target", () => {
        const input = resistanceDeal();
        const strongest: PlayedCard = { player: "West", card: { suit: "clubs", rank: "3" } };
        const weaker: PlayedCard = { player: "West", card: { suit: "spades", rank: "J" } };
        expect(exactTricks(input, [strongest])).toBe(1);
        expect(exactTricks(input, [weaker])).toBe(2);
        const result = solveTrickTarget(input, 1);
        expect(result.canMakeContract).toBe(true);
        expect(result.line[0]).toEqual(strongest);
        expect(result.optimalDeclarerTricks).toBe(1);
        expect(result.declarerTricksInLine).toBe(1);
        expectLegalReplay(input, result);
    });

    it.each(Array.from({ length: 40 }, (_, index) => index + 1))(
        "matches exhaustive minimax and preserves the optimal value along every replay prefix (seed %i)",
        (seed) => {
            const cardsPerSeat = seed > 30 ? 4 + seed % 2 : seed % 3 + 1;
            const input = seededDeal(seed, cardsPerSeat);
            const optimum = exactTricks(input);
            const original = JSON.stringify(input);
            for (let target = 0; target <= cardsPerSeat + 1; target += 1) {
                const result = solveTrickTarget(input, target);
                expect(result.canMakeContract).toBe(optimum >= target);
                expectLegalReplay(input, result);
                for (let length = 1; length <= result.line.length; length += 1) {
                    expect(exactTricks(input, result.line.slice(0, length))).toBe(optimum);
                }
                expect(result.optimalDeclarerTricks).toBe(optimum);
                expect(result.declarerTricksInLine).toBe(optimum);
            }
            expect(JSON.stringify(input)).toBe(original);
        },
        30_000,
    );

    it("handles equivalent ranks without skipping intervening cards in hands or the trick", () => {
        const input = createInput({
            North: { spades: ["A", "Q", "T"] },
            East: { spades: ["K", "9"], hearts: ["A"] },
            South: { spades: ["J", "8"], hearts: ["K"] },
            West: { spades: ["7", "6"], hearts: ["Q"] },
        });
        const optimum = exactTricks(input);
        for (let target = 1; target <= 3; target += 1) {
            const result = solveTrickTarget(input, target);
            expect(result.canMakeContract).toBe(optimum >= target);
            expect(result.optimalDeclarerTricks).toBe(optimum);
            expect(result.declarerTricksInLine).toBe(optimum);
            expectLegalReplay(input, result);
        }
    });

    it.each(["no-trump", ...SUITS] as const)(
        "checks reachable and blocked partner winners, including ruffs (%s)",
        (strain) => {
            const deals = [
                {
                    East: { spades: ["A"], hearts: ["2"], clubs: ["2"] },
                    West: { spades: ["2"], hearts: ["A"], clubs: ["A"] },
                    North: { spades: ["K"], hearts: ["K"], diamonds: ["A"] },
                    South: { spades: ["Q"], hearts: ["Q"], diamonds: ["K"] },
                },
                {
                    East: { spades: ["4", "3", "2"] },
                    West: { hearts: ["A", "K", "Q"] },
                    North: { spades: ["A", "K", "Q"] },
                    South: { clubs: ["A", "K", "Q"] },
                },
                {
                    East: { spades: ["A", "Q"], hearts: ["2"] },
                    West: { spades: ["K"], hearts: ["A", "K"] },
                    North: { spades: ["J"], hearts: ["Q"], diamonds: ["A"] },
                    South: { spades: ["T"], hearts: ["J"], diamonds: ["K"] },
                },
                {
                    East: { spades: ["A", "2"], hearts: ["2"] },
                    West: { spades: ["K", "Q", "3"] },
                    North: { spades: ["J", "T", "9"] },
                    South: { spades: ["8", "7", "6"] },
                },
                {
                    East: { spades: ["A"], hearts: ["3"], clubs: ["3"] },
                    West: { spades: ["K", "Q", "2"] },
                    North: { spades: ["J"], hearts: ["A"], clubs: ["A"] },
                    South: { spades: ["T"], hearts: ["K"], clubs: ["K"] },
                },
                {
                    East: { spades: ["K"], hearts: ["3"], clubs: ["3"] },
                    West: { spades: ["A", "Q", "2"] },
                    North: { spades: ["J"], hearts: ["A"], clubs: ["A"] },
                    South: { spades: ["T"], hearts: ["K"], clubs: ["K"] },
                },
                {
                    East: { spades: ["A", "K", "2"] },
                    West: { spades: ["Q"], hearts: ["2"], clubs: ["2"] },
                    North: { spades: ["J", "T"], hearts: ["A"] },
                    South: { spades: ["9"], hearts: ["K"], clubs: ["A"] },
                },
            ] satisfies Parameters<typeof createInput>[0][];
            for (const deal of deals) {
                const input = createInput(deal, { declarer: "North", strain });
                const optimum = exactTricks(input);
                for (let target = 0; target <= 4; target += 1) {
                    const result = solveTrickTarget(input, target);
                    expect(result.optimalDeclarerTricks).toBe(optimum);
                    expectLegalReplay(input, result);
                    for (let length = 1; length <= result.line.length; length += 1) {
                        expect(exactTricks(input, result.line.slice(0, length))).toBe(optimum);
                    }
                }
            }
        },
    );

    it.each([
        {
            name: "a forced entry followed by winners in another suit",
            strain: "no-trump",
            deal: {
                East: { spades: ["K", "Q", "J"] },
                South: { spades: ["2"], clubs: ["K", "Q"] },
                West: { spades: ["3"], hearts: ["A"], clubs: ["J"] },
                North: { spades: ["A"], clubs: ["A"], hearts: ["2"] },
            },
        },
        {
            name: "different winners after alternative losing leads",
            strain: "no-trump",
            deal: {
                East: { spades: ["K", "Q"], hearts: ["K"] },
                South: { spades: ["A"], clubs: ["A"], diamonds: ["2"] },
                West: { spades: ["2"], hearts: ["2"], diamonds: ["A"] },
                North: { hearts: ["A"], diamonds: ["K", "Q"] },
            },
        },
        {
            name: "an escape lead that avoids an opposing entry",
            strain: "no-trump",
            deal: {
                East: { spades: ["K"], hearts: ["A", "K"] },
                North: { spades: ["A"], hearts: ["Q"], diamonds: ["2"] },
                South: { spades: ["Q"], hearts: ["J"], diamonds: ["A"] },
                West: { spades: ["2"], hearts: ["T"], diamonds: ["K"] },
            },
        },
        {
            name: "top trumps without an initial entry",
            strain: "spades",
            deal: {
                East: { spades: ["J"], hearts: ["A", "K"] },
                South: { spades: ["Q"], diamonds: ["A", "K"] },
                West: { spades: ["T"], clubs: ["A", "K"] },
                North: { spades: ["A", "K"], diamonds: ["2"] },
            },
        },
    ] satisfies {
        name: string;
        strain: Contract["strain"];
        deal: Parameters<typeof createInput>[0];
    }[])("checks $name for either partnership and every target", ({ deal, strain }) => {
        for (const declarer of DIRECTIONS) {
            const input = createInput(deal, { declarer, strain });
            const optimum = exactTricks(input);
            for (let target = 0; target <= 4; target += 1) {
                const result = solveTrickTarget(input, target);
                expect(result.canMakeContract).toBe(optimum >= target);
                expect(result.optimalDeclarerTricks).toBe(optimum);
                expectLegalReplay(input, result);
                for (let length = 1; length <= result.line.length; length += 1) {
                    expect(exactTricks(input, result.line.slice(0, length))).toBe(optimum);
                }
            }
        }
    });

    it.each(["no-trump", ...SUITS] as const)(
        "checks forced honor promotion, defensive ducks, blocked entries, and ruffs (%s)",
        (strain) => {
            const deals = [
                {
                    East: { spades: ["A", "Q"], hearts: ["2"] },
                    West: { spades: ["3", "2"], clubs: ["2"] },
                    North: { spades: ["K"], hearts: ["A"], clubs: ["A"] },
                    South: { spades: ["J", "T"], clubs: ["K"] },
                },
                {
                    East: { spades: ["A", "Q"], hearts: ["2"] },
                    West: { spades: ["3", "2"], clubs: ["2"] },
                    North: { spades: ["K", "9"], clubs: ["A"] },
                    South: { spades: ["J", "T"], clubs: ["K"] },
                },
                {
                    East: { spades: ["A", "K", "J"] },
                    West: { spades: ["3", "2"], clubs: ["2"] },
                    North: { spades: ["Q", "9"], clubs: ["A"] },
                    South: { spades: ["T", "8"], clubs: ["K"] },
                },
                {
                    East: { spades: ["A"], hearts: ["A"], clubs: ["2"] },
                    West: { spades: ["Q", "J", "2"] },
                    North: { spades: ["K"], hearts: ["K"], clubs: ["A"] },
                    South: { spades: ["T", "9"], clubs: ["K"] },
                },
            ] satisfies Parameters<typeof createInput>[0][];
            for (const deal of deals) {
                const input = createInput(deal, { declarer: "North", strain });
                const optimum = exactTricks(input);
                for (let target = 0; target <= 4; target += 1) {
                    const result = solveTrickTarget(input, target);
                    expect(result.canMakeContract).toBe(optimum >= target);
                    expect(result.optimalDeclarerTricks).toBe(optimum);
                    expectLegalReplay(input, result);
                    for (let length = 1; length <= result.line.length; length += 1) {
                        expect(exactTricks(input, result.line.slice(0, length))).toBe(optimum);
                    }
                }
            }
        },
    );

    it("returns a complete empty replay for empty input", () => {
        const result = solveContract(createInput({}));
        expect(result.canMakeContract).toBe(false);
        expect(result.line).toEqual([]);
        expect(result.optimalDeclarerTricks).toBe(0);
        expect(result.declarerTricksInLine).toBe(0);
    });

    it("keeps the cache bounded through full-deal refinement and replays optimal resistance", () => {
        const notations: Record<Direction, string> = {
            North: "AKQJ2.KQ3.A54.76",
            East: "T98.AT72.KQ2.KQ3",
            South: "765.965.J987.AT9",
            West: "43.J84.T63.J8542",
        };
        const hands = createEmptyHands();
        for (const seat of DIRECTIONS) {
            const parsed = parseHandNotation(notations[seat]);
            if (!parsed.ok) {
                throw new Error(parsed.error);
            }
            hands[seat] = parsed.hand;
        }
        const input: SolverInput = {
            hands, contract: { ...DEFAULT_CONTRACT, level: 3, declarer: "North" },
        };
        const original = JSON.stringify(input);
        const updates: SolverProgress[] = [];
        const result = solveContract(input, (update) => updates.push(update));
        expect(result.canMakeContract).toBe(false);
        expect(result.requiredTricks).toBe(9);
        expect(result.optimalDeclarerTricks).toBe(8);
        expect(result.declarerTricksInLine).toBe(8);
        expectLegalReplay(input, result);
        expect(result.statistics.cacheEntries).toBeLessThanOrEqual(250_000);
        for (const update of updates) expect(update.cacheEntries).toBeLessThanOrEqual(250_000);
        expect(JSON.stringify(input)).toBe(original);
    }, 30_000);

    it("keeps partner honors out of the sure-trick bound during full-deal refinement", () => {
        const input: SolverInput = {
            hands: createSampleHands(),
            contract: {
                ...DEFAULT_CONTRACT,
                level: 2,
                strain: "spades",
                declarer: "North",
            },
        };
        const result = solveContract(input);
        expect(result.canMakeContract).toBe(true);
        expect(result.optimalDeclarerTricks).toBe(9);
        expect(result.declarerTricksInLine).toBe(9);
        expectLegalReplay(input, result);
    }, 30_000);

    it("rejects invalid levels, targets, duplicate cards, and unequal hands", () => {
        expect(() => solveContract(createInput({}, { level: 0 }))).toThrow(/level/i);
        expect(() => solveTrickTarget(createInput({}), -1)).toThrow(/target/i);
        expect(() => solveTrickTarget(createInput({}), 1.5)).toThrow(/target/i);
        expect(() => solveTrickTarget(createInput({}), 14)).toThrow(/target/i);
        expect(() => solveContract(createInput({
            North: { spades: ["A"] }, East: { spades: ["A"] },
        }))).toThrow(/more than once/i);
        expect(() => solveContract(createInput({ North: { spades: ["A"] } }))).toThrow(/same number/i);
    });
});

describe("progress and output", () => {
    it("reports proof, refinement, replay, completion, and separate timing statistics", () => {
        const input = singleSuitDeal("spades");
        const updates: SolverProgress[] = [];
        const result = solveContract(input, (update) => updates.push(update));
        expect(updates[0]).toMatchObject({
            phase: "proof", nodesVisited: 0, trickNumber: 1, totalTricks: 13, playerToMove: "East",
        });

        expect(updates.map((update) => update.phase)).toEqual(["proof", "refinement", "replay", "complete"]);
        expect(result.statistics.proofMilliseconds).toBeGreaterThanOrEqual(0);
        expect(result.statistics.refinementMilliseconds).toBeGreaterThanOrEqual(0);
        expect(result.statistics.replayMilliseconds).toBeGreaterThanOrEqual(0);
        expect(result.statistics.nodesVisited).toBeGreaterThan(0);
        expect(result.statistics.cacheEntries).toBeLessThanOrEqual(250_000);
        expect(updates.at(-1)?.nodesVisited).toBe(result.statistics.nodesVisited);
        expect(updates.at(-1)?.cacheHits).toBe(result.statistics.cacheHits);
        expect(updates.at(-1)?.cacheEntries).toBe(result.statistics.cacheEntries);
    });

    it("prints make/set and the exact optimal tally with an optimal-play explanation", () => {
        const input = singleSuitDeal("spades");
        const text = formatSolverResult(input, solveContract(input));
        expect(text).toContain("Contract: 7S by North");
        expect(text).toContain("Contract makeable: yes");
        expect(text).toContain("Required tricks: 13");
        expect(text).toContain("Optimal declarer-side tricks: 13 / 13");
        expect(text).toContain("Declarer tricks in this line: 13 / 13");
        expect(text).toContain("Trick 13:");
        expect(text).toContain("One optimal line; equally optimal alternatives omitted:");
        expect(text).not.toContain("not necessarily");
        const down = singleSuitDeal("no-trump");
        expect(formatSolverResult(down, solveContract(down))).toContain("Contract makeable: no");
    });
});

describe("interactive position analysis", () => {
    it("combines a two-round entry with partner's winners without searching a trick", async () => {
        const input = createInput({
            North: { diamonds: ["A", "2"], hearts: ["7", "6", "5", "4", "3"] },
            South: { diamonds: ["K", "3"], clubs: ["A", "K", "Q", "J", "T"] },
            East: { diamonds: ["Q", "J"], hearts: ["A", "K", "Q", "T", "9"] },
            West: { diamonds: ["T", "9"], hearts: ["J", "8"], clubs: ["9", "8", "7"] },
        }, { declarer: "West" });
        const session = createAnalysisSession(input);
        try {
            const result = await session.analyze([], new AbortController().signal);
            expect(result.optimalDeclarerTricks).toBe(0);
            expect(result.statistics.phaseStatistics.proof.nodesVisited).toBe(1);
            expect(result.statistics.phaseStatistics.refinement.probeCount).toBe(0);
        } finally {
            session.dispose();
        }
    });

    it.each(["no-trump", ...SUITS] as const)(
        "checks multi-round entries, forced overtakes, and overlapping cashes against the oracle (%s)",
        async (strain) => {
            const deals = [
                {
                    East: { diamonds: ["A", "2"], hearts: ["3", "2"] },
                    West: { diamonds: ["K", "3"], clubs: ["A", "K"] },
                    North: { diamonds: ["Q", "J"], hearts: ["A"], clubs: ["Q"] },
                    South: { diamonds: ["T", "9"], hearts: ["K"], clubs: ["J"] },
                },
                {
                    East: { diamonds: ["A", "2"], hearts: ["3", "2"] },
                    West: { diamonds: ["K"], clubs: ["A", "K", "Q"] },
                    North: { diamonds: ["Q", "J"], hearts: ["A"], clubs: ["J"] },
                    South: { diamonds: ["T", "9"], hearts: ["K"], clubs: ["T"] },
                },
                {
                    East: { diamonds: ["2"], hearts: ["4", "3", "2"] },
                    West: { diamonds: ["A", "K"], clubs: ["A", "K"] },
                    North: { diamonds: ["Q", "J"], hearts: ["A"], clubs: ["Q"] },
                    South: { diamonds: ["T", "9"], hearts: ["K"], clubs: ["J"] },
                },
                {
                    East: { diamonds: ["A", "Q", "2"], hearts: ["2"] },
                    West: { diamonds: ["K"], clubs: ["A", "K", "Q"] },
                    North: { diamonds: ["J", "T"], hearts: ["A"], clubs: ["J"] },
                    South: { diamonds: ["9", "8"], hearts: ["K"], clubs: ["T"] },
                },
            ] satisfies Parameters<typeof createInput>[0][];
            for (const deal of deals) {
                const input = createInput(deal, { strain, declarer: "North" });
                const optimum = exactTricks(input);
                for (let target = 0; target <= 5; target += 1) {
                    const result = solveTrickTarget(input, target);
                    expect(result.optimalDeclarerTricks).toBe(optimum);
                    expectLegalReplay(input, result);
                }
                const session = createAnalysisSession(input);
                try {
                    for (let branch = 0; branch < 2; branch += 1) {
                        const history: PlayedCard[] = [];
                        for (let step = 0; step < 16; step += 1) {
                            const result = await session.analyze(history, new AbortController().signal);
                            const expected = exactTricks(input, history);
                            expect(result.optimalDeclarerTricks).toBe(expected);
                            const board = buildPlayState(input, history);
                            for (const card of result.recommendedCards) {
                                expect(exactTricks(input, [...history, { player: board.playerToMove, card }]))
                                    .toBe(expected);
                            }
                            const legal = getLegalCards(board);
                            const card = legal[(step + branch) % legal.length];
                            if (card === undefined) {
                                throw new Error("Missing entry regression move.");
                            }
                            history.push({ player: board.playerToMove, card });
                        }
                    }
                } finally {
                    session.dispose();
                }
            }
        },
        30_000,
    );

    it.each([1, 2, 3])("certifies an entry and following cashes after %i cards without branching", async (length) => {
        const input = createInput({
            East: { spades: ["A", "K", "Q", "J", "T", "9", "8"] },
            North: { spades: ["7"], hearts: ["6", "5", "4", "3", "2"], clubs: ["2"] },
            West: { clubs: ["A", "K", "Q", "J", "T", "9", "8"] },
            South: { spades: ["6", "5", "4", "3", "2"], clubs: ["4", "3"] },
        }, { declarer: "West" });
        const history: PlayedCard[] = [
            { player: "North", card: { suit: "spades", rank: "7" } },
            { player: "East", card: { suit: "spades", rank: "A" } },
            { player: "South", card: { suit: "spades", rank: "6" } },
        ];
        const session = createAnalysisSession(input);
        try {
            const result = await session.analyze(history.slice(0, length), new AbortController().signal);
            expect(result.optimalDeclarerTricks).toBe(7);
            expect(result.statistics.phaseStatistics.proof.nodesVisited).toBe(1);
            expect(result.statistics.phaseStatistics.refinement.probeCount).toBe(0);
        } finally {
            session.dispose();
        }
    });

    it.each([
        {
            name: "a singleton king",
            recommendedRanks: ["A"],
            North: { spades: ["A", "Q", "J", "T", "9", "8", "7"] },
            East: { spades: ["K"], hearts: ["6", "5", "4", "3", "2"], clubs: ["2"] },
            South: { clubs: ["A", "K", "Q", "J", "T", "9", "8"] },
            West: { spades: ["6", "5", "4", "3", "2"], clubs: ["4", "3"] },
        },
        {
            name: "a doubleton queen",
            recommendedRanks: ["K", "A"],
            North: { spades: ["A", "K", "J", "T", "9", "8", "7"] },
            East: { spades: ["Q", "2"], hearts: ["6", "5", "4", "3", "2"] },
            South: { clubs: ["A", "K", "Q", "J", "T", "9", "8"] },
            West: { spades: ["6", "5", "4", "3"], clubs: ["4", "3", "2"] },
        },
    ] satisfies (Parameters<typeof createInput>[0] & { name: string; recommendedRanks: readonly Rank[] })[])(
        "proves a complete cashing sweep after exhausting $name without refinement",
        async ({ name: _name, recommendedRanks, ...deal }) => {
            const input = createInput(deal, { declarer: "West" });
            const session = createAnalysisSession(input);
            try {
                const result = await session.analyze([], new AbortController().signal);
                expect(result.optimalDeclarerTricks).toBe(0);
                expect(result.statistics.phaseStatistics.refinement.probeCount).toBe(0);
                expect(result.recommendedCards).toEqual(recommendedRanks.map((rank) => ({ suit: "spades", rank })));
            } finally {
                session.dispose();
            }
        },
    );

    it("solves the full DDS comparison deal with fewer than one million searched nodes", async () => {
        const hands = createEmptyHands();
        const notations: Record<Direction, string> = {
            North: "9.JT986.KQ82.A54",
            East: "Q7652.32.JT.KT63",
            South: "KT843.K74.A7.J98",
            West: "AJ.AQ5.96543.Q72",
        };
        for (const seat of DIRECTIONS) {
            const parsed = parseHandNotation(notations[seat]);
            if (!parsed.ok) {
                throw new Error(parsed.error);
            }
            hands[seat] = parsed.hand;
        }
        const session = createAnalysisSession({
            hands, contract: { ...DEFAULT_CONTRACT, declarer: "West" },
        });
        try {
            const result = await session.analyze([], new AbortController().signal);
            expect(result.optimalDeclarerTricks).toBe(6);
            expect(result.canMakeContract).toBe(false);
            expect(result.recommendedCards).toEqual([
                { suit: "diamonds", rank: "Q" }, { suit: "diamonds", rank: "K" },
            ]);
            expect(result.statistics.nodesVisited).toBeLessThan(1_000_000);
            expect(result.statistics.cacheEntries).toBeLessThanOrEqual(250_000);
        } finally {
            session.dispose();
        }
    }, 30_000);

    it.each([
        [101, 2], [102, 1], [103, 2], [104, 4], [105, 4], [106, 4],
        [107, 5], [108, 3], [109, 5], [110, 4], [111, 6], [112, 1],
        [113, 0], [114, 2], [115, 0], [116, 3], [117, 5],
    ])("preserves the certified larger-position value for seed %i", (seed, optimum) => {
        const cards = 5 + seed % 4;
        const input = seededDeal(seed, cards);
        for (const target of [Math.floor(cards / 2), cards]) {
            const result = solveTrickTarget(input, target);
            expect(result.optimalDeclarerTricks).toBe(optimum);
            expect(result.canMakeContract).toBe(optimum >= target);
            expectLegalReplay(input, result);
            expect(result.statistics.cacheEntries).toBeLessThanOrEqual(250_000);
        }
    });

    it.each(Array.from({ length: 40 }, (_, index) => index + 51))(
        "preserves exact values and recommendations while reusing rank proofs across branches (seed %i)",
        async (seed) => {
            const input = seededDeal(seed, 4);
            const session = createAnalysisSession(input);
            const signal = new AbortController().signal;
            try {
                for (let branch = 0; branch < 3; branch += 1) {
                    const history: PlayedCard[] = [];
                    for (let step = 0; step < 16; step += 1) {
                        const result = await session.analyze(history, signal);
                        const optimum = exactTricks(input, history);
                        expect(result.optimalDeclarerTricks).toBe(optimum);
                        const board = buildPlayState(input, history);
                        for (const card of result.recommendedCards) {
                            expect(exactTricks(input, [...history, { player: board.playerToMove, card }]))
                                .toBe(optimum);
                        }
                        const legal = getLegalCards(board);
                        const card = legal[(seed + branch + step) % legal.length];
                        if (card === undefined) {
                            throw new Error("Missing branch move.");
                        }
                        history.push({ player: board.playerToMove, card });
                    }
                }
            } finally {
                session.dispose();
            }
        },
    );

    it("reports probe counts and search work separately for each analysis phase", async () => {
        const session = createAnalysisSession(resistanceDeal());
        try {
            const result = await session.analyze([], new AbortController().signal);
            const phases = result.statistics.phaseStatistics;
            const phaseValues = Object.values(phases);

            expect(phases.proof.probeCount).toBeGreaterThan(0);
            expect(phases.refinement.probeCount).toBeGreaterThan(0);
            expect(phases.recommendation.probeCount).toBeGreaterThan(0);
            expect(phaseValues.reduce((total, phase) => total + phase.nodesVisited, 0))
                .toBe(result.statistics.nodesVisited);
            expect(phaseValues.reduce((total, phase) => total + phase.cacheHits, 0))
                .toBe(result.statistics.cacheHits);
        } finally {
            session.dispose();
        }
    });

    it("keeps ranks separated by cards already on the table in different recommendation groups", async () => {
        const input = createInput({
            North: { spades: ["9", "Q"] },
            East: { spades: ["J"], hearts: ["A"] },
            South: { spades: ["T"], hearts: ["K"] },
            West: { spades: ["2"], hearts: ["Q"] },
        }, { declarer: "North" });
        const session = createAnalysisSession(input);
        const history: PlayedCard[] = [
            { player: "East", card: { suit: "spades", rank: "J" } },
            { player: "South", card: { suit: "spades", rank: "T" } },
            { player: "West", card: { suit: "spades", rank: "2" } },
        ];
        const result = await session.analyze(history, new AbortController().signal);
        expect(result.optimalDeclarerTricks).toBe(2);
        expect(result.recommendedCards).toEqual([{ suit: "spades", rank: "Q" }]);
        expect(exactTricks(input, [...history, { player: "North", card: { suit: "spades", rank: "9" } }])).toBe(0);
        session.dispose();
    });

    it("updates totals in both directions after mistakes, while yellow optimal alternatives preserve them", async () => {
        const observed = new Set<string>();
        for (let seed = 1; seed <= 24; seed += 1) {
            const input = seededDeal(seed, 3);
            const session = createAnalysisSession(input);
            const signal = new AbortController().signal;
            const root = await session.analyze([], signal);
            const board = buildPlayState(input);
            for (const card of getLegalCards(board)) {
                const history = [{ player: board.playerToMove, card }];
                const result = await session.analyze(history, signal);
                const exact = exactTricks(input, history);
                expect(result.optimalDeclarerTricks).toBe(exact);
                if (!root.recommendedCards.some((best) => best.suit === card.suit && best.rank === card.rank)) {
                    observed.add(exact === root.optimalDeclarerTricks ? "yellow-optimal" : "defender-mistake");
                    expect(result.statistics.inheritedValue).toBe(false);
                }
                const child = buildPlayState(input, history);
                for (const reply of getLegalCards(child)) {
                    const continued = [...history, { player: child.playerToMove, card: reply }];
                    const response = await session.analyze(continued, signal);
                    expect(response.optimalDeclarerTricks).toBe(exactTricks(input, continued));
                    if (response.optimalDeclarerTricks < exact) {
                        observed.add("declarer-mistake");
                    }
                }
            }
            session.dispose();
            if (observed.size === 3) {
                break;
            }
        }
        expect([...observed].sort()).toEqual(["declarer-mistake", "defender-mistake", "yellow-optimal"]);
    });

    it("yields during a live full-deal search, unwinds on cancellation, and then reuses the session", async () => {
        const input: SolverInput = {
            hands: createSampleHands(),
            contract: { ...DEFAULT_CONTRACT, declarer: "North", level: 3 },
        };
        const session = createAnalysisSession(input);
        const controller = new AbortController();
        let timerRan = false;
        const timer = setTimeout(() => { timerRan = true; controller.abort(); }, 0);
        try {
            await expect(session.analyze([], controller.signal)).rejects.toMatchObject({ name: "AbortError" });
            expect(timerRan).toBe(true);
            const signal = new AbortController().signal;
            const result = await session.analyze([], signal);
            expect(result.optimalDeclarerTricks).toBe(8);
            expect(result.statistics.cacheEntries).toBeLessThanOrEqual(250_000);
            const restored = await session.analyze([], signal);
            expect(restored.statistics.fromCache).toBe(true);
            expect(restored.statistics.nodesVisited).toBe(0);
        } finally {
            clearTimeout(timer);
            session.dispose();
        }
    }, 30_000);

    it.each(Array.from({ length: 16 }, (_, index) => index + 1))(
        "matches the independent oracle after arbitrary plays, including unfinished tricks (seed %i)",
        async (seed) => {
            const input = seededDeal(seed, 3);
            const original = JSON.stringify(input);
            const session = createAnalysisSession(input);
            const signal = new AbortController().signal;
            const history: PlayedCard[] = [];
            for (let step = 0; step <= 12; step += 1) {
                const result = await session.analyze(history, signal);
                const optimum = exactTricks(input, history);
                expect(result.optimalDeclarerTricks).toBe(optimum);
                expect(result.canMakeContract).toBe(optimum >= input.contract.level + 6);
                const state = buildPlayState(input, history);
                const legal = getLegalCards(state);
                if (state.isComplete) {
                    expect(result.recommendedCards).toEqual([]);
                    break;
                }
                expect(result.recommendedCards.length).toBeGreaterThan(0);
                for (const card of result.recommendedCards) {
                    expect(legal).toContainEqual(card);
                    expect(exactTricks(input, [...history, { player: state.playerToMove, card }])).toBe(optimum);
                }
                const card = legal[(seed + step) % legal.length];
                if (card === undefined) {
                    throw new Error("No test move.");
                }
                history.push({ player: state.playerToMove, card });
            }
            const restored = await session.analyze([], signal);
            expect(restored.statistics.fromCache).toBe(true);
            expect(restored.optimalDeclarerTricks).toBe(exactTricks(input));
            expect(JSON.stringify(input)).toBe(original);
            session.dispose();
        },
    );

    it("highlights one equivalent group, not every optimal choice", async () => {
        const input = createInput({
            North: { spades: ["A", "K"], hearts: ["A"] },
            East: { spades: ["Q"], hearts: ["K", "Q"] },
            South: { spades: ["J"], hearts: ["J", "T"] },
            West: { spades: ["T", "9"], hearts: ["9"] },
        });
        const session = createAnalysisSession(input);
        const result = await session.analyze([], new AbortController().signal);
        expect([
            [{ suit: "spades", rank: "9" }, { suit: "spades", rank: "T" }],
            [{ suit: "hearts", rank: "9" }],
        ]).toContainEqual(result.recommendedCards);
        for (const card of result.recommendedCards) {
            expect(exactTricks(input, [{ player: "West", card }])).toBe(result.optimalDeclarerTricks);
        }
        const legal = getLegalCards(buildPlayState(input));
        expect(legal.length).toBeGreaterThan(result.recommendedCards.length);
        session.dispose();
    });

    it("inherits exact totals after a recommended move and reuses undo results", async () => {
        const input = resistanceDeal();
        const session = createAnalysisSession(input);
        const signal = new AbortController().signal;
        const root = await session.analyze([], signal);
        const card = root.recommendedCards[0];
        if (card === undefined) {
            throw new Error("Missing recommendation.");
        }
        const state = buildPlayState(input);
        const history = [{ player: state.playerToMove, card }];
        const child = await session.analyze(history, signal);
        expect(child.optimalDeclarerTricks).toBe(root.optimalDeclarerTricks);
        expect(child.statistics.inheritedValue).toBe(true);
        const undo = await session.analyze([], signal);
        expect(undo.statistics.nodesVisited).toBe(0);
        expect(undo.statistics.fromCache).toBe(true);
        session.dispose();
    });

    it("rejects aborted, disposed, and illegal-history requests instead of returning a false proof", async () => {
        const session = createAnalysisSession(resistanceDeal());
        const controller = new AbortController();
        controller.abort();
        await expect(session.analyze([], controller.signal)).rejects.toMatchObject({ name: "AbortError" });
        await expect(session.analyze([
            { player: "North", card: { suit: "spades", rank: "A" } },
        ], new AbortController().signal)).rejects.toThrow(/turn/i);
        session.dispose();
        await expect(session.analyze([], new AbortController().signal)).rejects.toThrow(/closed/i);
    });
});
