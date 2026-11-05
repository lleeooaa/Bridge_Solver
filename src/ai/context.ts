import { DIRECTIONS, type Contract, type Direction, type Doubling, type Strain } from "../bridge";
import { nextPlayer } from "../play";

export const VULNERABILITIES = ["unknown", "none", "north-south", "east-west", "both"] as const;
export type Vulnerability = (typeof VULNERABILITIES)[number];
type BidLevel = 1 | 2 | 3 | 4 | 5 | 6 | 7;
type BidCode = "C" | "D" | "H" | "S" | "NT";
export type AuctionCallValue = "P" | "X" | "XX" | `${BidLevel}${BidCode}`;

export interface AuctionCall {
    readonly player: Direction;
    readonly call: AuctionCallValue;
}

export interface PartnershipContext {
    readonly biddingSystem: string;
    readonly carding: string;
}

export interface AdvisorContext {
    readonly dealer: Direction | null;
    readonly vulnerability: Vulnerability;
    readonly auction: readonly AuctionCall[];
    readonly auctionNotes: string;
    readonly northSouth: PartnershipContext;
    readonly eastWest: PartnershipContext;
}

const bidStrains: readonly { code: BidCode; strain: Strain }[] = [
    { code: "C", strain: "clubs" }, { code: "D", strain: "diamonds" },
    { code: "H", strain: "hearts" }, { code: "S", strain: "spades" }, { code: "NT", strain: "no-trump" },
];
const bids = ([1, 2, 3, 4, 5, 6, 7] as const).flatMap((level) =>
    bidStrains.map(({ code, strain }, index) => ({
        call: `${level}${code}` as const, level, strain, order: (level - 1) * 5 + index,
    })));
const sameSide = (left: Direction, right: Direction): boolean =>
    DIRECTIONS.indexOf(left) % 2 === DIRECTIONS.indexOf(right) % 2;
const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown, label: string, maximum = 500): string => {
    if (typeof value !== "string" || value.length > maximum) {
        throw new Error(`${label} must be text of at most ${maximum} characters.`);
    }
    return value.trim();
};
const callValue = (value: unknown, index: number): AuctionCallValue => {
    if (typeof value !== "string") throw new Error(`Invalid auction call ${index + 1}.`);
    const token = value.toUpperCase();
    if (token === "P" || token === "PASS") return "P";
    if (token === "X" || token === "DOUBLE" || token === "DBL") return "X";
    if (token === "XX" || token === "REDOUBLE" || token === "RDBL") return "XX";
    const bid = bids.find((entry) => entry.call === token.replace(/N$/, "NT"));
    if (bid === undefined) throw new Error(`Invalid auction call ${index + 1}: "${value}". Use P, X, XX or 1C through 7NT.`);
    return bid.call;
};

export const createAdvisorContext = (): AdvisorContext => ({
    dealer: null, vulnerability: "unknown", auction: [], auctionNotes: "",
    northSouth: { biddingSystem: "", carding: "" }, eastWest: { biddingSystem: "", carding: "" },
});

export const parseAuction = (value: string, dealer: Direction | null): AuctionCall[] => {
    if (value.length > 2000) throw new Error("Auction text must contain at most 2000 characters.");
    const tokens = value.trim() === "" ? [] : value.trim().split(/[\s,;]+/);
    if (tokens.length === 0) return [];
    if (dealer === null || !DIRECTIONS.includes(dealer)) throw new Error("Choose the dealer before entering an auction.");
    let player = dealer;
    return tokens.map((token, index) => {
        const entry = { player, call: callValue(token, index) };
        player = nextPlayer(player);
        return entry;
    });
};

const validateAuction = (auction: readonly AuctionCall[], dealer: Direction | null, contract: Readonly<Contract>): void => {
    if (auction.length === 0) return;
    if (dealer === null) throw new Error("Choose the dealer before entering an auction.");
    let player = dealer;
    let finalBid: (typeof bids)[number] | undefined;
    let bidder: Direction | undefined;
    let doubling: Doubling = "undoubled";
    let passes = 0;
    let ended = false;
    const firstBidders = new Map<string, Direction>();
    for (const entry of auction) {
        if (ended) throw new Error("The auction already ended; remove the extra calls.");
        if (entry.player !== player) throw new Error(`Auction turn: expected ${player}.`);
        if (entry.call === "P") {
            passes += 1;
            ended = passes === (finalBid === undefined ? 4 : 3);
        } else {
            passes = 0;
            if (entry.call === "X") {
                if (bidder === undefined || sameSide(player, bidder) || doubling !== "undoubled") {
                    throw new Error("Illegal double: only an opponent may double an undoubled bid.");
                }
                doubling = "doubled";
            } else if (entry.call === "XX") {
                if (bidder === undefined || !sameSide(player, bidder) || doubling !== "doubled") {
                    throw new Error("Illegal redouble: only the bidding side may redouble a doubled bid.");
                }
                doubling = "redoubled";
            } else {
                const bid = bids.find((value) => value.call === entry.call);
                if (bid === undefined || (finalBid !== undefined && bid.order <= finalBid.order)) {
                    throw new Error("Each bid must be higher than the preceding bid.");
                }
                finalBid = bid;
                bidder = player;
                doubling = "undoubled";
                const key = `${DIRECTIONS.indexOf(player) % 2}:${bid.strain}`;
                if (!firstBidders.has(key)) firstBidders.set(key, player);
            }
        }
        player = nextPlayer(player);
    }
    if (!ended) throw new Error("Enter a complete auction ending in three passes after the final bid.");
    if (finalBid === undefined || bidder === undefined) throw new Error("The auction passed out and cannot produce a played contract.");
    if (finalBid.level !== contract.level || finalBid.strain !== contract.strain || doubling !== contract.doubling) {
        throw new Error("The auction's final contract does not match the selected contract.");
    }
    if (firstBidders.get(`${DIRECTIONS.indexOf(bidder) % 2}:${finalBid.strain}`) !== contract.declarer) {
        throw new Error("The selected declarer must be the first player on the winning side to bid the final strain.");
    }
};

export const normalizeAdvisorContext = (value: unknown, contract: Readonly<Contract>): AdvisorContext => {
    if (value === undefined) return createAdvisorContext();
    if (!isRecord(value)) throw new Error("Invalid advisor context.");
    const dealer = value.dealer === null ? null : DIRECTIONS.find((seat) => seat === value.dealer);
    if (dealer === undefined) throw new Error("Invalid auction dealer.");
    const vulnerability = VULNERABILITIES.find((entry) => entry === value.vulnerability);
    if (vulnerability === undefined) throw new Error("Invalid vulnerability.");
    if (!Array.isArray(value.auction) || value.auction.length > 319) throw new Error("Invalid auction call list.");
    const auction = value.auction.map((entry: unknown, index): AuctionCall => {
        if (!isRecord(entry)) throw new Error(`Invalid auction call ${index + 1}.`);
        const player = DIRECTIONS.find((seat) => seat === entry.player);
        if (player === undefined) throw new Error(`Invalid auction player at call ${index + 1}.`);
        return { player, call: callValue(entry.call, index) };
    });
    const partnership = (entry: unknown, name: string): PartnershipContext => {
        if (!isRecord(entry)) throw new Error(`Invalid ${name} convention context.`);
        return { biddingSystem: text(entry.biddingSystem, `${name} bidding system`), carding: text(entry.carding, `${name} carding`) };
    };
    validateAuction(auction, dealer, contract);
    return {
        dealer, vulnerability, auction, auctionNotes: text(value.auctionNotes, "Auction explanations", 1000),
        northSouth: partnership(value.northSouth, "North/South"), eastWest: partnership(value.eastWest, "East/West"),
    };
};
