/** Seats in clockwise order, starting at North. */
export const DIRECTIONS = ["North", "East", "South", "West"] as const;
/** A compass seat at the bridge table. */
export type Direction = (typeof DIRECTIONS)[number];

/** Suits in spades-hearts-diamonds-clubs order. */
export const SUITS = ["spades", "hearts", "diamonds", "clubs"] as const;
/** One of the four bridge suits. */
export type Suit = (typeof SUITS)[number];

/** Card ranks in ascending strength order, with T representing ten. */
export const RANKS = [
    "2",
    "3",
    "4",
    "5",
    "6",
    "7",
    "8",
    "9",
    "T",
    "J",
    "Q",
    "K",
    "A",
] as const;
/** A standard playing-card rank from ace through two. */
export type Rank = (typeof RANKS)[number];

/** A trump suit, or no-trump. */
export type Strain = Suit | "no-trump";
/** The contract's doubling state, retained for scoring. */
export type Doubling = "undoubled" | "doubled" | "redoubled";

/** Cards held by one seat, grouped by suit. */
export interface Hand {
    /** Spades held by this seat. */
    spades: Rank[];
    /** Hearts held by this seat. */
    hearts: Rank[];
    /** Diamonds held by this seat. */
    diamonds: Rank[];
    /** Clubs held by this seat. */
    clubs: Rank[];
}

/** The four hands that make up a deal. */
export type Hands = Record<Direction, Hand>;

/** The final contract and the player who declared it. */
export interface Contract {
    /** Bid level, from one through seven. */
    level: number;
    /** Trump suit or no-trump. */
    strain: Strain;
    /** Player who declared the contract. */
    declarer: Direction;
    /** Whether the contract was doubled or redoubled. */
    doubling: Doubling;
}

/** Immutable deal and contract submitted to the solver. */
export interface SolverInput {
    /** Cards assigned to each seat, grouped by suit. */
    hands: Readonly<
        Record<Direction, Readonly<Record<Suit, readonly Rank[]>>>
    >;
    /** Contract to evaluate. */
    contract: Readonly<Contract>;
}

/** A single card identified by suit and rank. */
export interface Card {
    readonly suit: Suit;
    readonly rank: Rank;
}

/** A card played by a seat in the solver's optimal continuation. */
export interface PlayedCard {
    /** Seat that played the card. */
    readonly player: Direction;
    /** Card played to the trick. */
    readonly card: Card;
}

/** Timings and counters covering proof, exact-value refinement, and replay. */
export interface SolverStatistics {
    readonly proofMilliseconds: number;
    readonly refinementMilliseconds: number;
    readonly replayMilliseconds: number;
    readonly nodesVisited: number;
    readonly cacheHits: number;
    readonly cacheEntries: number;
}

/** Proven make/set outcome, exact trick value, and a complete optimal continuation. */
export interface SolverResult {
    /** Whether declarer can force the target against every defense. */
    readonly canMakeContract: boolean;
    readonly requiredTricks: number;
    /** Maximum tricks declarer can force against optimal defense. */
    readonly optimalDeclarerTricks: number;
    /** One line preserving the exact trick value at every decision by both sides. */
    readonly line: readonly PlayedCard[];
    /** Final replay tally, equal to optimalDeclarerTricks. */
    readonly declarerTricksInLine: number;
    readonly statistics: SolverStatistics;
}

export type AnalysisPhase = "proof" | "refinement" | "recommendation";

export interface AnalysisPhaseStatistics {
    readonly elapsedMilliseconds: number;
    readonly nodesVisited: number;
    readonly cacheHits: number;
    readonly probeCount: number;
}

/** Exact value and one certified recommendation group for the actual current position. */
export interface PositionAnalysis {
    readonly optimalDeclarerTricks: number;
    readonly canMakeContract: boolean;
    readonly recommendedCards: readonly Card[];
    readonly statistics: {
        readonly elapsedMilliseconds: number;
        readonly nodesVisited: number;
        readonly cacheHits: number;
        readonly cacheEntries: number;
        readonly fromCache: boolean;
        readonly inheritedValue: boolean;
        readonly phaseStatistics: Readonly<Record<AnalysisPhase, AnalysisPhaseStatistics>>;
    };
}

export interface AnalysisSession {
    analyze: (history: readonly PlayedCard[], signal: AbortSignal) => Promise<PositionAnalysis>;
    dispose: () => void;
}

export interface DdsStatistics {
    readonly engine: "dds";
    readonly elapsedMilliseconds: number;
    readonly positionsEvaluated: number;
    readonly cacheEntries: number;
    readonly fromCache: boolean;
    readonly inheritedValue: false;
}

export type EnginePositionAnalysis = Omit<PositionAnalysis, "statistics"> & {
    readonly statistics: PositionAnalysis["statistics"] | DdsStatistics;
};

export type EngineSolverResult = Omit<SolverResult, "statistics"> & {
    readonly statistics: SolverStatistics | DdsStatistics;
};

export interface EngineAnalysisSession {
    analyze: (history: readonly PlayedCard[], signal: AbortSignal) => Promise<EnginePositionAnalysis>;
    dispose: () => void;
}

export type AnalysisSessionFactory = (input: SolverInput) => EngineAnalysisSession;

/** Successful hand-notation parse or a description of why it failed. */
export type HandParseResult =
    | { ok: true; hand: Hand }
    | { ok: false; error: string };

/** Card counts and validity summary for a partially or fully entered deal. */
export interface DealAssessment {
    /** Number of cards currently assigned to each seat. */
    counts: Record<Direction, number>;
    /** Total assigned cards, including duplicate assignments. */
    totalAssigned: number;
    /** Number of distinct cards assigned. */
    uniqueAssigned: number;
    /** Whether any card appears in more than one hand. */
    hasDuplicates: boolean;
    /** Whether all 52 unique cards are assigned, 13 to each seat. */
    isValid: boolean;
}

/** Creates a hand with no cards assigned. */
export const createEmptyHand = (): Hand => ({
    spades: [],
    hearts: [],
    diamonds: [],
    clubs: [],
});

/** Creates an empty deal for all four seats. */
export const createEmptyHands = (): Hands => ({
    North: createEmptyHand(),
    East: createEmptyHand(),
    South: createEmptyHand(),
    West: createEmptyHand(),
});

/** Copies a hand so it can be changed without mutating the source. */
export const cloneHand = (hand: Readonly<Record<Suit, readonly Rank[]>>): Hand => ({
    spades: [...hand.spades],
    hearts: [...hand.hearts],
    diamonds: [...hand.diamonds],
    clubs: [...hand.clubs],
});

/** Copies all four hands in a deal. */
export const cloneHands = (hands: Hands): Hands => ({
    North: cloneHand(hands.North),
    East: cloneHand(hands.East),
    South: cloneHand(hands.South),
    West: cloneHand(hands.West),
});

/** Returns the number of cards currently assigned to a hand. */
export const getHandCardCount = (hand: Hand): number =>
    SUITS.reduce((count, suit) => count + hand[suit].length, 0);

/** Parses dot-separated Spades-Hearts-Diamonds-Clubs hand notation. */
export const parseHandNotation = (value: string): HandParseResult => {
    const notation = value.trim().toUpperCase().replace(/\s+/g, "").replace(/10/g, "T");

    if (notation.length === 0) {
        return { ok: true, hand: createEmptyHand() };
    }

    const suitParts = notation.split(".");
    if (suitParts.length > SUITS.length) {
        return {
            ok: false,
            error: "Use at most four dot-separated suits in S.H.D.C order.",
        };
    }

    const hand = createEmptyHand();

    for (let index = 0; index < suitParts.length; index += 1) {
        const suit = SUITS[index];
        const part = suitParts[index];

        if (suit === undefined || part === undefined) {
            return { ok: false, error: "Could not read this hand notation." };
        }
        if (part === "" || part === "-") {
            continue;
        }
        if (part.includes("-")) {
            return { ok: false, error: "Use a dash on its own for a void suit." };
        }

        const seenRanks = new Set<Rank>();
        for (const character of part) {
            const rank = RANKS.find((candidate) => candidate === character);
            if (rank === undefined) {
                return {
                    ok: false,
                    error: `Invalid rank "${character}". Use A, K, Q, J, T, or 2 through 9.`,
                };
            }
            if (seenRanks.has(rank)) {
                return { ok: false, error: `Duplicate rank ${rank} in ${suit}.` };
            }

            seenRanks.add(rank);
            hand[suit].push(rank);
        }
    }

    if (getHandCardCount(hand) > 13) {
        return { ok: false, error: "A hand cannot contain more than 13 cards." };
    }

    for (const suit of SUITS) {
        hand[suit] = RANKS.filter((rank) => hand[suit].includes(rank));
    }

    return { ok: true, hand };
};

/** Formats a hand in Spades-Hearts-Diamonds-Clubs order, using dashes for voids. */
export const formatHand = (hand: Hand): string => {
    return SUITS.map((suit) => {
        const ranks = RANKS.filter((rank) => hand[suit].includes(rank)).join("");
        return ranks.length > 0 ? ranks : "-";
    }).join(".");
};

/** Replaces one hand and removes its cards from the other hands. */
export const replaceHandCards = (
    hands: Hands,
    direction: Direction,
    replacement: Hand,
): Hands => {
    const nextHands = cloneHands(hands);

    for (const otherDirection of DIRECTIONS) {
        if (otherDirection === direction) {
            continue;
        }
        for (const suit of SUITS) {
            const replacementRanks = new Set(replacement[suit]);
            nextHands[otherDirection][suit] = nextHands[otherDirection][suit].filter(
                (rank) => !replacementRanks.has(rank),
            );
        }
    }

    nextHands[direction] = cloneHand(replacement);
    return nextHands;
};

/** Assigns a card to a hand or removes it if that hand already owns it. */
export const toggleCard = (
    hands: Hands,
    direction: Direction,
    suit: Suit,
    rank: Rank,
): Hands => {
    const wasInTargetHand = hands[direction][suit].includes(rank);
    const nextHands = cloneHands(hands);

    for (const currentDirection of DIRECTIONS) {
        nextHands[currentDirection][suit] = nextHands[currentDirection][suit].filter(
            (currentRank) => currentRank !== rank,
        );
    }

    if (!wasInTargetHand) {
        nextHands[direction][suit].push(rank);
    }

    for (const currentDirection of DIRECTIONS) {
        nextHands[currentDirection][suit] = RANKS.filter((currentRank) =>
            nextHands[currentDirection][suit].includes(currentRank),
        );
    }

    return nextHands;
};

/** Counts assigned cards and checks whether the deal is a complete unique deck. */
export const assessDeal = (hands: Hands): DealAssessment => {
    const counts: Record<Direction, number> = {
        North: 0,
        East: 0,
        South: 0,
        West: 0,
    };
    const cardOccurrences = new Map<string, number>();
    let totalAssigned = 0;

    for (const direction of DIRECTIONS) {
        for (const suit of SUITS) {
            for (const rank of hands[direction][suit]) {
                const cardKey = `${suit}-${rank}`;
                counts[direction] += 1;
                totalAssigned += 1;
                cardOccurrences.set(cardKey, (cardOccurrences.get(cardKey) ?? 0) + 1);
            }
        }
    }

    const hasDuplicates = [...cardOccurrences.values()].some(
        (occurrences) => occurrences > 1,
    );
    const uniqueAssigned = cardOccurrences.size;
    const allHandsHaveThirteenCards = DIRECTIONS.every(
        (direction) => counts[direction] === 13,
    );

    return {
        counts,
        totalAssigned,
        uniqueAssigned,
        hasDuplicates,
        isValid:
            totalAssigned === 52 &&
            uniqueAssigned === 52 &&
            !hasDuplicates &&
            allHandsHaveThirteenCards,
    };
};

/** Shuffles and deals a complete 52-card deck, preserving rank order in each hand. */
export const createRandomHands = (): Hands => {
    const deck = SUITS.flatMap((suit) =>
        RANKS.map((rank) => ({ suit, rank })),
    );

    for (let index = deck.length - 1; index > 0; index -= 1) {
        const otherIndex = Math.floor(Math.random() * (index + 1));
        const card = deck[index];
        const otherCard = deck[otherIndex];

        if (card === undefined || otherCard === undefined) {
            throw new Error("Could not shuffle the deck.");
        }

        deck[index] = otherCard;
        deck[otherIndex] = card;
    }

    const hands = createEmptyHands();
    for (let index = 0; index < deck.length; index += 1) {
        const direction = DIRECTIONS[Math.floor(index / 13)];
        const card = deck[index];

        if (direction === undefined || card === undefined) {
            throw new Error("Could not deal all cards.");
        }

        hands[direction][card.suit].push(card.rank);
    }

    for (const direction of DIRECTIONS) {
        for (const suit of SUITS) {
            hands[direction][suit] = RANKS.filter((rank) =>
                hands[direction][suit].includes(rank),
            );
        }
    }

    return hands;
};

const SAMPLE_NOTATION: Record<Direction, string> = {
    North: "AKQJ2.KQ3.A54.76",
    East: "T98.AT72.KQ2.KQ3",
    South: "765.965.J987.AT9",
    West: "43.J84.T63.J8542",
};

/** Builds the built-in sample deal from its hand notations. */
export const createSampleHands = (): Hands => {
    const hands = createEmptyHands();

    for (const direction of DIRECTIONS) {
        const parsed = parseHandNotation(SAMPLE_NOTATION[direction]);
        if (!parsed.ok) {
            throw new Error(`Invalid built-in sample deal for ${direction}: ${parsed.error}`);
        }
        hands[direction] = parsed.hand;
    }

    return hands;
};
