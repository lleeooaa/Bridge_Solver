import {
    DIRECTIONS,
    RANKS,
    SUITS,
    type AnalysisPhase,
    type AnalysisSession,
    type Card,
    type Direction,
    type PlayedCard,
    type PositionAnalysis,
    type SolverInput,
    type SolverResult,
    type Suit,
} from "./bridge";
import { buildPlayState } from "./play";
export { getTrickWinner } from "./play";

type Seat = 0 | 1 | 2 | 3;
type SuitIndex = 0 | 1 | 2 | 3;
/**
 * One 13-bit mask per suit. Bit `i` represents `RANKS[i]` (bit 0 is the two,
 * bit 12 is the ace); separate masks avoid JavaScript's 32-bit bitwise limit.
 * For example, a hand holding A-K-Q in one suit has bits 12, 11, and 10 set.
 */
type SuitMasks = [number, number, number, number];
/** Hands are stored in North-East-South-West order; each seat has SHDC masks. */
type MaskHands = [SuitMasks, SuitMasks, SuitMasks, SuitMasks];
type SuitLookups = [Uint32Array, Uint32Array, Uint32Array, Uint32Array];
type HandLookups = [SuitLookups, SuitLookups, SuitLookups, SuitLookups];

/**
 * State at one card-play depth. The hand masks live in SearchContext and are
 * changed in place; this object holds the trick metadata needed to resume a ply.
 *
 * `tricksLeft` includes an unfinished trick and is decremented only when its
 * fourth card is played. `playedCards` records ranks in the current trick so
 * move ordering does not treat already-played ranks as interchangeable.
 * `winRanks` records the rank comparisons required by this node's proof;
 * ranks below its lowest bit in each suit may be exchanged without changing it.
 */
interface Position {
    readonly depth: number;
    seat: Seat;
    trickSize: number;
    leadSuit: SuitIndex;
    winningCard: number;
    winningSeat: Seat;
    tricksLeft: number;
    readonly playedCards: SuitMasks;
    readonly moves: number[];
    readonly keyCharacters: number[];
    readonly winRanks: SuitMasks;
    readonly irrelevantMoves: SuitMasks;
    readonly partnerWinRanks: SuitMasks;
    readonly rankOwners: SuitMasks;
    shapeKey: string;
}

/**
 * Inclusive bounds on the number of future tricks declarer can force.
 * `lower === upper` is exact; otherwise a probe may only have proved one side.
 * At trick boundaries ranks are normalized to their relative order, so the
 * preferred card uses that same normalized rank index. Partial-trick entries
 * use exact ranks and keep the physical card index.
 */
interface TranspositionEntry {
    lower: number;
    upper: number;
    preferredCard: number;
    lowerRanks: number;
    upperRanks: number;
}

/** A one-sided bound for a suit-length shape and prefixes of its rank owners. */
interface RankProof {
    readonly owners: SuitMasks;
    readonly masks: SuitMasks;
    readonly ranks: number;
    readonly lower: boolean;
    readonly value: number;
}

/**
 * Saved state for one active node in the iterative search. `needed` is the
 * threshold still required from this node; `best` is the strongest value found
 * so far for the side to move's minimax objective.
 */
interface SearchFrame {
    needed: number;
    maximizing: boolean;
    key: string | undefined;
    cached: TranspositionEntry | undefined;
    best: number;
    preferredCard: number;
    moveIndex: number;
    card: number;
    earned: number;
}

/** Search snapshot across proof, exact-value refinement, and replay construction. */
export interface SolverProgress {
    phase: "proof" | "refinement" | "replay" | "complete";
    nodesVisited: number;
    cacheHits: number;
    cacheEntries: number;
    elapsedMilliseconds: number;
    trickNumber: number;
    totalTricks: number;
    playerToMove: Direction;
    cardsPlayedToCurrentTrick: number;
}

/** Optional progress receiver; timestamps are sampled only periodically. */
export type SolverProgressCallback = (progress: SolverProgress) => void;

/**
 * Mutable working set for one fixed deal and contract. Keeping it private makes
 * the cache key independent of contract details and lets each search reuse the
 * same hand masks, per-depth positions, frames, and transposition table.
 */
interface SearchContext {
    readonly hands: MaskHands;
    readonly positions: Position[];
    readonly frames: SearchFrame[];
    readonly trump: SuitIndex | -1;
    readonly declarer: Seat;
    readonly totalTricks: number;
    readonly table: Map<string, TranspositionEntry>;
    readonly partialTable: Map<string, TranspositionEntry>;
    readonly rankProofs: Map<string, RankProof[]>;
    readonly rankLayouts: SuitLookups;
    readonly lengthLayouts: SuitLookups;
    readonly topRuns: SuitLookups;
    readonly cashRuns: HandLookups;
    readonly entryRuns: HandLookups;
    rankProofCount: number;
    readonly onProgress: SolverProgressCallback | undefined;
    readonly startedAt: number;
    lastProgressAt: number;
    phase: SolverProgress["phase"];
    nodesVisited: number;
    cacheHits: number;
}

const SEATS = [0, 1, 2, 3] as const;
const SUIT_INDEXES = [0, 1, 2, 3] as const;
const NEXT_SEAT: readonly [Seat, Seat, Seat, Seat] = [1, 2, 3, 0];
const MAX_CACHE_ENTRIES = 250_000;
const MAX_PARTIAL_CACHE_ENTRIES = 50_000;
const CACHE_EVICTION_BATCH_SIZE = 25_000;
const PARTIAL_CACHE_EVICTION_BATCH_SIZE = 5_000;
const PROGRESS_NODE_INTERVAL = 8_192;
const POSITION_KEY_SIZE = 25;
const RANK_COUNT = RANKS.length;
const INVALID_RANK_INDEX = 0xff;
const rankCompressionCache = new Map<number, Uint8Array>();
const bitCounts = Uint8Array.from({ length: 1 << RANK_COUNT }, (_, mask) => {
    let count = 0;
    for (let cards = mask; cards !== 0; cards &= cards - 1) {
        count += 1;
    }
    return count;
});
const MAX_PROOFS_PER_SHAPE = 128;

/** Allocates a void hand: one zero mask for each suit in SHDC order. */
const emptyMasks = (): SuitMasks => [0, 0, 0, 0];

/** Allocates [seat][suit][13-bit active-rank mask] tables for fixed-deal plans. */
const createHandLookups = (): HandLookups => [
    [new Uint32Array(8192), new Uint32Array(8192), new Uint32Array(8192), new Uint32Array(8192)],
    [new Uint32Array(8192), new Uint32Array(8192), new Uint32Array(8192), new Uint32Array(8192)],
    [new Uint32Array(8192), new Uint32Array(8192), new Uint32Array(8192), new Uint32Array(8192)],
    [new Uint32Array(8192), new Uint32Array(8192), new Uint32Array(8192), new Uint32Array(8192)],
];

/**
 * Precomputes rank layouts and conservative cashing/entry plans for one deal.
 * Only subsets of the originally dealt ranks are populated.
 *
 * `owners` packs two bits per active rank, highest rank first in the low bits;
 * `lengths` packs four bits per seat. `topRuns` packs owner in bits 0-1, count
 * in bits 2-5, and the lowest winning rank bit above them. Both plan tables pack
 * the trick count in bits 0-3 and the required physical-rank mask above them.
 *
 * Every continuation removes cards, so its smaller mask has already been
 * computed. Cash plans can change leaders; entry plans stop at partner's first
 * win, which preserves partner's other-suit cards for subsequent cashing.
 */
const createRankLayouts = (hands: MaskHands): {
    owners: SuitLookups; lengths: SuitLookups; topRuns: SuitLookups; cashRuns: HandLookups; entryRuns: HandLookups;
} => {
    const owners: SuitLookups = [
        new Uint32Array(8192), new Uint32Array(8192), new Uint32Array(8192), new Uint32Array(8192),
    ];
    const lengths: SuitLookups = [
        new Uint32Array(8192), new Uint32Array(8192), new Uint32Array(8192), new Uint32Array(8192),
    ];
    const topRuns: SuitLookups = [
        new Uint32Array(8192), new Uint32Array(8192), new Uint32Array(8192), new Uint32Array(8192),
    ];
    const cashRuns = createHandLookups();
    const entryRuns = createHandLookups();
    for (const suit of SUIT_INDEXES) {
        const dealt = hands[0][suit] | hands[1][suit] | hands[2][suit] | hands[3][suit];
        for (let mask = 1; mask < 8192; mask += 1) {
            if ((mask & ~dealt) !== 0) {
                continue;
            }
            const bit = 1 << (31 - Math.clz32(mask));
            const rest = mask ^ bit;
            const owner = (hands[0][suit] & bit) !== 0 ? 0
                : (hands[1][suit] & bit) !== 0 ? 1 : (hands[2][suit] & bit) !== 0 ? 2 : 3;
            owners[suit][mask] = ((owners[suit][rest] ?? 0) << 2) | owner;
            lengths[suit][mask] = (lengths[suit][rest] ?? 0) + (1 << (owner * 4));
            const previous = topRuns[suit][rest] ?? 0;
            const continuing = rest !== 0 && (previous & 3) === owner;
            const count = continuing ? ((previous >>> 2) & 15) + 1 : 1;
            const lowest = continuing ? previous >>> 6 : bit;
            topRuns[suit][mask] = owner | (count << 2) | (lowest << 6);
            for (const seat of SEATS) {
                const partner = NEXT_SEAT[NEXT_SEAT[seat]];
                const own = hands[seat][suit] & mask;
                if (own === 0) {
                    continue;
                }
                const other = hands[partner][suit] & mask;
                const opponents = mask & ~(own | other);
                const highestOpponent = opponents === 0 ? 0 : 1 << (31 - Math.clz32(opponents));
                const left = hands[NEXT_SEAT[seat]][suit] & mask;
                const right = hands[NEXT_SEAT[partner]][suit] & mask;
                const defensiveFollows = (left & -left) | (right & -right);
                const ownHigh = 1 << (31 - Math.clz32(own));
                const ownLow = own & -own;
                const otherHigh = other === 0 ? 0 : 1 << (31 - Math.clz32(other));
                const otherLow = other & -other;
                let best = 0;
                let entry = 0;
                // Defenders follow low on each certified winner, keeping their
                // strongest possible remaining cards. Honors are promoted only
                // when even this defense exhausts them.
                for (let option = 0; option < 2; option += 1) {
                    // Cash high while partner ducks, or lead low to partner's high.
                    const lead = option === 0 ? ownHigh : ownLow;
                    const follow = option === 0 ? otherLow : otherHigh;
                    const winningBit = Math.max(lead, follow);
                    if (winningBit <= highestOpponent) {
                        continue;
                    }
                    const winner = follow > lead ? partner : seat;
                    const remaining = mask ^ lead ^ follow ^ defensiveFollows;
                    const next = cashRuns[winner][suit][remaining] ?? 0;
                    const winnerHand = hands[winner][suit] & mask;
                    const separators = mask & ~winnerHand & (winningBit - 1);
                    const separator = separators === 0 ? 0 : 1 << (31 - Math.clz32(separators));
                    const sequence = winnerHand & ((winningBit << 1) - 1) &
                        ~(separator === 0 ? 0 : (separator << 1) - 1);
                    const ranks = sequence & -sequence;
                    const score = 1 + (next & 15);
                    if (score > (best & 15)) {
                        best = score | (((next >>> 4) | ranks) << 4);
                    }
                    const continuation = winner === partner ? 0 : entryRuns[seat][suit][remaining] ?? 0;
                    if (winner === partner || (continuation & 15) > 0) {
                        const entryScore = 1 + (continuation & 15);
                        if (entryScore > (entry & 15)) {
                            entry = entryScore | (((continuation >>> 4) | ranks) << 4);
                        }
                    }
                }
                cashRuns[seat][suit][mask] = best;
                entryRuns[seat][suit][mask] = entry;
            }
        }
    }
    return { owners, lengths, topRuns, cashRuns, entryRuns };
};

/**
 * Converts a public compass seat to the clockwise indices used by the search.
 * For example, North -> 0, East -> 1, South -> 2, and West -> 3.
 */
const seatIndex = (seat: Direction): Seat => {
    switch (seat) {
        case "North":
            return 0;
        case "East":
            return 1;
        case "South":
            return 2;
        case "West":
            return 3;
        default:
            throw new Error(`Invalid declarer "${String(seat)}".`);
    }
};

/**
 * Converts a public suit to its SHDC index. This makes `suit * 16 + rank`
 * a compact card encoding while leaving a gap between suits.
 */
const suitIndex = (suit: Suit): SuitIndex => {
    switch (suit) {
        case "spades":
            return 0;
        case "hearts":
            return 1;
        case "diamonds":
            return 2;
        case "clubs":
            return 3;
        default:
            throw new Error(`Invalid suit "${String(suit)}".`);
    }
};

/**
 * Extracts the suit from an encoded card. The upper bits contain the suit
 * index and the lower four contain the zero-based rank index.
 *
 * Example: hearts is suit 1, so the ace of hearts is `1 * 16 + 12 = 28`;
 * `cardSuit(28)` returns 1 and `28 & 15` is the ace's rank index, 12.
 */
const cardSuit = (card: number): SuitIndex => {
    switch (card >>> 4) {
        case 0:
            return 0;
        case 1:
            return 1;
        case 2:
            return 2;
        case 3:
            return 3;
        default:
            throw new Error(`Invalid internal card ${card}.`);
    }
};

/**
 * Returns whether this seat belongs to declarer's partnership. North/South
 * share even indices and East/West share odd indices, regardless of who leads.
 * For a North declarer, North and South maximize declarer tricks; East and West
 * minimize them.
 */
const declarerToPlay = (context: SearchContext, seat: Seat): boolean =>
    seat % 2 === context.declarer % 2;

/**
 * Unions the four players' remaining cards in one suit.
 * A set bit means that rank is still held by someone; the owner is not needed
 * for operations such as finding the highest remaining rank.
 */
const allInSuit = (hands: MaskHands, suit: SuitIndex): number =>
    hands[0][suit] | hands[1][suit] | hands[2][suit] | hands[3][suit];

/**
 * Tests whether `card` overtakes the current trick winner.
 * A higher card in the led suit wins; any trump beats a non-trump; an off-suit
 * non-trump cannot win. For example, with spades trump, 2S beats AH, but AH
 * cannot beat KS and 2C cannot beat AH.
 */
const beats = (card: number, winner: number, trump: number): boolean =>
    cardSuit(card) === cardSuit(winner)
        ? (card & 15) > (winner & 15)
        : cardSuit(card) === trump;

/**
 * Validates the public deal and builds the private search context.
 *
 * Each rank becomes one bit in its suit mask, e.g. the ace is bit 12. The
 * `seen` masks detect duplicates across all four hands. Equal hand sizes are
 * required, but the solver also accepts equally short hands for small test
 * positions. The opening leader is declarer's left-hand opponent.
 *
 * Example: with North declaring and 13 cards per hand, East is the initial
 * leader, `totalTricks` is 13, and the root position is at a trick boundary.
 */
const createContext = (
    input: SolverInput,
    onProgress: SolverProgressCallback | undefined,
): SearchContext => {
    if (!Number.isInteger(input.contract.level) || input.contract.level < 1 || input.contract.level > 7) {
        throw new Error("Contract level must be an integer from one through seven.");
    }

    const declarer = seatIndex(input.contract.declarer);
    const trump = input.contract.strain === "no-trump" ? -1 : suitIndex(input.contract.strain);

    const hands: MaskHands = [emptyMasks(), emptyMasks(), emptyMasks(), emptyMasks()];
    const seen = emptyMasks();
    let handCount: number | undefined;
    for (const seat of SEATS) {
        let count = 0;
        for (const suit of SUIT_INDEXES) {
            for (const rank of input.hands[DIRECTIONS[seat]][SUITS[suit]]) {
                const index = RANKS.indexOf(rank);
                if (index < 0) {
                    throw new Error(`Invalid rank "${String(rank)}" in ${DIRECTIONS[seat]}'s hand.`);
                }
                const bit = 1 << index;
                if (seen[suit] & bit) {
                    throw new Error(`The card ${rank} of ${SUITS[suit]} appears more than once.`);
                }
                seen[suit] |= bit;
                hands[seat][suit] |= bit;
                count += 1;
            }
        }
        if (handCount !== undefined && count !== handCount) {
            throw new Error("The solver requires each hand to contain the same number of cards.");
        }
        handCount = count;
    }

    if (handCount === undefined) {
        throw new Error("The deal must contain four hands.");
    }

    const totalTricks = handCount;
    const leader = NEXT_SEAT[declarer];
    const positions = Array.from({ length: totalTricks * 4 + 1 }, (_, depth): Position => ({
        depth,
        seat: leader,
        trickSize: 0,
        leadSuit: 0,
        winningCard: 0,
        winningSeat: leader,
        tricksLeft: totalTricks,
        playedCards: emptyMasks(),
        moves: [],
        keyCharacters: Array.from({ length: POSITION_KEY_SIZE }, () => 0),
        winRanks: emptyMasks(),
        irrelevantMoves: emptyMasks(),
        partnerWinRanks: emptyMasks(),
        rankOwners: emptyMasks(),
        shapeKey: "",
    }));

    const startedAt = performance.now();
    const layouts = createRankLayouts(hands);
    return {
        hands,
        positions,
        trump,
        declarer,
        totalTricks,
        frames: positions.map(() => ({
            needed: 0,
            maximizing: false,
            key: undefined,
            cached: undefined,
            best: 0,
            preferredCard: -1,
            moveIndex: 0,
            card: 0,
            earned: 0,
        })),
        table: new Map<string, TranspositionEntry>(),
        partialTable: new Map<string, TranspositionEntry>(),
        rankProofs: new Map<string, RankProof[]>(),
        rankLayouts: layouts.owners,
        lengthLayouts: layouts.lengths,
        topRuns: layouts.topRuns,
        cashRuns: layouts.cashRuns,
        entryRuns: layouts.entryRuns,
        rankProofCount: 0,
        onProgress,
        startedAt,
        lastProgressAt: startedAt,
        phase: "proof",
        nodesVisited: 0,
        cacheHits: 0,
    };
};

/**
 * Retrieves the reusable position for a card-play depth.
 * There is one slot for the root and one for every card; an absent slot means
 * the search attempted to play beyond the deal.
 */
const positionAt = (context: SearchContext, depth: number): Position => {
    const position = context.positions[depth];
    if (position === undefined) {
        throw new Error(`Search exceeded the deal at card ${depth}.`);
    }
    return position;
};

/**
 * Reports the current search snapshot. `trickNumber` describes the branch
 * currently being explored, not global completion: depth can move backwards
 * when DFS backtracks, so this value may decrease or jump between callbacks.
 */
const reportProgress = (context: SearchContext, state: Position): void => {
    const now = performance.now();
    context.onProgress?.({
        phase: context.phase,
        nodesVisited: context.nodesVisited,
        cacheHits: context.cacheHits,
        cacheEntries: cacheEntryCount(context),
        elapsedMilliseconds: now - context.startedAt,
        trickNumber: context.totalTricks === 0 ? 0
            : Math.min(context.totalTricks, context.totalTricks - state.tricksLeft + 1),
        totalTricks: context.totalTricks,
        playerToMove: DIRECTIONS[state.seat],
        cardsPlayedToCurrentTrick: state.trickSize,
    });
    context.lastProgressAt = now;
};

/**
 * Maps each rank present in a suit to its dense, low-to-high ordinal.
 * Caching by the 13-bit active-rank mask avoids rebuilding the same mapping at
 * many trick boundaries while using at most 13 bytes for each possible mask.
 */
const getRankCompression = (activeRanks: number): Uint8Array => {
    const cached = rankCompressionCache.get(activeRanks);
    if (cached !== undefined) {
        return cached;
    }

    const compression = new Uint8Array(RANK_COUNT);
    compression.fill(INVALID_RANK_INDEX);
    let rankIndex = 0;
    let cards = activeRanks;
    while (cards !== 0) {
        const bit = cards & -cards;
        const rank = 31 - Math.clz32(bit);
        compression[rank] = rankIndex;
        rankIndex += 1;
        cards ^= bit;
    }
    rankCompressionCache.set(activeRanks, compression);
    return compression;
};

/** Compresses one hand's suit mask using a precomputed active-rank mapping. */
const compressRankMask = (mask: number, compression: Uint8Array): number => {
    let compressed = 0;
    let cards = mask;
    while (cards !== 0) {
        const bit = cards & -cards;
        const rank = 31 - Math.clz32(bit);
        const compressedRank = compression[rank];
        if (compressedRank === undefined || compressedRank === INVALID_RANK_INDEX) {
            throw new Error("A hand contains a rank missing from its position key.");
        }
        compressed |= 1 << compressedRank;
        cards ^= bit;
    }
    return compressed;
};

/** Converts a physical move into the rank-normalized code used by trick-boundary entries. */
const normalizePreferredCard = (
    context: SearchContext,
    state: Position,
    card: number,
): number => {
    if (card < 0 || state.trickSize > 0) {
        return card;
    }
    const suit = cardSuit(card);
    const rank = card & 15;
    const activeRanks = allInSuit(context.hands, suit);
    const normalizedRank = getRankCompression(activeRanks)[rank];
    if (normalizedRank === undefined || normalizedRank === INVALID_RANK_INDEX) {
        return -1;
    }
    return suit * 16 + normalizedRank;
};

/** Converts a normalized cached move back to the rank in this actual position. */
const expandPreferredCard = (
    context: SearchContext,
    state: Position,
    card: number,
): number => {
    if (card < 0 || state.trickSize > 0) {
        return card;
    }

    const suit = cardSuit(card);
    const normalizedRank = card & 15;
    const activeRanks = allInSuit(context.hands, suit);
    const compression = getRankCompression(activeRanks);
    for (let rank = 0; rank < RANK_COUNT; rank += 1) {
        if (compression[rank] === normalizedRank) {
            return suit * 16 + rank;
        }
    }
    return -1;
};

/**
 * Builds a safe search key. At a completed-trick boundary, rank names are
 * normalized independently within each suit: only the relative order of cards
 * that remain can affect future play. For an unfinished trick, the key retains
 * exact ranks and includes the lead, current winner, and cards already played.
 *
 * The first five key characters hold seat/trick metadata; the following sixteen
 * hold the four hands' suit masks; the last four hold partial-trick cards.
 */
const positionKey = (context: SearchContext, state: Position): string => {
    const characters = state.keyCharacters;
    characters.fill(0);
    characters[0] = state.seat;

    let offset = 5;
    if (state.trickSize === 0) {
        for (const seat of SEATS) {
            for (const suit of SUIT_INDEXES) {
                const activeRanks = allInSuit(context.hands, suit);
                const compression = getRankCompression(activeRanks);
                characters[offset] = compressRankMask(context.hands[seat][suit], compression);
                offset += 1;
            }
        }
    } else {
        characters[1] = state.trickSize;
        characters[2] = state.leadSuit;
        characters[3] = state.winningSeat;
        characters[4] = state.winningCard;
        for (const seat of SEATS) {
            for (const suit of SUIT_INDEXES) {
                characters[offset] = context.hands[seat][suit];
                offset += 1;
            }
        }
        for (const suit of SUIT_INDEXES) {
            characters[offset] = state.playedCards[suit];
            offset += 1;
        }
    }

    return String.fromCharCode(...characters);
};

/** Selects the appropriate cache based on whether the trick is complete. */
const tableForPosition = (
    context: SearchContext,
    state: Position,
): Map<string, TranspositionEntry> =>
    state.trickSize === 0 ? context.table : context.partialTable;

/** Number of cached positions across complete-trick and partial-root tables. */
const cacheEntryCount = (context: SearchContext): number =>
    context.table.size + context.partialTable.size + context.rankProofCount;

/**
 * Prepares the leader/suit-length bucket and relative rank-owner layout used by
 * proof lookup and storage. Lower ranks can vary when no comparison needs them.
 */
const prepareRankProof = (context: SearchContext, state: Position): void => {
    let lengths = "";
    for (const suit of SUIT_INDEXES) {
        const active = allInSuit(context.hands, suit);
        lengths += String.fromCharCode(context.lengthLayouts[suit][active] ?? 0);
        state.rankOwners[suit] = context.rankLayouts[suit][active] ?? 0;
    }
    state.shapeKey = String.fromCharCode(state.seat) + lengths;
};

/**
 * Encodes each suit's required high-rank prefix length in four bits. Counting
 * active ranks rather than storing rank names allows reuse after low cards change.
 * Cards already in the unfinished trick still participate in these comparisons.
 */
const encodeWinRanks = (context: SearchContext, state: Position): number => {
    let encoded = 0;
    for (const suit of SUIT_INDEXES) {
        const relevant = state.winRanks[suit];
        if (relevant === 0) {
            continue;
        }
        const lowest = relevant & -relevant;
        const active = allInSuit(context.hands, suit) | state.playedCards[suit];
        encoded |= (bitCounts[active & ~(lowest - 1)] ?? 0) << (suit * 4);
    }
    return encoded;
};

/**
 * Maps cached prefix lengths back to this position's lowest dependent rank in
 * each suit. Zero means the proof needs no rank comparison in that suit.
 */
const restoreWinRanks = (context: SearchContext, state: Position, encoded: number): void => {
    for (const suit of SUIT_INDEXES) {
        let count = (encoded >>> (suit * 4)) & 15;
        let cards = allInSuit(context.hands, suit) | state.playedCards[suit];
        let bit = 0;
        while (count > 0 && cards !== 0) {
            bit = 1 << (31 - Math.clz32(cards));
            cards ^= bit;
            count -= 1;
        }
        if (count !== 0) {
            throw new Error("A rank proof exceeds the remaining suit.");
        }
        state.winRanks[suit] = bit;
    }
};

/**
 * Reuses a bound only when it settles this target and every required high-rank
 * owner matches within the same leader/suit-length shape. Restoring dependencies
 * lets ancestors safely incorporate the cached proof into their own proofs.
 */
const findRankProof = (context: SearchContext, state: Position, target: number): number | undefined => {
    prepareRankProof(context, state);
    const proofs = context.rankProofs.get(state.shapeKey);
    if (proofs === undefined) {
        return undefined;
    }
    for (const proof of proofs) {
        if (proof.lower ? proof.value < target : proof.value >= target) {
            continue;
        }
        if ((state.rankOwners[0] & proof.masks[0]) === proof.owners[0] &&
            (state.rankOwners[1] & proof.masks[1]) === proof.owners[1] &&
            (state.rankOwners[2] & proof.masks[2]) === proof.owners[2] &&
            (state.rankOwners[3] & proof.masks[3]) === proof.owners[3]) {
            restoreWinRanks(context, state, proof.ranks);
            context.cacheHits += 1;
            return proof.value;
        }
    }
    return undefined;
};

/**
 * Stores a one-sided bound under the prepared shape, retaining only the owner
 * prefixes needed by its proof. Stronger, more general records replace redundant
 * ones; a bounded recent-first bucket prevents unbounded growth for one shape.
 */
const storeRankProof = (
    context: SearchContext, state: Position, value: number, target: number,
): void => {
    const ranks = encodeWinRanks(context, state);
    const masks = emptyMasks();
    const owners = emptyMasks();
    for (const suit of SUIT_INDEXES) {
        masks[suit] = (1 << (2 * ((ranks >>> (suit * 4)) & 15))) - 1;
        owners[suit] = state.rankOwners[suit] & masks[suit];
    }
    let proofs = context.rankProofs.get(state.shapeKey);
    const lower = value >= target;
    if (proofs !== undefined) {
        for (let index = proofs.length - 1; index >= 0; index -= 1) {
            const proof = proofs[index];
            if (proof === undefined || proof.lower !== lower) {
                continue;
            }
            if ((lower ? proof.value >= value : proof.value <= value) &&
                subsumesRankProof(proof.masks, proof.owners, masks, owners)) {
                return;
            }
            if ((lower ? value >= proof.value : value <= proof.value) &&
                subsumesRankProof(masks, owners, proof.masks, proof.owners)) {
                proofs.splice(index, 1);
                context.rankProofCount -= 1;
            }
        }
    } else {
        proofs = [];
        context.rankProofs.set(state.shapeKey, proofs);
    }
    if (proofs.length === MAX_PROOFS_PER_SHAPE) {
        proofs.pop();
        context.rankProofCount -= 1;
    }
    proofs.unshift({ owners, masks, ranks, lower, value });
    context.rankProofCount += 1;
};

/**
 * Tests whether the general pattern covers every layout allowed by the other.
 * Masks are contiguous low-bit prefixes, so numeric order compares their lengths.
 */
const subsumesRankProof = (
    generalMasks: SuitMasks, generalOwners: SuitMasks, masks: SuitMasks, owners: SuitMasks,
): boolean =>
    generalMasks[0] <= masks[0] && generalMasks[1] <= masks[1] &&
    generalMasks[2] <= masks[2] && generalMasks[3] <= masks[3] &&
    (owners[0] & generalMasks[0]) === generalOwners[0] &&
    (owners[1] & generalMasks[1]) === generalOwners[1] &&
    (owners[2] & generalMasks[2]) === generalOwners[2] &&
    (owners[3] & generalMasks[3]) === generalOwners[3];

/**
 * Retrieves and refreshes an entry's recency. Map insertion order is used as a
 * simple LRU queue: a useful bound survives longer than a one-off position.
 */
const getCachedBound = (
    context: SearchContext,
    state: Position,
    key: string,
): TranspositionEntry | undefined => {
    const table = tableForPosition(context, state);
    const cached = table.get(key);
    if (cached !== undefined) {
        table.delete(key);
        table.set(key, cached);
    }
    return cached;
};

/**
 * Counts accessible top runs, single-suit cashing plans, and multi-round entries.
 *
 * In each suit, count only the leader's cards that outrank every card in the
 * other three hands. A partner's higher card can be forced to follow and win
 * the trick, taking the lead before the leader's remaining cards are cashed.
 * Partner's own top runs are added only with an entry in one of those suits;
 * the leader cashes first and then crosses, preserving partner's winners.
 * A separate multi-round entry can instead cross before cashing partner's
 * other-suit runs, excluding the entry suit to avoid counting it twice.
 * If either opponent still has a trump, side-suit winners are not considered
 * sure because they could be ruffed. This is a conservative bound, not a move
 * choice or a full trick simulation.
 *
 * Example: North's A-2 opposite South's K-3 supplies two diamond tricks and an
 * entry to South, after which South's club top run can be cashed. In contrast,
 * cashing the ace first opposite a singleton king consumes that king rather
 * than preserving it as a later entry.
 */
const sureTricksOnLead = (context: SearchContext, state: Position, needed: number): number => {
    const hand = context.hands[state.seat];
    const left = NEXT_SEAT[state.seat];
    const partner = NEXT_SEAT[NEXT_SEAT[state.seat]];
    const right = NEXT_SEAT[partner];
    const opposingTrumps = context.trump === -1 ? 0
        : context.hands[left][context.trump] | context.hands[right][context.trump];
    let count = 0;
    let partnerCount = 0;
    let entryToPartner = false;
    let singleSuitCount = 0;
    let singleSuit: SuitIndex = 0;
    let singleSuitRanks = 0;
    let usesPartnerRuns = false;
    state.partnerWinRanks.fill(0);
    for (const suit of SUIT_INDEXES) {
        if (opposingTrumps !== 0 && suit !== context.trump) {
            continue;
        }
        const active = allInSuit(context.hands, suit);
        if (active === 0) {
            continue;
        }
        const cash = context.cashRuns[state.seat][suit][active] ?? 0;
        if ((cash & 15) > singleSuitCount) {
            singleSuitCount = cash & 15;
            singleSuit = suit;
            singleSuitRanks = cash >>> 4;
        }
        const run = context.topRuns[suit][active] ?? 0;
        const owner = run & 3;
        if (owner === state.seat) {
            count += (run >>> 2) & 15;
            state.winRanks[suit] = run >>> 6;
        } else if (owner === partner) {
            partnerCount += (run >>> 2) & 15;
            state.partnerWinRanks[suit] = run >>> 6;
            if (hand[suit] !== 0) {
                entryToPartner = true;
            }
        }
    }
    if (entryToPartner) {
        // Cash the leader's runs first, preserving partner's top cards on
        // discards, then cross in a suit untouched by those runs.
        for (const suit of SUIT_INDEXES) {
            state.winRanks[suit] |= state.partnerWinRanks[suit];
        }
        count = Math.min(state.tricksLeft, count + partnerCount);
    }
    if (partnerCount > 0) {
        for (const suit of SUIT_INDEXES) {
            if (opposingTrumps !== 0 && suit !== context.trump) {
                continue;
            }
            const active = allInSuit(context.hands, suit);
            const entry = context.entryRuns[state.seat][suit][active] ?? 0;
            if ((entry & 15) === 0) {
                continue;
            }
            const run = context.topRuns[suit][active] ?? 0;
            const overlap = (run & 3) === partner ? (run >>> 2) & 15 : 0;
            const secured = Math.min(state.tricksLeft, (entry & 15) + partnerCount - overlap);
            if (secured > singleSuitCount) {
                singleSuitCount = secured;
                singleSuit = suit;
                singleSuitRanks = entry >>> 4;
                usesPartnerRuns = true;
            }
        }
    }
    // Prefer the simpler sufficient proof unless the stronger one proves a full sweep.
    if (singleSuitCount > count && (count < needed || singleSuitCount === state.tricksLeft)) {
        state.winRanks.fill(0);
        state.winRanks[singleSuit] = singleSuitRanks;
        if (usesPartnerRuns) {
            // Partner follows every round until taking the entry, so its
            // other-suit winners cannot be consumed by forced discards.
            for (const suit of SUIT_INDEXES) {
                if (suit !== singleSuit) {
                    state.winRanks[suit] = state.partnerWinRanks[suit];
                }
            }
        }
        return Math.min(state.tricksLeft, singleSuitCount);
    }
    return count;
};

/**
 * Looks for wins that do not require the winning side to start on lead: top
 * trumps, or opposing top winners reached by every possible lead without trumps.
 * Returns a declarer-perspective bound only if it settles the requested target.
 */
const unavoidableTrickBound = (
    context: SearchContext, state: Position, target: number,
): number | undefined => {
    const trumps = context.trump === -1 ? 0 : allInSuit(context.hands, context.trump);
    if (trumps !== 0 && context.trump !== -1) {
        // The top trump must eventually be played and win. Its holder can
        // then lead the rest of that uninterrupted top run, regardless of entry.
        const run = context.topRuns[context.trump][trumps] ?? 0;
        const won = (run >>> 2) & 15;
        const declarerWins = (run & 1) === (context.declarer & 1);
        const bound = declarerWins ? won : state.tricksLeft - won;
        if (declarerWins ? bound >= target : bound < target) {
            state.winRanks[context.trump] = run >>> 6;
            return bound;
        }
        return undefined;
    }
    const maximizing = declarerToPlay(context, state.seat);
    const needed = maximizing ? state.tricksLeft - target + 1 : target;
    let winners = 0;
    for (const suit of SUIT_INDEXES) {
        if (context.hands[state.seat][suit] === 0) {
            continue;
        }
        const active = allInSuit(context.hands, suit);
        const run = context.topRuns[suit][active] ?? 0;
        if ((run & 1) === (state.seat & 1)) {
            state.winRanks.fill(0);
            return undefined;
        }
        state.winRanks[suit] = 1 << (31 - Math.clz32(active));
        winners |= 1 << (run & 3);
    }
    if (needed === 1) {
        return maximizing ? state.tricksLeft - 1 : 1;
    }
    const counts = [0, 0, 0, 0];
    for (const suit of SUIT_INDEXES) {
        const active = allInSuit(context.hands, suit);
        if (active === 0) {
            continue;
        }
        const run = context.topRuns[suit][active] ?? 0;
        const owner = run & 3;
        if ((winners & (1 << owner)) !== 0) {
            counts[owner] = (counts[owner] ?? 0) + ((run >>> 2) & 15);
            state.winRanks[suit] |= run >>> 6;
        }
    }
    let guaranteed = state.tricksLeft;
    for (const seat of SEATS) {
        if ((winners & (1 << seat)) !== 0) {
            guaranteed = Math.min(guaranteed, counts[seat] ?? 0);
        }
    }
    if (guaranteed < needed) {
        state.winRanks.fill(0);
        return undefined;
    }
    // Every possible lead loses to an opposing top card. Whichever opponent
    // takes it can cash that hand's other top runs without another entry.
    return maximizing ? state.tricksLeft - guaranteed : guaranteed;
};

/**
 * Gives a search-order score to a legal card; it does not decide legality or
 * remove a move. Higher scores are searched first.
 *
 * When partner is already winning, cheap cards are preferred so high cards and
 * trumps can be saved. When an opponent is winning, low-cost winning cards are
 * tried before losing cards. Leads balance immediate partnership winners,
 * honor development, and the opponents' number of follow-suit alternatives.
 * Cards that can be overtaken later are deprioritized. Second hand also saves
 * honors when partner can win in fourth hand. All distinct representatives are
 * still searched, so a poor heuristic cannot change the answer.
 */
const movePriority = (
    context: SearchContext, state: Position, card: number, partnerCanWin: boolean, threat: number,
): number => {
    const suit = cardSuit(card);
    const rank = card & 15;
    if (state.trickSize > 0) {
        if (partnerCanWin) {
            return -rank - (suit === context.trump ? 20 : 0);
        }
        const partnerWinning = state.winningSeat % 2 === state.seat % 2;
        const wins = beats(card, state.winningCard, context.trump);
        if (wins && (threat === -1 || !beats(threat, card, context.trump))) {
            if (!partnerWinning ||
                (threat !== -1 && beats(threat, state.winningCard, context.trump))) {
                return 1_000 - rank;
            }
        }
        if (partnerWinning) {
            return -rank - (suit === context.trump ? 20 : 0);
        }

        return wins ? -50 - rank : -100 - rank;
    }

    const active = allInSuit(context.hands, suit);
    const top = 31 - Math.clz32(active);
    const layout = context.lengthLayouts[suit][active] ?? 0;
    const left = NEXT_SEAT[state.seat];
    const partner = NEXT_SEAT[left];
    const right = NEXT_SEAT[partner];
    const leftCount = (layout >>> (left * 4)) & 15;
    const rightCount = (layout >>> (right * 4)) & 15;
    const owners = context.rankLayouts[suit][active] ?? 0;
    const rankCount = bitCounts[active] ?? 0;
    const secondOwner = (owners >>> 2) & 3;
    const thirdOwner = (owners >>> 4) & 3;
    const canWin = rank === top ||
        context.hands[partner][suit] > (context.hands[left][suit] | context.hands[right][suit]);
    // These are ordering weights, not trick values. An immediate winner must
    // not overwhelm the benefits of development and a smaller search tree.
    let priority = canWin ? 60 : 0;
    // A void permits discarding from any suit, often expanding the search.
    priority -= 6 * ((leftCount || state.tricksLeft) + (rightCount || state.tricksLeft));
    if (rankCount > 1) {
        // A protected opposing honor behind partner is harder to lead through
        // than one in second hand, before partner has played.
        if ((secondOwner & 1) === (state.seat & 1)) {
            priority += 40;
        } else if (secondOwner === left && leftCount > 1) {
            priority += 22;
        } else if (secondOwner === right && rightCount > 1) {
            priority -= 10;
        }
    }
    if (rankCount > 2 && (secondOwner & 1) === (state.seat & 1) &&
        (thirdOwner & 1) === (state.seat & 1)) {
        // Developing the next two honors can be better than cashing elsewhere.
        priority += 25;
    }
    // Missing or already-played ranks must not inflate a suit's tie-break score.
    return priority + (bitCounts[active & ((1 << rank) - 1)] ?? 0);
};

/**
 * Sorts packed `(priority, card)` integers in descending priority order.
 * Packing keeps move generation allocation-light; the low six bits hold a card.
 */
const descending = (left: number, right: number): number => right - left;

/**
 * Generates and orders the current player's legal move representatives.
 *
 * If the player can follow suit, off-suit cards are excluded. Within a suit,
 * adjacent ranks in the same hand are equivalent when no card held elsewhere
 * (including one already played to this trick) separates them. Only the highest
 * rank from such a run is searched; `equivalentCards` later expands a chosen
 * representative for the UI.
 *
 * Example: if North holds Q-J-10 and no other hand or the current trick
 * contains a rank between them, searching Q represents that contiguous run.
 * If North holds Q and 10 while East holds J, that opposing J separates the
 * ranks, so 10 is not discarded as equivalent to Q.
 */
const orderMoves = (context: SearchContext, state: Position, preferredCard = -1): void => {
    state.moves.length = 0;
    const hand = context.hands[state.seat];
    const mustFollow = state.trickSize > 0 && hand[state.leadSuit] !== 0;
    const threat = state.trickSize === 0 ? -1 : highestOpponentCard(
        context, state, state.seat, NEXT_SEAT[state.seat], 3 - state.trickSize,
    );
    let partnerCanWin = false;
    if (state.trickSize === 1) {
        const partner = NEXT_SEAT[NEXT_SEAT[state.seat]];
        const partnerHand = context.hands[partner];
        const suit = partnerHand[state.leadSuit] !== 0 ? state.leadSuit : context.trump;
        if (suit !== -1 && partnerHand[suit] !== 0) {
            const card = suit * 16 + 31 - Math.clz32(partnerHand[suit]);
            partnerCanWin = beats(card, state.winningCard, context.trump) &&
                (threat === -1 || !beats(threat, card, context.trump));
        }
    }
    for (const suit of SUIT_INDEXES) {
        if (mustFollow && suit !== state.leadSuit) {
            continue;
        }
        const separators = (allInSuit(context.hands, suit) | state.playedCards[suit]) & ~hand[suit];
        let cards = hand[suit];
        let previousRank = 13;
        while (cards !== 0) {
            const rank = 31 - Math.clz32(cards);
            const bit = 1 << rank;
            const between = (1 << previousRank) - (1 << (rank + 1));
            const equivalent = previousRank !== 13 && (separators & between) === 0;
            previousRank = rank;
            cards ^= bit;
            if (equivalent) {
                continue;
            }
            const card = suit * 16 + rank;
            const priority = card === preferredCard ? 8_192
                : movePriority(context, state, card, partnerCanWin, threat);
            state.moves.push((priority + 4_096) * 64 + card);
        }
    }

    state.moves.sort(descending);
    if (state.moves.length === 0) {
        throw new Error(`No legal cards are available for ${DIRECTIONS[state.seat]}.`);
    }
};

/**
 * Applies one card in place and initializes the next depth's trick metadata.
 *
 * A partial trick advances clockwise and keeps its current winner. On the
 * fourth card, the trick counter decreases and the winner leads next. The
 * returned `earned` value is 1 only when that completed trick went to
 * declarer's partnership; otherwise it is 0. Search callers undo the move by
 * restoring its single removed bit after the child value returns.
 *
 * Example: after North leads the first card, `next.seat` is East and
 * `next.trickSize` is 1. After West plays the fourth card, `next.seat` is the
 * winner, `next.trickSize` is 0, and `tricksLeft` has decreased by one.
 */
const playCard = (
    context: SearchContext, state: Position, next: Position, card: number,
): number => {
    const suit = cardSuit(card);
    const bit = 1 << (card & 15);
    context.hands[state.seat][suit] ^= bit;

    const wins = state.trickSize === 0 || beats(card, state.winningCard, context.trump);
    const winningSeat = wins ? state.seat : state.winningSeat;
    const finished = state.trickSize === 3;

    next.seat = finished ? winningSeat : NEXT_SEAT[state.seat];
    next.trickSize = finished ? 0 : state.trickSize + 1;
    next.leadSuit = state.trickSize === 0 ? suit : state.leadSuit;
    next.winningCard = wins ? card : state.winningCard;
    next.winningSeat = winningSeat;
    next.tricksLeft = state.tricksLeft - Number(finished);

    for (const index of SUIT_INDEXES) {
        next.playedCards[index] = finished ? 0
            : state.playedCards[index] | (index === suit ? bit : 0);
    }
    return Number(finished && declarerToPlay(context, winningSeat));
};

/**
 * Resolves the last complete trick without making a search node for each card.
 *
 * The caller guarantees a trick boundary with exactly one card left in every
 * hand, so there is only one possible play sequence. The function finds those
 * four cards, applies `beats` in clockwise order, and returns 1 if declarer's
 * partnership wins or 0 otherwise. The hand masks are read-only here.
 */
const lastTrick = (context: SearchContext, state: Position): number => {
    let player = state.seat;
    let winningCard = -1;
    let winner = player;
    for (let index = 0; index < 4; index += 1) {
        for (const suit of SUIT_INDEXES) {
            const mask = context.hands[player][suit];
            if (mask === 0) {
                continue;
            }
            const card = suit * 16 + 31 - Math.clz32(mask);
            if (winningCard === -1 || beats(card, winningCard, context.trump)) {
                winningCard = card;
                winner = player;
            }
        }
        player = NEXT_SEAT[player];
    }
    const suit = cardSuit(winningCard);
    const left = NEXT_SEAT[winner];
    const right = NEXT_SEAT[NEXT_SEAT[left]];
    if ((context.hands[left][suit] | context.hands[right][suit]) !== 0) {
        state.winRanks[suit] = 1 << (winningCard & 15);
    }
    return Number(declarerToPlay(context, winner));
};

/**
 * Adds the bottom of the winner's equivalent same-hand sequence to the proof.
 * Recording only the selected high representative would omit rank dependencies
 * needed when that proof is reused with different low-card ownership.
 */
const includeWinningRank = (
    context: SearchContext, state: Position, winner: Seat, card: number, played: number,
): void => {
    const suit = cardSuit(card);
    const winningBit = 1 << (card & 15);
    const winnerHand = context.hands[winner][suit] | winningBit;
    const separators = (allInSuit(context.hands, suit) | played) & ~winnerHand & (winningBit - 1);
    const separator = separators === 0 ? 0 : 1 << (31 - Math.clz32(separators));
    const sequence = winnerHand & ((winningBit << 1) - 1) &
        ~(separator === 0 ? 0 : (separator << 1) - 1);
    state.winRanks[suit] |= sequence & -sequence;
};

/** Include the rank comparison and the sequence represented by its winning card. */
const includeTrickRanks = (context: SearchContext, state: Position, child: Position, card: number): void => {
    const suit = cardSuit(child.winningCard);
    const played = state.playedCards[suit] | (cardSuit(card) === suit ? 1 << (card & 15) : 0);
    if ((played & (played - 1)) !== 0) {
        includeWinningRank(context, child, child.winningSeat, child.winningCard, played);
    }
};

/**
 * Finds the strongest legal follow or possible ruff among `count` upcoming
 * seats starting at `first`, considering only opponents of `winner`'s side.
 * Returns -1 if none holds a led-suit card or a usable trump.
 */
const highestOpponentCard = (
    context: SearchContext, state: Position, winner: Seat, first: Seat, count: number,
): number => {
    let seat = first;
    let highest = -1;
    for (let index = 0; index < count; index += 1) {
        if (seat % 2 !== winner % 2) {
            const hand = context.hands[seat];
            const suit = hand[state.leadSuit] !== 0 ? state.leadSuit : context.trump;
            if (suit !== -1 && hand[suit] !== 0) {
                const card = suit * 16 + 31 - Math.clz32(hand[suit]);
                if (highest === -1 || beats(card, highest, context.trump)) {
                    highest = card;
                }
            }
        }
        seat = NEXT_SEAT[seat];
    }
    return highest;
};

/** One secured trick settles a one-trick target, or disproves a required sweep. */
const currentTrickBound = (context: SearchContext, state: Position, target: number): number | undefined => {
    if (target !== 1 && target !== state.tricksLeft) {
        return undefined;
    }
    const wanted = target === 1 ? context.declarer : NEXT_SEAT[context.declarer];
    const threat = highestOpponentCard(context, state, wanted, state.seat, 4 - state.trickSize);
    let winner = state.winningSeat;
    let card = state.winningCard;
    if ((winner & 1) !== (wanted & 1) || (threat !== -1 && beats(threat, card, context.trump))) {
        winner = state.seat;
        let secured = false;
        for (let index = state.trickSize; index < 4; index += 1) {
            const hand = context.hands[winner];
            const suit = hand[state.leadSuit] !== 0 ? state.leadSuit : context.trump;
            if ((winner & 1) === (wanted & 1) && suit !== -1 && hand[suit] !== 0) {
                card = suit * 16 + 31 - Math.clz32(hand[suit]);
                if (beats(card, state.winningCard, context.trump) &&
                    (threat === -1 || !beats(threat, card, context.trump))) {
                    secured = true;
                    break;
                }
            }
            winner = NEXT_SEAT[winner];
        }
        if (!secured) {
            return undefined;
        }
    }
    const suit = cardSuit(card);
    includeWinningRank(context, state, winner, card, state.playedCards[suit] | (1 << (card & 15)));
    return declarerToPlay(context, winner) ? 1 : state.tricksLeft - 1;
};

/** Without ruffs, certify this trick's winner and that hand's following cashes. */
const noTrumpCashingBound = (context: SearchContext, state: Position, target: number): number | undefined => {
    let winner = state.winningSeat;
    let rank = state.winningCard & 15;
    let seat = state.seat;
    for (let index = state.trickSize; index < 4; index += 1) {
        const cards = context.hands[seat][state.leadSuit];
        if (cards !== 0) {
            const candidate = 31 - Math.clz32(cards);
            if (candidate > rank) {
                winner = seat;
                rank = candidate;
            }
        }
        seat = NEXT_SEAT[seat];
    }
    const declarerWins = declarerToPlay(context, winner);
    const needed = declarerWins ? target : state.tricksLeft - target + 1;
    const winningBit = 1 << rank;
    let count = 1;
    if (needed > 1) {
        for (const suit of SUIT_INDEXES) {
            // Only the certified winner's card is removed. Keeping all other
            // unplayed cards makes future cashes safe against every response.
            const active = allInSuit(context.hands, suit) & ~(suit === state.leadSuit ? winningBit : 0);
            if (active === 0) {
                continue;
            }
            const run = context.topRuns[suit][active] ?? 0;
            if ((run & 3) === winner) {
                count += (run >>> 2) & 15;
                state.winRanks[suit] |= run >>> 6;
                if (count >= needed) {
                    break;
                }
            }
        }
        if (count < needed) {
            state.winRanks.fill(0);
            return undefined;
        }
    }
    includeWinningRank(context, state, winner, state.leadSuit * 16 + rank,
        state.playedCards[state.leadSuit] | winningBit);
    return declarerWins ? count : state.tricksLeft - count;
};

/**
 * Adds the result of a threshold probe to the transposition table.
 *
 * A fail-high proves a lower bound (`value >= needed`); a fail-low proves an
 * upper bound (`value < needed`). Neither result is automatically an exact
 * score. The entry starts with the natural range `[0, remaining]`, and new
 * probes tighten that inclusive interval.
 *
 * Example: for a target of 5, proving value 6 or more raises `lower` to at
 * least 6; proving only 4 or fewer lowers `upper` to at most 4. If both bounds
 * meet at 6, later probes know the exact value without searching this state.
 * Each bound retains its own rank dependencies. A cached preferred card only
 * affects ordering; correctness comes from the bounds, not from trusting it.
 */
const storeBound = (
    context: SearchContext,
    state: Position,
    key: string,
    previous: TranspositionEntry | undefined,
    value: number,
    needed: number,
    remaining: number,
    preferredCard: number,
): void => {
    const table = tableForPosition(context, state);
    const entry = previous ?? { lower: 0, upper: remaining, preferredCard, lowerRanks: 0, upperRanks: 0 };
    const ranks = encodeWinRanks(context, state);
    if (value >= needed) {
        if (value >= entry.lower) {
            entry.lower = value;
            entry.lowerRanks = ranks;
        }
    }
    else {
        if (value <= entry.upper) {
            entry.upper = value;
            entry.upperRanks = ranks;
        }
    }
    entry.preferredCard = normalizePreferredCard(context, state, preferredCard);
    if (entry.lower > entry.upper) {
        throw new Error("Contradictory search bounds.");
    }

    if (!table.has(key)) {
        if (state.trickSize > 0 && table.size >= MAX_PARTIAL_CACHE_ENTRIES) {
            evictOldest(table, PARTIAL_CACHE_EVICTION_BATCH_SIZE);
        }
    }

    table.set(key, entry);
    if (state.trickSize === 0) {
        storeRankProof(context, state, value, needed);
    }
    trimCache(context);
};

/**
 * Enforces the combined cache budget in batches, evicting partial/exact entries
 * before generalized proof buckets. Eviction loses reuse, never a proof's validity.
 */
const trimCache = (context: SearchContext): void => {
    if (cacheEntryCount(context) <= MAX_CACHE_ENTRIES) {
        return;
    }
    evictOldest(context.partialTable, CACHE_EVICTION_BATCH_SIZE);
    if (cacheEntryCount(context) > MAX_CACHE_ENTRIES) {
        evictOldest(context.table, CACHE_EVICTION_BATCH_SIZE);
    }
    if (cacheEntryCount(context) > MAX_CACHE_ENTRIES) {
        for (const [shape, proofs] of context.rankProofs) {
            context.rankProofs.delete(shape);
            context.rankProofCount -= proofs.length;
            if (cacheEntryCount(context) <= MAX_CACHE_ENTRIES - CACHE_EVICTION_BATCH_SIZE) {
                break;
            }
        }
    }
};

/** Removes the oldest entries and returns how many were evicted. */
const evictOldest = (table: Map<string, TranspositionEntry>, count: number): number => {
    let evicted = 0;
    for (const oldestKey of table.keys()) {
        table.delete(oldestKey);
        evicted += 1;
        if (evicted === count) {
            break;
        }
    }
    return evicted;
};

/**
 * Retrieves the saved search frame aligned with `depth`.
 * Frames are allocated with the positions, so a missing one signals an
 * internal overrun rather than a position with no legal moves.
 */
const frameAt = (context: SearchContext, depth: number): SearchFrame => {
    const frame = context.frames[depth];
    if (frame === undefined) {
        throw new Error(`Search exceeded its frame at card ${depth}.`);
    }
    return frame;
};

/**
 * Creates one resumable null-window threshold search.
 *
 * The search answers a yes/no question about declarer tricks, not the exact
 * score: a returned value at least `needed` proves the target; a smaller value
 * proves it cannot be reached. At each card, any trick already earned is
 * subtracted from the child's `needed` threshold.
 *
 * Example: to test whether declarer can force 9 tricks, a node asks for 9.
 * If declarer wins the current trick while descending, the child only needs
 * 8 more. Declarer nodes stop as soon as one move reaches the target; defender
 * nodes stop as soon as one move proves the target can be held below.
 *
 * `run(maxNodes)` advances at most that many new nodes and returns `undefined`
 * if more work remains, so a worker can yield and resume the same traversal.
 * `dispose()` restores every card still removed along the active path, whether
 * the search completed or was interrupted.
 */
const createSearchTask = (context: SearchContext, root: Position, needed: number) => {
    let depth = root.depth;
    let target = needed;
    let entering = true;
    let value = 0;
    let finished = false;

    /** Plays the next ordered move and adjusts the target for a trick it earned. */
    const descend = (state: Position, frame: SearchFrame): void => {
        const packed = state.moves[frame.moveIndex];
        if (packed === undefined) {
            throw new Error("Missing search move.");
        }
        frame.moveIndex += 1;
        frame.card = packed & 63;
        frame.earned = playCard(context, state, positionAt(context, depth + 1), frame.card);
        target = frame.needed - frame.earned;
        depth += 1;
        entering = true;
    };

    /** Advances a slice; `undefined` means the task can be resumed later. */
    const run = (maxNodes: number): number | undefined => {
        let visited = 0;
        while (!finished) {
            if (entering) {
                if (visited >= maxNodes) {
                    return undefined;
                }
                visited += 1;
                const state = positionAt(context, depth);
                context.nodesVisited += 1;
                if (context.onProgress !== undefined && context.nodesVisited % PROGRESS_NODE_INTERVAL === 0 &&
                    performance.now() - context.lastProgressAt >= 1_000) {
                    reportProgress(context, state);
                }

                let resolved: number | undefined;
                state.winRanks.fill(0);
                const maximizing = declarerToPlay(context, state.seat);
                const shouldCache = depth === root.depth;
                const key = shouldCache ? positionKey(context, state) : undefined;
                const cached = key === undefined ? undefined : getCachedBound(context, state, key);
                // Trivial thresholds and a forced last trick need no move tree.
                if (target <= 0) {
                    resolved = 0;
                }
                else if (target > state.tricksLeft) {
                    resolved = state.tricksLeft;
                }
                else if (state.trickSize === 0 && state.tricksLeft === 1) {
                    resolved = lastTrick(context, state);
                }
                // A cached interval can prove either side of this null window.
                else if (cached !== undefined && (cached.lower >= target || cached.upper < target)) {
                    context.cacheHits += 1;
                    resolved = cached.lower >= target ? cached.lower : cached.upper;
                    restoreWinRanks(context, state, cached.lower >= target ? cached.lowerRanks : cached.upperRanks);
                } else if (state.trickSize > 0) {
                    resolved = context.trump === -1
                        ? noTrumpCashingBound(context, state, target)
                        : currentTrickBound(context, state, target);
                } else {
                    resolved = findRankProof(context, state, target);
                    if (resolved !== undefined) {
                        value = resolved;
                        entering = false;
                        continue;
                    }
                    // Sure tricks give a cheap lower bound for declarer and an
                    // upper bound for declarer when defenders are to play.
                    const unavoidable = unavoidableTrickBound(context, state, target);
                    const needed = maximizing ? target : state.tricksLeft - target + 1;
                    const sure = unavoidable === undefined ? sureTricksOnLead(context, state, needed) : 0;
                    const bound = unavoidable ?? (maximizing ? sure : state.tricksLeft - sure);
                    if (unavoidable !== undefined || (maximizing ? bound >= target : bound < target)) {
                        if (key !== undefined) {
                            storeBound(context, state, key, cached, bound, target, state.tricksLeft, -1);
                        } else {
                            storeRankProof(context, state, bound, target);
                            trimCache(context);
                        }
                        resolved = bound;
                    }
                    else {
                        state.winRanks.fill(0);
                    }
                }
                if (resolved !== undefined) {
                    value = resolved;
                    entering = false;
                } else {
                    const preferredCard = cached === undefined
                        ? -1
                        : expandPreferredCard(context, state, cached.preferredCard);
                    orderMoves(context, state, preferredCard);
                    state.irrelevantMoves.fill(0);
                    const frame = frameAt(context, depth);
                    frame.needed = target;
                    frame.maximizing = maximizing;
                    frame.key = key;
                    frame.cached = cached;
                    frame.best = maximizing ? 0 : state.tricksLeft;
                    frame.preferredCard = -1;
                    frame.moveIndex = 0;
                    descend(state, frame);
                    continue;
                }
            }

            if (depth === root.depth) {
                finished = true;
                return value;
            }
            depth -= 1;
            const state = positionAt(context, depth);
            const frame = frameAt(context, depth);
            // The child has returned; restore its card before trying a sibling.
            context.hands[state.seat][cardSuit(frame.card)] |= 1 << (frame.card & 15);

            const candidate = frame.earned + value;
            const child = positionAt(context, depth + 1);
            if (state.trickSize === 3) {
                includeTrickRanks(context, state, child, frame.card);
            }
            if (frame.preferredCard === -1 || (frame.maximizing ? candidate > frame.best : candidate < frame.best)) {
                frame.best = candidate;
                frame.preferredCard = frame.card;
            }
            const cutoff = frame.maximizing ? frame.best >= frame.needed : frame.best < frame.needed;
            for (const suit of SUIT_INDEXES) {
                state.winRanks[suit] = cutoff
                    ? child.winRanks[suit]
                    : state.winRanks[suit] | child.winRanks[suit];
            }
            if (!cutoff) {
                const suit = cardSuit(frame.card);
                const relevant = child.winRanks[suit];
                const lowRanks = relevant === 0 ? 8191 : (relevant & -relevant) - 1;
                if ((lowRanks & (1 << (frame.card & 15))) !== 0) {
                    // Swapping two cards below every comparison in the child
                    // preserves this failed move's proof, even mid-trick.
                    state.irrelevantMoves[suit] |= lowRanks;
                }
                while (frame.moveIndex < state.moves.length) {
                    const packed = state.moves[frame.moveIndex];
                    if (packed === undefined) {
                        throw new Error("Missing equivalent move.");
                    }
                    const card = packed & 63;
                    if ((state.irrelevantMoves[cardSuit(card)] & (1 << (card & 15))) === 0) {
                        break;
                    }
                    frame.moveIndex += 1;
                    // The reused proof excludes the target, not necessarily the
                    // stronger fail-soft value returned for its representative.
                    frame.best = frame.maximizing
                        ? Math.max(frame.best, frame.needed - 1)
                        : Math.min(frame.best, frame.needed);
                }
            }
            // Declarer needs one successful line; defenders need one line that
            // disproves the target. The opposite case must inspect every move.
            if (cutoff || frame.moveIndex === state.moves.length) {
                if (frame.key !== undefined) {
                    storeBound(
                        context,
                        state,
                        frame.key,
                        frame.cached,
                        frame.best,
                        frame.needed,
                        state.tricksLeft,
                        frame.preferredCard,
                    );
                } else if (state.trickSize === 0) {
                    storeRankProof(context, state, frame.best, frame.needed);
                    trimCache(context);
                }
                value = frame.best;
            } else {
                descend(state, frame);
            }
        }
        return value;
    };

    /** Unmakes all moves below the root so this context is safe to reuse. */
    const dispose = (): void => {
        while (depth > root.depth) {
            depth -= 1;
            const frame = frameAt(context, depth);
            context.hands[positionAt(context, depth).seat][cardSuit(frame.card)] |= 1 << (frame.card & 15);
        }
        finished = true;
    };
    return { run, dispose };
};

/**
 * Runs one complete threshold probe synchronously and returns its proven bound.
 *
 * Example: `needed = 9` tells the caller whether declarer can guarantee nine
 * more tricks from `state`; it does not by itself calculate the exact maximum.
 * The `finally` block is important because the task mutates shared hand masks.
 */
const searchBestMoves = (context: SearchContext, state: Position, needed: number): number => {
    const task = createSearchTask(context, state, needed);
    try {
        const value = task.run(Infinity);
        if (value === undefined) {
            throw new Error("Synchronous search did not finish.");
        }
        return value;
    } finally {
        task.dispose();
    }
};

/**
 * Tries the threshold just beyond the contract proof within the remaining
 * interval, where the previous search's bounds can often be reused. Undefined
 * leaves the caller to choose a midpoint instead.
 */
const firstRefinementTarget = (
    lower: number,
    upper: number,
    proofTarget: number,
    proofSucceeded: boolean,
    tricksLeft: number,
): number | undefined => {
    if (proofTarget <= 0 || proofTarget > tricksLeft || lower >= upper) {
        return undefined;
    }
    const target = proofSucceeded
        ? Math.max(lower + 1, proofTarget + 1)
        : Math.min(upper, proofTarget - 1);
    return target > lower && target <= upper ? target : undefined;
};

/**
 * Refines the proven make/set result into an exact future trick count.
 *
 * A make proof initializes `lower` to a value at least the contract target and
 * `upper` to all remaining tricks. A set proof initializes `upper` below the
 * target and `lower` to zero. The first probe checks the score immediately
 * beyond the proof target, then midpoint probes narrow the remaining interval.
 * All probes reuse bounds already learned by the proof search.
 *
 * Example: after proving nine tricks, try ten before a midpoint. If ten fails
 * with an upper bound of nine, the exact result is already known.
 */
const refineOptimalTricks = (
    context: SearchContext, initial: Position, requiredTricks: number, proofBound: number,
): number => {
    const made = proofBound >= requiredTricks;
    let lower = made ? proofBound : 0;
    let upper = made ? initial.tricksLeft : proofBound;
    let nextTarget = firstRefinementTarget(
        lower, upper, requiredTricks, made, initial.tricksLeft,
    );
    const key = initial.trickSize === 0 ? positionKey(context, initial) : undefined;
    while (true) {
        const cached = key === undefined ? undefined : getCachedBound(context, initial, key);
        if (cached !== undefined) {
            lower = Math.max(lower, cached.lower);
            upper = Math.min(upper, cached.upper);
        }
        if (lower > upper) {
            throw new Error("Contradictory optimal trick bounds.");
        }
        if (lower === upper) {
            return lower;
        }

        const target = nextTarget !== undefined && nextTarget > lower && nextTarget <= upper
            ? nextTarget
            : Math.floor((lower + upper + 1) / 2);
        nextTarget = undefined;
        const bound = searchBestMoves(context, initial, target);
        if (bound >= target) {
            lower = Math.max(lower, bound);
        }
        else {
            upper = Math.min(upper, bound);
        }
    }
};

/**
 * Converts the internal `suit * 16 + rankIndex` encoding to a public play.
 * For example, encoded card 28 becomes the ace of hearts.
 */
const publicPlay = (seat: Seat, card: number): PlayedCard => {
    const rank = RANKS[card & 15];
    if (rank === undefined) {
        throw new Error(`Invalid replay card ${card}.`);
    }
    return { player: DIRECTIONS[seat], card: { suit: SUITS[cardSuit(card)], rank } };
};

/**
 * Reconstructs one full line that realizes the exact minimax trick value.
 *
 * At declarer turns, accept a card only if a target probe proves declarer can
 * preserve the optimum. At defender turns, accept a card only if a probe proves
 * declarer cannot exceed that value. Thus the line shows best play by both
 * partnerships; the cached move only changes which candidates are checked first.
 *
 * Example: if the optimum is 10, declarer has already won 3 tricks, and its
 * candidate wins the current trick, the child must prove 6 more (`10 - 3 - 1`).
 * When defenders choose, the probe asks whether declarer can reach 8 more; a
 * fail-low proves the defense keeps the final total at 10 or less.
 */
const reconstructLine = (
    context: SearchContext, optimalDeclarerTricks: number,
): { line: PlayedCard[]; declarerTricksInLine: number } => {
    const line: PlayedCard[] = [];
    let state = positionAt(context, 0);
    let won = 0;
    while (state.depth < context.totalTricks * 4) {
        const key = positionKey(context, state);
        const cached = getCachedBound(context, state, key);
        const preferredCard = cached === undefined
            ? -1
            : expandPreferredCard(context, state, cached.preferredCard);
        orderMoves(context, state, preferredCard);
        const next = positionAt(context, state.depth + 1);
        const maximizing = declarerToPlay(context, state.seat);
        let selected = -1;
        for (const packed of state.moves) {
            const card = packed & 63;
            const earned = playCard(context, state, next, card);
            const target = optimalDeclarerTricks - won - earned + Number(!maximizing);
            const bound = searchBestMoves(context, next, target);
            if (maximizing ? bound >= target : bound < target) {
                selected = card;
                won += earned;
                break;
            }
            context.hands[state.seat][cardSuit(card)] |= 1 << (card & 15);
        }
        if (selected === -1) {
            throw new Error("Could not reconstruct an optimal continuation.");
        }
        line.push(publicPlay(state.seat, selected));
        state = next;
    }
    if (won !== optimalDeclarerTricks) {
        throw new Error("Replay contradicts the optimal trick count.");
    }
    return { line, declarerTricksInLine: won };
};

/**
 * Proves an explicit trick target, refines the exact value, and builds a replay.
 *
 * The first null-window search answers the contract question: a bound at least
 * `requiredTricks` means declarer can make it against every defense; a smaller
 * bound means defenders can set it against every declarer line. Refinement and
 * replay share the same transposition table, avoiding a cold restart.
 *
 * Example: `requiredTricks = 9` tests a game-level contract. If the proof finds
 * at least 9, `canMakeContract` is true; the result still refines whether the
 * exact total is 9, 10, or higher so the UI can show the optimal trick count.
 */
export const solveTrickTarget = (
    input: SolverInput, requiredTricks: number, onProgress?: SolverProgressCallback,
): SolverResult => {
    if (!Number.isInteger(requiredTricks) || requiredTricks < 0 || requiredTricks > 13) {
        throw new Error("Trick target must be an integer from zero through thirteen.");
    }

    const context = createContext(input, onProgress);
    const initial = positionAt(context, 0);
    if (onProgress !== undefined) {
        reportProgress(context, initial);
    }
    const proofBound = searchBestMoves(context, initial, requiredTricks);
    const canMakeContract = proofBound >= requiredTricks;
    const proofFinishedAt = performance.now();

    context.phase = "refinement";
    if (onProgress !== undefined) {
        reportProgress(context, initial);
    }
    const refinementStartedAt = performance.now();
    const optimalDeclarerTricks = refineOptimalTricks(context, initial, requiredTricks, proofBound);
    const refinementFinishedAt = performance.now();
    if ((optimalDeclarerTricks >= requiredTricks) !== canMakeContract) {
        throw new Error("Optimal trick count contradicts the contract proof.");
    }

    context.phase = "replay";
    if (onProgress !== undefined) {
        reportProgress(context, initial);
    }
    const replayStartedAt = performance.now();
    const replay = reconstructLine(context, optimalDeclarerTricks);
    const replayFinishedAt = performance.now();

    context.phase = "complete";
    if (onProgress !== undefined) {
        reportProgress(context, positionAt(context, context.totalTricks * 4));
    }
    return {
        canMakeContract, requiredTricks, optimalDeclarerTricks, ...replay,
        statistics: {
            proofMilliseconds: proofFinishedAt - context.startedAt,
            refinementMilliseconds: refinementFinishedAt - refinementStartedAt,
            replayMilliseconds: replayFinishedAt - replayStartedAt,
            nodesVisited: context.nodesVisited,
            cacheHits: context.cacheHits,
            cacheEntries: cacheEntryCount(context),
        },
    };
};

/**
 * Solves the contract's trick target (`level + 6`) and returns one optimal line.
 *
 * For example, 3NT requires 9 tricks and 4H requires 10. The strain determines
 * trump/no-trump behavior, while doubling changes duplicate score but not the
 * number of tricks required to make the contract.
 */
export const solveContract = (
    input: SolverInput, onProgress?: SolverProgressCallback,
): SolverResult => solveTrickTarget(input, input.contract.level + 6, onProgress);

/**
 * Yields to the worker's task queue so it can process cancellation or a newer
 * message. Unlike a resolved Promise, this crosses a task boundary; unlike a
 * timer, it is not subject to nested/background timer throttling.
 */
const waitForWorkerMessages = (): Promise<void> => new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
        channel.port1.close();
        channel.port2.close();
        resolve();
    };
    channel.port2.postMessage(null);
});

const abortError = (): Error => new DOMException("Position analysis cancelled.", "AbortError");

type MutableAnalysisPhaseStatistics = {
    elapsedMilliseconds: number;
    nodesVisited: number;
    cacheHits: number;
    probeCount: number;
};

const createAnalysisPhaseStatistics = (): Record<AnalysisPhase, MutableAnalysisPhaseStatistics> => ({
    proof: { elapsedMilliseconds: 0, nodesVisited: 0, cacheHits: 0, probeCount: 0 },
    refinement: { elapsedMilliseconds: 0, nodesVisited: 0, cacheHits: 0, probeCount: 0 },
    recommendation: { elapsedMilliseconds: 0, nodesVisited: 0, cacheHits: 0, probeCount: 0 },
});

/**
 * Expands one searched rank into the equivalent cards shown to the user.
 *
 * Two ranks in the same hand are equivalent when no remaining opponent card or
 * card already played to this trick lies between them. `orderMoves` searches
 * only one representative; this function restores the equivalent ranks for
 * highlighting without making the search enumerate each one.
 *
 * Example: if South holds Q-J-10 and no other hand/current-trick card separates
 * those ranks, selecting Q returns Q, J, and 10. If East holds J between
 * South's Q and 10, the 10 is not returned as equivalent to Q.
 */
const equivalentCards = (context: SearchContext, state: Position, selected: number): Card[] => {
    const suit = cardSuit(selected);
    const hand = context.hands[state.seat][suit];
    const separators = (allInSuit(context.hands, suit) | state.playedCards[suit]) & ~hand;
    const selectedRank = selected & 15;
    return RANKS.flatMap((rank, index) => {
        if (!(hand & (1 << index))) {
            return [];
        }
        const low = Math.min(index, selectedRank);
        const high = Math.max(index, selectedRank);
        const between = (1 << high) - (1 << (low + 1));
        return index === selectedRank || (separators & between) === 0
            ? [{ suit: SUITS[suit], rank }] : [];
    });
};

/**
 * Creates a reusable analysis session for one original deal and contract.
 *
 * The transposition table is shared across positions in this session, and exact
 * history results are kept in a small FIFO cache. Calls are serialized because
 * their searches make/unmake cards in the same mutable hand masks.
 *
 * Example: after the opening position is analyzed, analyzing a card the solver
 * recommended can inherit the exact total immediately. A non-recommended play
 * reuses the parent's bounds, then probes only enough to determine the new exact
 * total and recommendation. `dispose()` prevents queued/running work from being
 * published after the board is replaced.
 */
export const createAnalysisSession = (input: SolverInput): AnalysisSession => {
    const context = createContext(input, undefined);
    const originalMasks: MaskHands = [
        [...context.hands[0]], [...context.hands[1]], [...context.hands[2]], [...context.hands[3]],
    ];
    const originalInput: SolverInput = {
        hands: buildPlayState(input).hands, contract: { ...input.contract },
    };

    const results = new Map<string, PositionAnalysis>();
    const MAX_POSITION_RESULTS = 256;
    let queue = Promise.resolve();
    let disposed = false;

    /**
     * Rebuilds the requested position from the original deal and analyzes it.
     * Replaying history from the root keeps the shared masks deterministic after
     * Undo or when the user branches into a different continuation.
     */
    const runAnalysis = async (history: readonly PlayedCard[], signal: AbortSignal): Promise<PositionAnalysis> => {
        const startedAt = performance.now();
        const startNodes = context.nodesVisited;
        const startHits = context.cacheHits;
        const phaseStatistics = createAnalysisPhaseStatistics();

        /** Stop before doing more work or returning a result for an obsolete board. */
        const checkActive = (): void => {
            if (disposed) {
                throw new Error("Analysis session is closed.");
            }
            if (signal.aborted) {
                throw abortError();
            }
        };

        /**
         * Runs one threshold search in bounded slices. After a short slice, yield
         * so the worker can receive an abort or a newer position request.
         */
        const probe = async (state: Position, target: number): Promise<number> => {
            const task = createSearchTask(context, state, target);
            try {
                let sliceStartedAt = performance.now();
                while (true) {
                    checkActive();
                    const value = task.run(8_192);
                    if (value !== undefined) {
                        return value;
                    }
                    if (performance.now() - sliceStartedAt >= 12) {
                        await waitForWorkerMessages();
                        sliceStartedAt = performance.now();
                    }
                }
            } finally {
                task.dispose();
            }
        };

        /** Attributes each probe's work to its phase, including work before cancellation. */
        const runProbe = async (
            phase: AnalysisPhase, state: Position, target: number,
        ): Promise<number> => {
            const statistics = phaseStatistics[phase];
            const nodesBefore = context.nodesVisited;
            const hitsBefore = context.cacheHits;
            const probeStartedAt = performance.now();
            statistics.probeCount += 1;
            try {
                return await probe(state, target);
            } finally {
                statistics.elapsedMilliseconds += performance.now() - probeStartedAt;
                statistics.nodesVisited += context.nodesVisited - nodesBefore;
                statistics.cacheHits += context.cacheHits - hitsBefore;
            }
        };

        checkActive();
        const board = buildPlayState(originalInput, history);
        const historyKey = (plays: readonly PlayedCard[]): string =>
            plays.map((play) => `${play.player}:${play.card.suit}:${play.card.rank}`).join("|");
        const key = historyKey(history);
        const saved = results.get(key);
        if (saved !== undefined) {
            // This exact chronological history has already been fully analyzed.
            return {
                ...saved, statistics: {
                    elapsedMilliseconds: performance.now() - startedAt, nodesVisited: 0, cacheHits: 0,
                    cacheEntries: cacheEntryCount(context), fromCache: true, inheritedValue: false,
                    phaseStatistics,
                }
            };
        }

        // Restore the root masks, then replay the actual cards to reach this ply.
        for (const seat of SEATS) {
            for (const suit of SUIT_INDEXES) context.hands[seat][suit] = originalMasks[seat][suit];
        }
        let state = positionAt(context, 0);
        for (const play of history) {
            const rank = RANKS.indexOf(play.card.rank);
            const next = positionAt(context, state.depth + 1);
            playCard(context, state, next, suitIndex(play.card.suit) * 16 + rank);
            state = next;
        }

        let lower = 0;
        let upper = state.tricksLeft;
        let inheritedValue = false;
        let proofTarget: number | undefined;
        let proofSucceeded: boolean | undefined;
        const parent = history.length > 0 ? results.get(historyKey(history.slice(0, -1))) : undefined;
        const previousPlay = history.at(-1);

        if (parent !== undefined && previousPlay !== undefined) {
            const previousTotal = parent.optimalDeclarerTricks;
            const previousFuture = previousTotal - board.declarerTricksWon;
            // A previously certified optimal card preserves the parent value.
            if (parent.recommendedCards.some((card) =>
                card.suit === previousPlay.card.suit && card.rank === previousPlay.card.rank)) {
                lower = previousFuture;
                upper = previousFuture;
                inheritedValue = true;
            } else {
                // A declarer deviation cannot improve on the parent's optimum;
                // a defensive deviation cannot make the defense stronger.
                const previousWasDeclarer = seatIndex(previousPlay.player) % 2 === context.declarer % 2;
                if (previousWasDeclarer) {
                    upper = Math.min(upper, previousFuture);
                }
                else {
                    lower = Math.max(lower, previousFuture);
                }
                // Test whether the old boundary still holds; the +1 on a
                // defensive turn tests whether the deviation lets declarer exceed it.
                const target = previousFuture + Number(!previousWasDeclarer);
                proofTarget = target;
                const bound = await runProbe("proof", state, target);
                proofSucceeded = bound >= target;
                if (proofSucceeded) {
                    lower = Math.max(lower, bound);
                }
                else {
                    upper = Math.min(upper, bound);
                }
            }
        } else if (!board.isComplete) {
            // For the first position, prove the contract after subtracting tricks
            // declarer has already won in the replayed history.
            const target = originalInput.contract.level + 6 - board.declarerTricksWon;
            proofTarget = target;
            const bound = await runProbe("proof", state, target);
            proofSucceeded = bound >= target;
            if (proofSucceeded) {
                lower = Math.max(lower, bound);
            }
            else {
                upper = Math.min(upper, bound);
            }
        }

        while (lower < upper) {
            const cached = getCachedBound(context, state, positionKey(context, state));
            if (cached !== undefined) {
                lower = Math.max(lower, cached.lower);
                upper = Math.min(upper, cached.upper);
            }
            if (lower >= upper) {
                break;
            }
            const adjacentTarget = proofTarget !== undefined && proofSucceeded !== undefined
                ? firstRefinementTarget(lower, upper, proofTarget, proofSucceeded, state.tricksLeft)
                : undefined;
            const target = adjacentTarget !== undefined
                ? adjacentTarget
                : Math.floor((lower + upper + 1) / 2);
            proofTarget = undefined;
            proofSucceeded = undefined;
            const bound = await runProbe("refinement", state, target);
            if (bound >= target) {
                lower = Math.max(lower, bound);
            }
            else {
                upper = Math.min(upper, bound);
            }
        }

        if (lower !== upper || lower < 0 || upper > state.tricksLeft) {
            throw new Error("Contradictory current-position bounds.");
        }

        const optimalDeclarerTricks = board.declarerTricksWon + lower;
        let recommendedCards: Card[] = [];

        if (!board.isComplete) {
            const cached = getCachedBound(context, state, positionKey(context, state));
            const preferredCard = cached === undefined
                ? -1
                : expandPreferredCard(context, state, cached.preferredCard);
            orderMoves(context, state, preferredCard);
            const maximizing = declarerToPlay(context, state.seat);
            for (const packed of state.moves) {
                const card = packed & 63;
                const next = positionAt(context, state.depth + 1);
                const earned = playCard(context, state, next, card);

                let optimal: boolean;
                try {
                    // Declarer must preserve the value; defenders must prevent
                    // declarer from reaching one trick more than that value.
                    const target = lower - earned + Number(!maximizing);
                    const bound = await runProbe("recommendation", next, target);
                    optimal = maximizing ? bound >= target : bound < target;
                } finally {
                    context.hands[state.seat][cardSuit(card)] |= 1 << (card & 15);
                }
                if (optimal) {
                    recommendedCards = equivalentCards(context, state, card);
                    break;
                }
            }

            if (recommendedCards.length === 0) {
                throw new Error("No optimal recommendation could be certified.");
            }
        }
        checkActive();
        const result: PositionAnalysis = {
            optimalDeclarerTricks,
            canMakeContract: optimalDeclarerTricks >= originalInput.contract.level + 6,
            recommendedCards,
            statistics: {
                elapsedMilliseconds: performance.now() - startedAt,
                nodesVisited: context.nodesVisited - startNodes,
                cacheHits: context.cacheHits - startHits,
                cacheEntries: cacheEntryCount(context),
                fromCache: false,
                inheritedValue,
                phaseStatistics,
            },
        };
        if (results.size >= MAX_POSITION_RESULTS) {
            // Map iteration order is insertion order, so this evicts the oldest history.
            const oldest = results.keys().next().value;
            if (oldest !== undefined) {
                results.delete(oldest);
            }
        }
        results.set(key, result);
        return result;
    };

    return {
        analyze: (history, signal) => {
            // Snapshot caller-owned plays before queuing; later UI edits cannot mutate this request.
            const snapshot = history.map((play) => ({ player: play.player, card: { ...play.card } }));
            const result = queue.then(() => runAnalysis(snapshot, signal));
            // Keep the queue usable after a rejected/cancelled request; return the original result.
            queue = result.then(() => undefined, () => undefined);
            return result;
        },
        dispose: () => { disposed = true; },
    };
};