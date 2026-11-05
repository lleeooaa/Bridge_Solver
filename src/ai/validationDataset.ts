import {
    DIRECTIONS, RANKS, SUITS, parseHandNotation,
    type Card, type Contract, type Doubling, type Direction, type Hand, type Hands,
    type PlayedCard, type Strain,
} from "../bridge";
import { buildPlayState, nextPlayer } from "../play";
import {
    createAdvisorContext, normalizeAdvisorContext, parseAuction, VULNERABILITIES,
    type AdvisorContext,
} from "./context";

const DATASET_SCHEMA = "bridge-human-play-dataset/v2";
const RECORD_SCHEMA = "bridge-human-play/v2";
const BID_CODES = ["C", "D", "H", "S", "NT"] as const;
type BidCode = (typeof BID_CODES)[number];

const bidStrains: Readonly<Record<BidCode, Strain>> = {
    C: "clubs", D: "diamonds", H: "hearts", S: "spades", NT: "no-trump",
};

type NumericHands = Record<Direction, readonly number[]>;
type ValidationProgress = (message: string) => void;

interface DatasetShard {
    readonly name: string;
    readonly sha256: string;
    readonly file: File;
}

export interface ValidationSample {
    readonly dealId: string;
    readonly contract: Contract;
    readonly declarerHand: Hand;
    readonly dummyHand: Hand;
    readonly context: AdvisorContext;
    readonly auction: readonly string[];
    readonly openingLead: PlayedCard;
    readonly eligibleDeals: number;
}

export interface ValidationFullInformation {
    readonly hands: Hands;
}

export interface ValidationSelection {
    readonly sample: ValidationSample;
    readonly fullInformation: ValidationFullInformation;
}

export interface ValidationPickOptions {
    readonly onProgress?: ValidationProgress;
    readonly random?: () => number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

const normalizedPath = (value: string): string =>
    value.replace(/\\/g, "/").replace(/^\/+/, "");

const text = (value: unknown, label: string): string => {
    if (typeof value !== "string") throw new Error(`${label} must be text.`);
    return value;
};

const readDatasetShards = async (files: readonly File[]): Promise<DatasetShard[]> => {
    const manifestFiles = files.filter((file) => file.name.toLowerCase() === "manifest.json");
    if (manifestFiles.length === 0) {
        throw new Error("The selected folder does not contain a prepared-dataset manifest.json.");
    }

    const candidates: { file: File; value: Record<string, unknown> }[] = [];
    const parseErrors: string[] = [];
    for (const file of manifestFiles) {
        let value: unknown;
        try {
            value = JSON.parse(await file.text());
        } catch (failure: unknown) {
            parseErrors.push(`${file.name}: ${failure instanceof Error ? failure.message : String(failure)}`);
            continue;
        }
        if (isRecord(value) && value.schema === DATASET_SCHEMA) candidates.push({ file, value });
    }

    if (candidates.length === 0) {
        const detail = parseErrors.length > 0 ? ` ${parseErrors[0]}` : "";
        throw new Error(`No ${DATASET_SCHEMA} manifest was found in the selected files.${detail}`);
    }
    if (candidates.length !== 1) {
        throw new Error("Select one prepared dataset folder at a time; multiple dataset manifests were found.");
    }

    const selected = candidates[0];
    if (selected === undefined) throw new Error("Could not read the selected dataset manifest.");
    const splits = selected.value.splits;
    if (!isRecord(splits) || !isRecord(splits.validation) || !Array.isArray(splits.validation.shards)) {
        throw new Error("The dataset manifest has no validation shard list.");
    }
    if (splits.validation.shards.length === 0) {
        throw new Error("The dataset manifest lists no validation shards.");
    }

    const manifestPath = normalizedPath(selected.file.webkitRelativePath || selected.file.name);
    const separator = manifestPath.lastIndexOf("/");
    const manifestDirectory = separator < 0 ? "" : manifestPath.slice(0, separator + 1);
    const shardNames = new Set<string>();
    return splits.validation.shards.map((entry: unknown, index: number): DatasetShard => {
        if (!isRecord(entry)) throw new Error(`Invalid validation shard entry ${index + 1}.`);
        const name = text(entry.file, `Validation shard ${index + 1} file`);
        const sha256 = text(entry.sha256, `Validation shard ${name} checksum`).toLowerCase();
        if (!/^validation-\d{6}\.jsonl$/.test(name)) {
            throw new Error(`Unexpected validation shard filename "${name}".`);
        }
        if (!/^[0-9a-f]{64}$/.test(sha256)) {
            throw new Error(`Invalid SHA-256 checksum for ${name}.`);
        }
        if (shardNames.has(name)) throw new Error(`The manifest lists ${name} more than once.`);
        shardNames.add(name);

        const expectedPath = normalizedPath(`${manifestDirectory}${name}`);
        const exactMatches = files.filter((file) =>
            normalizedPath(file.webkitRelativePath || file.name) === expectedPath);
        const matches = exactMatches.length > 0
            ? exactMatches
            : files.filter((file) => file.name === name);
        if (matches.length !== 1) {
            throw new Error(matches.length === 0
                ? `Validation shard ${name} is missing from the selected folder.`
                : `More than one file named ${name} was selected; choose the prepared dataset folder.`);
        }
        const file = matches[0];
        if (file === undefined) throw new Error(`Could not read validation shard ${name}.`);
        return { name, sha256, file };
    });
};

const sha256Hex = async (value: BufferSource): Promise<string> => {
    const subtle = globalThis.crypto?.subtle;
    if (subtle === undefined) {
        throw new Error("SHA-256 verification requires HTTPS or localhost in a supported browser.");
    }
    const digest = new Uint8Array(await subtle.digest("SHA-256", value));
    return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
};

const readVerifiedText = async (shard: DatasetShard): Promise<string> => {
    const bytes = await shard.file.arrayBuffer();
    const actual = await sha256Hex(bytes);
    if (actual !== shard.sha256) {
        throw new Error(`Checksum mismatch for ${shard.name}; the selected dataset is incomplete or changed.`);
    }
    try {
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (failure: unknown) {
        throw new Error(`${shard.name} is not valid UTF-8: ${failure instanceof Error ? failure.message : String(failure)}`);
    }
};

const readNumericHands = (value: unknown, label: string): NumericHands => {
    if (!isRecord(value)) throw new Error(`${label} has no complete hand map.`);
    const allCards = new Set<number>();
    const readHand = (seat: Direction): number[] => {
        const cards = value[seat];
        if (!Array.isArray(cards) || cards.length !== 13) {
            throw new Error(`${label} must contain thirteen cards for ${seat}.`);
        }
        const hand: number[] = [];
        for (const card of cards) {
            if (typeof card !== "number" || !Number.isInteger(card) || card < 0 || card >= 52) {
                throw new Error(`${label} contains an invalid card for ${seat}.`);
            }
            if (allCards.has(card)) throw new Error(`${label} assigns card ${card} more than once.`);
            allCards.add(card);
            hand.push(card);
        }
        return hand;
    };
    const hands: NumericHands = {
        North: readHand("North"),
        East: readHand("East"),
        South: readHand("South"),
        West: readHand("West"),
    };
    if (allCards.size !== 52) throw new Error(`${label} must assign all 52 cards.`);
    return hands;
};

const compareNumberLists = (left: readonly number[], right: readonly number[]): number => {
    for (let index = 0; index < left.length; index += 1) {
        const difference = (left[index] ?? 0) - (right[index] ?? 0);
        if (difference !== 0) return difference;
    }
    return left.length - right.length;
};

const compareRotations = (
    left: readonly (readonly number[])[],
    right: readonly (readonly number[])[],
): number => {
    for (let index = 0; index < left.length; index += 1) {
        const leftHand = left[index];
        const rightHand = right[index];
        if (leftHand === undefined || rightHand === undefined) {
            throw new Error("Could not canonicalize a validation deal.");
        }
        const difference = compareNumberLists(leftHand, rightHand);
        if (difference !== 0) return difference;
    }
    return left.length - right.length;
};

const canonicalDealKey = (hands: NumericHands): string => {
    const orderedHands = DIRECTIONS.map((seat) => [...hands[seat]].sort((left, right) => left - right));
    const rotations = DIRECTIONS.map((_, offset) =>
        DIRECTIONS.map((__, index) => {
            const hand = orderedHands[(offset + index) % DIRECTIONS.length];
            if (hand === undefined) throw new Error("Could not canonicalize a validation deal.");
            return hand;
        }));
    rotations.sort(compareRotations);
    const canonical = rotations[0];
    if (canonical === undefined) throw new Error("Could not canonicalize a validation deal.");
    return JSON.stringify(canonical);
};

const handFromCardIds = (cards: readonly number[]): Hand => {
    const cardSet = new Set(cards);
    const notation = SUITS.map((_, suitIndex) => {
        const ranks = RANKS.filter((__, rankIndex) => cardSet.has(suitIndex * 13 + rankIndex)).join("");
        return ranks || "-";
    }).join(".");
    const parsed = parseHandNotation(notation);
    if (!parsed.ok) throw new Error(`Could not convert a validation hand: ${parsed.error}`);
    return parsed.hand;
};

const cardFromId = (value: unknown, label: string): Card => {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value >= 52) {
        throw new Error(`${label} is not a valid card identity.`);
    }
    const suit = SUITS[Math.floor(value / 13)];
    const rank = RANKS[value % 13];
    if (suit === undefined || rank === undefined) throw new Error(`${label} is not a valid card identity.`);
    return { suit, rank };
};

const sameSide = (left: Direction, right: Direction): boolean =>
    DIRECTIONS.indexOf(left) % 2 === DIRECTIONS.indexOf(right) % 2;

const deriveContract = (auction: ReturnType<typeof parseAuction>): Contract => {
    let highestBid: { level: number; strain: Strain; order: number } | null = null;
    let bidder: Direction | null = null;
    let doubling: Doubling = "undoubled";
    let passes = 0;
    let ended = false;
    const firstBidders = new Map<string, Direction>();

    for (const entry of auction) {
        if (ended) throw new Error("The recorded auction contains calls after it ended.");
        if (entry.call === "P") {
            passes += 1;
            ended = passes === (highestBid === null ? 4 : 3);
            continue;
        }

        passes = 0;
        if (entry.call === "X") {
            if (bidder === null || sameSide(entry.player, bidder) || doubling !== "undoubled") {
                throw new Error("The recorded auction contains an illegal double.");
            }
            doubling = "doubled";
            continue;
        }
        if (entry.call === "XX") {
            if (bidder === null || !sameSide(entry.player, bidder) || doubling !== "doubled") {
                throw new Error("The recorded auction contains an illegal redouble.");
            }
            doubling = "redoubled";
            continue;
        }

        const match = /^([1-7])(C|D|H|S|NT)$/.exec(entry.call);
        const levelText = match?.[1];
        const code = BID_CODES.find((candidate) => candidate === match?.[2]);
        if (levelText === undefined || code === undefined) {
            throw new Error(`Could not interpret recorded bid "${entry.call}".`);
        }
        const strain = bidStrains[code];
        const level = Number(levelText);
        const order = (level - 1) * BID_CODES.length + BID_CODES.indexOf(code);
        if (highestBid !== null && order <= highestBid.order) {
            throw new Error("The recorded auction contains a bid that is not higher than the previous bid.");
        }
        highestBid = { level, strain, order };
        bidder = entry.player;
        doubling = "undoubled";
        const side = DIRECTIONS.indexOf(entry.player) % 2;
        firstBidders.set(`${side}:${strain}`, firstBidders.get(`${side}:${strain}`) ?? entry.player);
    }

    if (!ended) throw new Error("The recorded auction is incomplete.");
    if (highestBid === null || bidder === null) {
        throw new Error("The selected validation record is passed out and has no played contract.");
    }
    const declaringSide = DIRECTIONS.indexOf(bidder) % 2;
    const declarer = firstBidders.get(`${declaringSide}:${highestBid.strain}`);
    if (declarer === undefined) throw new Error("Could not determine the declarer from the recorded auction.");
    return { level: highestBid.level, strain: highestBid.strain, declarer, doubling };
};

const readSelectedRecord = async (
    record: Record<string, unknown>,
    expectedDealKey: string,
    eligibleDeals: number,
): Promise<ValidationSelection> => {
    const numericHands = readNumericHands(record.hands, "Selected validation deal");
    if (canonicalDealKey(numericHands) !== expectedDealKey) {
        throw new Error("The selected validation deal changed while it was being read.");
    }
    const hands: Hands = {
        North: handFromCardIds(numericHands.North),
        East: handFromCardIds(numericHands.East),
        South: handFromCardIds(numericHands.South),
        West: handFromCardIds(numericHands.West),
    };
    const dealer = DIRECTIONS.find((seat) => seat === record.dealer);
    if (dealer === undefined) throw new Error("The selected record has an invalid dealer.");
    const vulnerability = VULNERABILITIES.find((entry) => entry === record.vulnerability);
    if (vulnerability === undefined) throw new Error("The selected record has invalid vulnerability.");
    if (!Array.isArray(record.auction) || record.auction.length < 1 || record.auction.length > 319) {
        throw new Error("The selected record has an invalid auction.");
    }
    const auctionCalls = record.auction.map((call, index) => {
        if (typeof call !== "string") throw new Error(`Auction call ${index + 1} is not text.`);
        return call;
    });
    const auction = parseAuction(auctionCalls.join(" "), dealer);
    const contract = deriveContract(auction);
    const context = normalizeAdvisorContext({
        ...createAdvisorContext(), dealer, vulnerability, auction,
    }, contract);

    if (!Array.isArray(record.plays) || record.plays.length !== 52 || record.claim !== null) {
        throw new Error("The selected record is not a complete, unclaimed 52-card play.");
    }
    const plays: PlayedCard[] = record.plays.map((play, index) => {
        if (!isRecord(play)) throw new Error(`Play ${index + 1} is invalid.`);
        const player = DIRECTIONS.find((seat) => seat === play.player);
        if (player === undefined) throw new Error(`Play ${index + 1} has an invalid player.`);
        return {
            player,
            card: cardFromId(play.card, `Play ${index + 1}`),
        };
    });
    const finalState = buildPlayState({ hands, contract }, plays);
    if (!finalState.isComplete) throw new Error("The selected validation play did not complete all 52 cards.");
    const openingLead = plays[0];
    if (openingLead === undefined || openingLead.player !== nextPlayer(contract.declarer)) {
        throw new Error("The selected validation play has no valid opening lead.");
    }

    return {
        sample: {
            dealId: await sha256Hex(new TextEncoder().encode(expectedDealKey)),
            contract,
            declarerHand: hands[contract.declarer],
            dummyHand: hands[nextPlayer(nextPlayer(contract.declarer))],
            context,
            auction: auctionCalls,
            openingLead,
            eligibleDeals,
        },
        fullInformation: { hands },
    };
};

const parsePlayRecord = (line: string, fileName: string, lineNumber: number): Record<string, unknown> => {
    let value: unknown;
    try {
        value = JSON.parse(line);
    } catch (failure: unknown) {
        throw new Error(`Invalid JSON in ${fileName} line ${lineNumber}: ${failure instanceof Error ? failure.message : String(failure)}`);
    }
    if (!isRecord(value) || value.schema !== RECORD_SCHEMA) {
        throw new Error(`${fileName} line ${lineNumber} is not a ${RECORD_SCHEMA} record.`);
    }
    if (!Array.isArray(value.plays) || value.plays.length < 1 || value.plays.length > 52) {
        throw new Error(`${fileName} line ${lineNumber} has an invalid play list.`);
    }
    if (!("claim" in value)) throw new Error(`${fileName} line ${lineNumber} has no claim field.`);
    if (value.claim !== null && (typeof value.claim !== "number" ||
        !Number.isInteger(value.claim) || value.claim < 0 || value.claim > 13)) {
        throw new Error(`${fileName} line ${lineNumber} has an invalid claim.`);
    }
    return value;
};

export const readValidationRecord = async (
    value: unknown, eligibleDeals = 1,
): Promise<ValidationSelection> => {
    const record = parsePlayRecord(JSON.stringify(value), "Bundled example records", 1);
    const numericHands = readNumericHands(record.hands, "Bundled example record");
    return readSelectedRecord(record, canonicalDealKey(numericHands), eligibleDeals);
};

export const pickRandomExampleDeal = async (
    records: readonly unknown[],
    options: Pick<ValidationPickOptions, "random"> = {},
): Promise<ValidationSelection> => {
    if (records.length === 0) throw new Error("No bundled example deals are available.");
    const random = options.random ?? Math.random;
    const value = random();
    if (!Number.isFinite(value) || value < 0 || value >= 1) {
        throw new Error("The example sampler's random source must return a value in [0, 1).");
    }
    const record = records[Math.floor(value * records.length)];
    if (record === undefined) throw new Error("Could not select a bundled example deal.");
    return readValidationRecord(record, records.length);
};

export const pickRandomValidationDeal = async (
    files: readonly File[],
    options: ValidationPickOptions = {},
): Promise<ValidationSelection> => {
    const onProgress = options.onProgress ?? (() => undefined);
    const random = options.random ?? Math.random;
    const shards = await readDatasetShards(files);
    const completeRecordsByDeal = new Map<string, number>();
    let eligibleDeals = 0;
    let selectedDealKey: string | null = null;
    let selectedRecord: Record<string, unknown> | null = null;
    let recordsScanned = 0;

    const draw = (): number => {
        const value = random();
        if (!Number.isFinite(value) || value < 0 || value >= 1) {
            throw new Error("The validation sampler's random source must return a value in [0, 1).");
        }
        return value;
    };

    for (let shardIndex = 0; shardIndex < shards.length; shardIndex += 1) {
        const shard = shards[shardIndex];
        if (shard === undefined) throw new Error("Could not read a validation shard entry.");
        onProgress(`Verifying ${shard.name} (${shardIndex + 1}/${shards.length})...`);
        const contents = await readVerifiedText(shard);
        onProgress(`Scanning ${shard.name} (${shardIndex + 1}/${shards.length})...`);

        let offset = 0;
        let lineNumber = 0;
        while (offset < contents.length) {
            const newline = contents.indexOf("\n", offset);
            const end = newline < 0 ? contents.length : newline;
            const rawLine = contents.slice(offset, end);
            offset = newline < 0 ? contents.length : newline + 1;
            lineNumber += 1;
            const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
            if (line.trim() === "") continue;

            const record = parsePlayRecord(line, shard.name, lineNumber);
            const plays = record.plays;
            if (!Array.isArray(plays)) throw new Error(`${shard.name} line ${lineNumber} has no play list.`);
            if (record.claim === null && plays.length === 52) {
                const numericHands = readNumericHands(record.hands, `${shard.name} line ${lineNumber}`);
                const key = canonicalDealKey(numericHands);
                const previousCount = completeRecordsByDeal.get(key);
                if (previousCount === undefined) {
                    completeRecordsByDeal.set(key, 1);
                    eligibleDeals += 1;
                    if (draw() < 1 / eligibleDeals) {
                        selectedDealKey = key;
                        selectedRecord = record;
                    }
                } else {
                    const nextCount = previousCount + 1;
                    completeRecordsByDeal.set(key, nextCount);
                    if (selectedDealKey === key && draw() < 1 / nextCount) selectedRecord = record;
                }
            }

            recordsScanned += 1;
            if (recordsScanned % 5000 === 0) {
                onProgress(`Scanned ${recordsScanned.toLocaleString()} records; ${eligibleDeals.toLocaleString()} eligible unique deals.`);
                await new Promise<void>((resolve) => setTimeout(resolve, 0));
            }
        }
    }

    if (selectedRecord === null || selectedDealKey === null) {
        throw new Error("No complete, unclaimed 52-card validation records were found.");
    }
    onProgress(`Loading one of ${eligibleDeals.toLocaleString()} eligible unique validation deals...`);
    const selection = await readSelectedRecord(selectedRecord, selectedDealKey, eligibleDeals);
    onProgress(`Loaded validation deal ${selection.sample.dealId}.`);
    return selection;
};
