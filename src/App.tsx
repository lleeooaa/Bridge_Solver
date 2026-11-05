import { useEffect, useMemo, useRef, useState } from "react";
import {
    assessDeal,
    cloneHands,
    createEmptyHands,
    createRandomHands,
    DIRECTIONS,
    formatHand,
    getHandCardCount,
    parseHandNotation,
    RANKS,
    replaceHandCards,
    SUITS,
    toggleCard,
    type Contract,
    type AnalysisSessionFactory,
    type Direction,
    type Doubling,
    type Hands,
    type PlayedCard,
    type Rank,
    type SolverInput,
    type EngineSolverResult,
    type Strain,
    type Suit,
} from "./bridge";
import PlayBoard, { type PlayMode } from "./PlayBoard";
import AdvisorBoard from "./AdvisorBoard";

/** Optional callback used to prove a contract and return a complete optimal line. */
interface AppProps {
    createAnalysisSession?: AnalysisSessionFactory;
    onSolve?: (
        input: SolverInput,
        signal: AbortSignal,
    ) => Promise<EngineSolverResult>;
}

/** Available ways to enter card assignments. */
type EntryMode = "cards" | "text";
/** Categories used to style and announce submit feedback. */
type StatusKind = "info" | "success" | "error";

/** A user-facing message returned from deal submission. */
interface SubmitStatus {
    /** Controls the message's visual treatment and announcement behavior. */
    kind: StatusKind;
    /** Text displayed to the user. */
    message: string;
}

const SUIT_DISPLAY: Record<Suit, { label: string; symbol: string; color: string }> =
{
    spades: { label: "Spades", symbol: "♠", color: "black" },
    hearts: { label: "Hearts", symbol: "♥", color: "red" },
    diamonds: { label: "Diamonds", symbol: "♦", color: "red" },
    clubs: { label: "Clubs", symbol: "♣", color: "black" },
};

const STRAIN_OPTIONS: { value: Strain; label: string; symbol: string; color: string }[] =
    [
        { value: "clubs", label: "Clubs", symbol: "♣", color: "black" },
        { value: "diamonds", label: "Diamonds", symbol: "♦", color: "red" },
        { value: "hearts", label: "Hearts", symbol: "♥", color: "red" },
        { value: "spades", label: "Spades", symbol: "♠", color: "black" },
        { value: "no-trump", label: "No trump", symbol: "NT", color: "neutral" },
    ];

const DIRECTION_SHORT: Record<Direction, string> = {
    North: "N",
    East: "E",
    South: "S",
    West: "W",
};

const DIRECTION_PARTNER: Record<Direction, Direction> = {
    North: "South",
    East: "West",
    South: "North",
    West: "East",
};

const RANK_NAMES: Record<Rank, string> = {
    A: "Ace",
    K: "King",
    Q: "Queen",
    J: "Jack",
    T: "10",
    "9": "9",
    "8": "8",
    "7": "7",
    "6": "6",
    "5": "5",
    "4": "4",
    "3": "3",
    "2": "2",
};

const STRAIN_SYMBOLS: Record<Strain, string> = {
    clubs: "♣",
    diamonds: "♦",
    hearts: "♥",
    spades: "♠",
    "no-trump": "NT",
};

const DOUBLING_SUFFIX: Record<Doubling, string> = {
    undoubled: "",
    doubled: "x",
    redoubled: "xx",
};

const DOUBLING_LABELS: Record<Doubling, string> = {
    undoubled: "Undoubled",
    doubled: "Doubled",
    redoubled: "Redoubled",
};

const DEFAULT_CONTRACT: Contract = {
    level: 3,
    strain: "no-trump",
    declarer: "South",
    doubling: "undoubled",
};

/** Creates blank text-entry values for all four seats. */
const emptyDrafts = (): Record<Direction, string> => ({
    North: "",
    East: "",
    South: "",
    West: "",
});

/** Converts each hand to notation for the text-entry fields. */
const formatHands = (hands: Hands): Record<Direction, string> => ({
    North: formatHand(hands.North),
    East: formatHand(hands.East),
    South: formatHand(hands.South),
    West: formatHand(hands.West),
});

/** Refreshes valid drafts without overwriting invalid in-progress text. */
const syncValidDrafts = (
    hands: Hands,
    currentDrafts: Record<Direction, string>,
): Record<Direction, string> => {
    const nextDrafts = { ...currentDrafts };

    for (const direction of DIRECTIONS) {
        if (parseHandNotation(currentDrafts[direction]).ok) {
            nextDrafts[direction] = formatHand(hands[direction]);
        }
    }

    return nextDrafts;
};

/** Renders the deal builder and submits valid deals to the optional solver callback. */
const App = ({ onSolve, createAnalysisSession }: AppProps) => {
    const [workspaceMode, setWorkspaceMode] = useState<"double-dummy" | "advisor">("double-dummy");
    const [hands, setHands] = useState<Hands>(() => createEmptyHands());
    const [drafts, setDrafts] = useState<Record<Direction, string>>(emptyDrafts);
    const [activeHand, setActiveHand] = useState<Direction>("North");
    const [entryMode, setEntryMode] = useState<EntryMode>("cards");
    const [contract, setContract] = useState<Contract>(DEFAULT_CONTRACT);
    const [submitStatus, setSubmitStatus] = useState<SubmitStatus | null>(null);
    const [isSolving, setIsSolving] = useState(false);
    const [solverResult, setSolverResult] = useState<EngineSolverResult | null>(null);
    const [replayStep, setReplayStep] = useState(0);
    const [interactiveDeal, setInteractiveDeal] = useState<{
        input: SolverInput;
        version: number;
        mode: PlayMode;
    } | null>(null);
    const playVersion = useRef(0);
    const solveAbortController = useRef<AbortController | null>(null);

    useEffect(
        () => () => {
            const controller = solveAbortController.current;
            solveAbortController.current = null;
            controller?.abort();
        },
        [],
    );

    const assessment = useMemo(() => assessDeal(hands), [hands]);
    const textErrors = useMemo(() => {
        const errors: Partial<Record<Direction, string>> = {};

        for (const direction of DIRECTIONS) {
            const parsed = parseHandNotation(drafts[direction]);
            if (!parsed.ok) {
                errors[direction] = parsed.error;
            }
        }

        return errors;
    }, [drafts]);
    const hasTextErrors = DIRECTIONS.some(
        (direction) => textErrors[direction] !== undefined,
    );
    const isReady = assessment.isValid && !hasTextErrors;

    const ownerByCard = useMemo(() => {
        const owners = new Map<string, Direction>();

        for (const direction of DIRECTIONS) {
            for (const suit of SUITS) {
                for (const rank of hands[direction][suit]) {
                    owners.set(`${suit}-${rank}`, direction);
                }
            }
        }

        return owners;
    }, [hands]);

    const contractName = `${contract.level}${STRAIN_SYMBOLS[contract.strain]}${DOUBLING_SUFFIX[contract.doubling]}`;
    const dummy = DIRECTION_PARTNER[contract.declarer];
    const activeTrickStart =
        replayStep === 0 ? 0 : Math.floor((replayStep - 1) / 4) * 4;
    const activeTrickPlays =
        solverResult?.line.slice(activeTrickStart, replayStep) ?? [];
    const nextReplayPlay = solverResult?.line[replayStep];

    /** Cancels stale work and clears a result when its deal or contract changes. */
    const resetSolveState = () => {
        const activeController = solveAbortController.current;
        solveAbortController.current = null;
        activeController?.abort();
        setIsSolving(false);
        setSolverResult(null);
        setReplayStep(0);
        setInteractiveDeal(null);
        setSubmitStatus(null);
    };

    /** Updates one contract field and clears the previous solver result. */
    const updateContract = <K extends keyof Contract,>(
        field: K,
        value: Contract[K],
    ) => {
        setContract((current) => ({ ...current, [field]: value }));
        resetSolveState();
    };

    /** Assigns or removes a card in the currently selected hand. */
    const handleCardClick = (suit: Suit, rank: Rank) => {
        const nextHands = toggleCard(hands, activeHand, suit, rank);
        setHands(nextHands);
        setDrafts((currentDrafts) => syncValidDrafts(nextHands, currentDrafts));
        resetSolveState();
    };

    /** Parses a hand edit and synchronizes other valid text-entry fields. */
    const handleTextChange = (direction: Direction, value: string) => {
        resetSolveState();
        const nextDrafts = { ...drafts, [direction]: value };
        const parsed = parseHandNotation(value);

        if (!parsed.ok) {
            setDrafts(nextDrafts);
            return;
        }

        const nextHands = replaceHandCards(hands, direction, parsed.hand);
        for (const otherDirection of DIRECTIONS) {
            if (
                otherDirection !== direction &&
                parseHandNotation(drafts[otherDirection]).ok
            ) {
                nextDrafts[otherDirection] = formatHand(nextHands[otherDirection]);
            }
        }

        setHands(nextHands);
        setDrafts(nextDrafts);
    };

    /** Generates a complete random deal without changing the selected contract. */
    const generateRandomDeal = () => {
        const randomHands = createRandomHands();
        resetSolveState();
        setHands(randomHands);
        setDrafts(formatHands(randomHands));
        setActiveHand("North");
        setSubmitStatus({
            kind: "success",
            message: "Random board generated. The current contract is unchanged; adjust it before solving if needed.",
        });
    };

    /** Resets all hands and text-entry drafts. */
    const clearDeal = () => {
        setHands(createEmptyHands());
        setDrafts(emptyDrafts());
        resetSolveState();
    };

    /** Runs the solver and retains its result for trick-by-trick replay. */
    const handleSolve = async (mode: PlayMode = "guided") => {
        if (!isReady || isSolving) {
            return;
        }

        if (createAnalysisSession !== undefined) {
            resetSolveState();
            setInteractiveDeal({
                input: { hands: cloneHands(hands), contract: { ...contract } },
                version: ++playVersion.current,
                mode,
            });
            return;
        }

        if (mode === "challenge") {
            setSubmitStatus({
                kind: "error",
                message: "Challenge mode requires an interactive analysis session.",
            });
            return;
        }

        if (onSolve === undefined) {
            setSubmitStatus({
                kind: "info",
                message:
                    "The deal is valid. Connect your algorithm with the onSolve callback to calculate a result.",
            });
            return;
        }

        const controller = new AbortController();
        solveAbortController.current = controller;
        setIsSolving(true);
        setSolverResult(null);
        setReplayStep(0);
        setSubmitStatus({
            kind: "info",
            message: "Proving the contract and finding best play for both sides. A full deal may take a while.",
        });

        try {
            const result = await onSolve(
                {
                    hands: cloneHands(hands),
                    contract: { ...contract },
                },
                controller.signal,
            );
            if (controller.signal.aborted) {
                return;
            }

            setSolverResult(result);
            setSubmitStatus({
                kind: "success",
                message: result.canMakeContract
                    ? `Contract makeable: declarer can force at least ${
                        result.requiredTricks
                    } tricks against any defense.`
                    : `Contract defeated: defenders can hold declarer below ${result.requiredTricks} tricks.`,
            });
        } catch (error: unknown) {
            if (controller.signal.aborted) {
                return;
            }

            const message =
                error instanceof Error && error.message.length > 0
                    ? error.message
                    : "The solver returned an unknown error.";
            setSubmitStatus({ kind: "error", message: `Solver error: ${message}` });
        } finally {
            if (solveAbortController.current === controller) {
                solveAbortController.current = null;
                setIsSolving(false);
            }
        }
    };

    /** Cancels the active solver worker and announces the cancellation. */
    const handleCancelSolve = () => {
        const controller = solveAbortController.current;
        if (controller === null) {
            return;
        }

        solveAbortController.current = null;
        controller.abort();
        setIsSolving(false);
        setSubmitStatus({ kind: "info", message: "Search cancelled." });
    };

    const selectWorkspace = (mode: typeof workspaceMode): void => {
        if (mode === "advisor") {
            handleCancelSolve();
        }
        setWorkspaceMode(mode);
    };

    /** Moves the replay back by one card without moving before the start. */
    const handlePreviousReplayStep = () => {
        setReplayStep((currentStep) => Math.max(0, currentStep - 1));
    };

    /** Advances the replay by one card without moving past the final play. */
    const handleNextReplayStep = () => {
        setReplayStep((currentStep) =>
            Math.min(currentStep + 1, solverResult?.line.length ?? 0),
        );
    };

    /** Resets the replay to the opening lead. */
    const handleRestartReplay = () => {
        setReplayStep(0);
    };

    /** Returns guidance based on the deal's current validation state. */
    const getReadyMessage = (): string => {
        if (hasTextErrors) {
            return "Fix the invalid hand notation before solving.";
        }
        if (assessment.hasDuplicates) {
            return "A card appears in more than one hand.";
        }
        if (assessment.uniqueAssigned === 52) {
            return "Each hand must contain exactly 13 cards.";
        }

        const cardsLeft = 52 - assessment.uniqueAssigned;
        return `${cardsLeft} card${cardsLeft === 1 ? "" : "s"} left to assign.`;
    };

    return (
        <div className="app-shell">
            <header className="topbar">
                <div className="page-container topbar-inner">
                    <a className="brand" href="./" aria-label="Bridge Solver home">
                        <span className="brand-mark" aria-hidden="true">
                            ♠
                        </span>
                        <span className="brand-name">
                            <strong>Bridge</strong>
                            <span>Solver</span>
                        </span>
                    </a>
                    <div className="browser-note">
                        <span className="online-dot" aria-hidden="true" />
                        Runs in your browser
                    </div>
                </div>
            </header>

            <main className="page-container main-content">
                <div className="workspace-tabs" role="tablist" aria-label="Bridge workspace" onKeyDown={(event) => {
                    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
                    event.preventDefault();
                    const next = event.key === "Home" ? "double-dummy" : event.key === "End" ? "advisor"
                        : workspaceMode === "double-dummy" ? "advisor" : "double-dummy";
                    selectWorkspace(next);
                    event.currentTarget.querySelector<HTMLButtonElement>(`[data-mode="${next}"]`)?.focus();
                }}>
                    <button id="double-dummy-tab" role="tab" type="button" data-mode="double-dummy" aria-controls="double-dummy-panel"
                        aria-selected={workspaceMode === "double-dummy"} tabIndex={workspaceMode === "double-dummy" ? 0 : -1}
                        onClick={() => selectWorkspace("double-dummy")}>Solver / Challenge</button>
                    <button id="advisor-tab" role="tab" type="button" data-mode="advisor" aria-controls="advisor-panel"
                        aria-selected={workspaceMode === "advisor"} tabIndex={workspaceMode === "advisor" ? 0 : -1}
                        onClick={() => selectWorkspace("advisor")}>Single-dummy advisor</button>
                </div>
                <div id="double-dummy-panel" role="tabpanel" aria-labelledby="double-dummy-tab" hidden={workspaceMode !== "double-dummy"}>
                <section className="page-heading" aria-labelledby="page-title">
                    <div>
                        <p className="eyebrow">BOARD WORKSPACE</p>
                        <h1 id="page-title">Set up a deal.</h1>
                        <p className="page-description">
                            Enter all four hands and the final contract to prove whether it
                            makes and replay a line of play.
                        </p>
                    </div>
                    <div className="page-tag">
                        <span className="page-tag-icon" aria-hidden="true">
                            52
                        </span>
                        One complete deck
                    </div>
                </section>

                <div className="workspace-grid">
                    <section className="panel deal-panel" aria-labelledby="deal-heading">
                        <div className="panel-heading deal-heading">
                            <div>
                                <p className="panel-kicker">STEP 01 · DEAL</p>
                                <h2 id="deal-heading">Enter the hands</h2>
                                <p className="panel-subtitle">
                                    Assign every card to North, East, South, or West.
                                </p>
                            </div>
                            <div
                                className="card-tally"
                                aria-label={`${assessment.uniqueAssigned} of 52 cards assigned`}
                            >
                                <span className="card-tally-number">{assessment.uniqueAssigned}</span>
                                <span className="card-tally-total">/ 52</span>
                                <span className="card-tally-label">cards assigned</span>
                            </div>
                        </div>

                        <div className="deal-toolbar">
                            <div className="mode-switch" aria-label="Card entry mode">
                                <button
                                    type="button"
                                    className={`mode-button ${entryMode === "cards" ? "is-active" : ""}`}
                                    aria-pressed={entryMode === "cards"}
                                    onClick={() => setEntryMode("cards")}
                                >
                                    Card picker
                                </button>
                                <button
                                    type="button"
                                    className={`mode-button ${entryMode === "text" ? "is-active" : ""}`}
                                    aria-pressed={entryMode === "text"}
                                    onClick={() => setEntryMode("text")}
                                >
                                    Text entry
                                </button>
                            </div>
                            <div className="deal-actions">
                                <button
                                    type="button"
                                    className="quiet-button"
                                    onClick={generateRandomDeal}
                                >
                                    Generate random board
                                </button>
                                <button
                                    type="button"
                                    className="quiet-button clear-button"
                                    onClick={clearDeal}
                                >
                                    Clear deal
                                </button>
                            </div>
                        </div>

                        {entryMode === "cards" ? (
                            <div className="card-entry">
                                <div className="entry-instruction">
                                    <span className="instruction-number">1</span>
                                    Choose a hand, then click cards to assign them. Click an
                                    assigned card again to remove it.
                                </div>

                                <div className="hand-selector" role="group" aria-label="Hand to assign cards to">
                                    {DIRECTIONS.map((direction) => (
                                        <button
                                            type="button"
                                            key={direction}
                                            className={`hand-selector-button ${
                                                activeHand === direction ? "is-active" : ""
                                            }`}
                                            aria-pressed={activeHand === direction}
                                            onClick={() => setActiveHand(direction)}
                                        >
                                            <span className="seat-initial">{DIRECTION_SHORT[direction]}</span>
                                            <span className="seat-name">{direction}</span>
                                            <span
                                                className={`seat-count ${
                                                    assessment.counts[direction] === 13 ? "is-complete" : ""
                                                }`}
                                            >
                                                {assessment.counts[direction]}/13
                                            </span>
                                        </button>
                                    ))}
                                </div>

                                {hasTextErrors && (
                                    <p className="inline-warning" role="status">
                                        Some text entries are invalid. Switch to Text entry to correct
                                        them before solving.
                                    </p>
                                )}

                                <div className="active-hand-note">
                                    Assigning cards to <strong>{activeHand}</strong>
                                </div>

                                <div className="suit-grid">
                                    {SUITS.map((suit) => {
                                        const display = SUIT_DISPLAY[suit];
                                        const assignedInSuit = hands[activeHand][suit].length;

                                        return (
                                            <section
                                                className="suit-card"
                                                key={suit}
                                                aria-label={`${display.label} cards`}
                                            >
                                                <div className="suit-card-heading">
                                                    <span className={`suit-symbol ${display.color}`}>
                                                        {display.symbol}
                                                    </span>
                                                    <span className="suit-name">{display.label}</span>
                                                    <span className="suit-count">{assignedInSuit}</span>
                                                </div>
                                                <div className="rank-grid">
                                                    {RANKS.map((rank) => {
                                                        const owner = ownerByCard.get(`${suit}-${rank}`);
                                                        const isInActiveHand = owner === activeHand;
                                                        const rankLabel = RANK_NAMES[rank];
                                                        const ownerLabel = owner
                                                            ? `assigned to ${owner}`
                                                            : "unassigned";
                                                        const actionLabel = isInActiveHand
                                                            ? "remove it"
                                                            : `assign it to ${activeHand}`;
                                                        const cardAccessibleLabel =
                                                            `${rankLabel} of ${display.label}, ${ownerLabel}. ` +
                                                            `Click to ${actionLabel}.`;
                                                        const cardTitle = owner
                                                            ? `${rankLabel} of ${display.label} · ${owner}`
                                                            : `${rankLabel} of ${display.label} · unassigned`;

                                                        return (
                                                            <button
                                                                type="button"
                                                                key={rank}
                                                                className={[
                                                                    "rank-button",
                                                                    display.color,
                                                                    owner ? "is-assigned" : "",
                                                                    isInActiveHand ? "is-in-active-hand" : "",
                                                                ]
                                                                    .filter(Boolean)
                                                                    .join(" ")}
                                                                aria-pressed={isInActiveHand}
                                                                aria-label={cardAccessibleLabel}
                                                                title={cardTitle}
                                                                onClick={() => handleCardClick(suit, rank)}
                                                            >
                                                                <span>{rank}</span>
                                                                {owner && (
                                                                    <span className="rank-owner">
                                                                        {DIRECTION_SHORT[owner]}
                                                                    </span>
                                                                )}
                                                            </button>
                                                        );
                                                    })}
                                                </div>
                                            </section>
                                        );
                                    })}
                                </div>
                            </div>
                        ) : (
                            <div className="text-entry">
                                <div className="entry-instruction">
                                    Enter each hand as four dot-separated suits in
                                    <strong> Spades.Hearts.Diamonds.Clubs</strong> order.
                                </div>
                                <div className="text-entry-grid">
                                    {DIRECTIONS.map((direction) => {
                                        const error = textErrors[direction];
                                        const inputId = `hand-${direction.toLowerCase()}`;
                                        const helpId = `${inputId}-help`;

                                        return (
                                            <label
                                                className={`text-hand-card ${error ? "has-error" : ""}`}
                                                htmlFor={inputId}
                                                key={direction}
                                            >
                                                <span className="text-seat-initial">
                                                    {DIRECTION_SHORT[direction]}
                                                </span>
                                                <span className="text-hand-content">
                                                    <span className="text-hand-heading">
                                                        <span className="text-hand-name">{direction}</span>
                                                        <span className="text-hand-count">
                                                            {assessment.counts[direction]}/13
                                                        </span>
                                                    </span>
                                                    <input
                                                        id={inputId}
                                                        className="hand-notation-input"
                                                        type="text"
                                                        value={drafts[direction]}
                                                        placeholder="AKQJ.T98.765.432"
                                                        autoComplete="off"
                                                        spellCheck={false}
                                                        aria-label={`${direction} hand, suits in SHDC order`}
                                                        aria-invalid={error !== undefined}
                                                        aria-describedby={helpId}
                                                        onChange={(event) =>
                                                            handleTextChange(direction, event.target.value)
                                                        }
                                                    />
                                                    <span
                                                        className={`text-hand-help ${error ? "has-error" : ""}`}
                                                        id={helpId}
                                                    >
                                                        {error ?? "Use T or 10 for 10; use - for a void suit."}
                                                    </span>
                                                </span>
                                            </label>
                                        );
                                    })}
                                </div>
                                <p className="notation-example">
                                    Example: <code>AKQJ.T98.765.432</code> · A blank hand is allowed
                                    while entering cards.
                                </p>
                            </div>
                        )}

                        <div className="hand-summary">
                            <div className="summary-heading">
                                <div>
                                    <p className="panel-kicker">HAND SUMMARY</p>
                                    <h3>Current card assignments</h3>
                                </div>
                                <span className="summary-hint">S · H · D · C</span>
                            </div>
                            <div className="hand-summary-grid">
                                {DIRECTIONS.map((direction) => (
                                    <article
                                        className={`hand-summary-card ${activeHand === direction ? "is-active" : ""}`}
                                        key={direction}
                                    >
                                        <div className="summary-card-heading">
                                            <span className="summary-seat-initial">
                                                {DIRECTION_SHORT[direction]}
                                            </span>
                                            <span className="summary-seat-name">{direction}</span>
                                            <span
                                                className={`summary-total ${
                                                    assessment.counts[direction] === 13 ? "is-complete" : ""
                                                }`}
                                            >
                                                {assessment.counts[direction]}/13
                                            </span>
                                        </div>
                                        <div className="summary-suit-list">
                                            {SUITS.map((suit) => {
                                                const display = SUIT_DISPLAY[suit];
                                                const ranks =
                                                    RANKS.filter((rank) =>
                                                        hands[direction][suit].includes(rank),
                                                    ).join("") || "—";

                                                return (
                                                    <div className="summary-suit-row" key={suit}>
                                                        <span className={`summary-suit-symbol ${display.color}`}>
                                                            {display.symbol}
                                                        </span>
                                                        <span className="summary-ranks">{ranks}</span>
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    </article>
                                ))}
                            </div>
                        </div>
                    </section>

                    <aside className="side-column">
                        <section className="panel contract-panel" aria-labelledby="contract-heading">
                            <div className="panel-heading compact-heading">
                                <div>
                                    <p className="panel-kicker">STEP 02 · CONTRACT</p>
                                    <h2 id="contract-heading">Set the contract</h2>
                                </div>
                            </div>

                            <div className="contract-field">
                                <label className="field-label" htmlFor="contract-level">
                                    Level
                                </label>
                                <select
                                    id="contract-level"
                                    className="contract-select"
                                    value={contract.level}
                                    onChange={(event) =>
                                        updateContract("level", Number(event.target.value))
                                    }
                                >
                                    {[1, 2, 3, 4, 5, 6, 7].map((level) => (
                                        <option value={level} key={level}>
                                            {level}
                                        </option>
                                    ))}
                                </select>
                            </div>

                            <div className="contract-field">
                                <span className="field-label">Strain</span>
                                <div className="strain-picker" role="group" aria-label="Contract strain">
                                    {STRAIN_OPTIONS.map((strain) => (
                                        <button
                                            type="button"
                                            className={`strain-button ${strain.color} ${
                                                contract.strain === strain.value ? "is-selected" : ""
                                            }`}
                                            aria-label={strain.label}
                                            aria-pressed={contract.strain === strain.value}
                                            title={strain.label}
                                            key={strain.value}
                                            onClick={() => updateContract("strain", strain.value)}
                                        >
                                            {strain.symbol}
                                        </button>
                                    ))}
                                </div>
                            </div>

                            <div className="contract-field">
                                <span className="field-label">Declarer</span>
                                <div className="declarer-picker" role="group" aria-label="Declarer">
                                    {DIRECTIONS.map((direction) => (
                                        <button
                                            type="button"
                                            className={`declarer-button ${
                                                contract.declarer === direction ? "is-selected" : ""
                                            }`}
                                            aria-pressed={contract.declarer === direction}
                                            key={direction}
                                            onClick={() => updateContract("declarer", direction)}
                                        >
                                            <span className="declarer-initial">
                                                {DIRECTION_SHORT[direction]}
                                            </span>
                                            <span>{direction}</span>
                                        </button>
                                    ))}
                                </div>
                            </div>

                            <div className="contract-field">
                                <span className="field-label">Doubling</span>
                                <div className="doubling-picker" role="group" aria-label="Contract doubling">
                                    {(["undoubled", "doubled", "redoubled"] as const).map(
                                        (doubling) => (
                                            <button
                                                type="button"
                                                className={`doubling-button ${
                                                    contract.doubling === doubling ? "is-selected" : ""
                                                }`}
                                                aria-pressed={contract.doubling === doubling}
                                                key={doubling}
                                                onClick={() => updateContract("doubling", doubling)}
                                            >
                                                {DOUBLING_LABELS[doubling]}
                                            </button>
                                        ),
                                    )}
                                </div>
                            </div>

                            <div className="contract-preview" aria-live="polite">
                                <span className="preview-label">CONTRACT SUMMARY</span>
                                <strong className="preview-contract">{contractName}</strong>
                                <span className="preview-declarer">by {contract.declarer}</span>
                                <span className="preview-detail">
                                    {DOUBLING_LABELS[contract.doubling]} · Dummy: {dummy}
                                </span>
                            </div>
                        </section>

                        <section className="panel solve-panel" aria-labelledby="solve-heading">
                            <div className="panel-heading compact-heading">
                                <div>
                                    <p className="panel-kicker">STEP 03 · SOLVE</p>
                                    <h2 id="solve-heading">Check the deal</h2>
                                </div>
                                <span
                                    className={`ready-indicator ${isReady ? "is-ready" : ""}`}
                                    aria-label={isReady ? "Deal ready" : "Deal incomplete"}
                                />
                            </div>

                            <div className="progress-summary">
                                <div className="progress-caption">
                                    <span>Cards assigned</span>
                                    <strong>{assessment.uniqueAssigned} / 52</strong>
                                </div>
                                <div
                                    className="progress-track"
                                    role="progressbar"
                                    aria-label="Cards assigned"
                                    aria-valuemin={0}
                                    aria-valuemax={52}
                                    aria-valuenow={assessment.uniqueAssigned}
                                >
                                    <span
                                        className="progress-value"
                                        style={{
                                            width: `${(assessment.uniqueAssigned / 52) * 100}%`,
                                        }}
                                    />
                                </div>
                                <div className="hand-count-list">
                                    {DIRECTIONS.map((direction) => (
                                        <span className="hand-count-chip" key={direction}>
                                            <span>{DIRECTION_SHORT[direction]}</span>
                                            <strong>{assessment.counts[direction]}</strong>
                                        </span>
                                    ))}
                                </div>
                            </div>

                            <p className={`ready-message ${isReady ? "is-ready" : ""}`}>
                                <span className="ready-message-dot" aria-hidden="true" />
                                {isReady ? "All four hands are complete." : getReadyMessage()}
                            </p>

                            <button
                                type="button"
                                className="solve-button"
                                disabled={!isReady || isSolving}
                                onClick={() => handleSolve("guided")}
                            >
                                <span>{isSolving ? "Searching..." : "Run solver"}</span>
                                {!isSolving && <span aria-hidden="true">→</span>}
                            </button>

                            {createAnalysisSession !== undefined && (
                                <button
                                    type="button"
                                    className="solve-button challenge-button"
                                    disabled={!isReady || isSolving}
                                    onClick={() => handleSolve("challenge")}
                                >
                                    <span>Start challenge</span>
                                    <span aria-hidden="true">♠</span>
                                </button>
                            )}

                            {isSolving && (
                                <button
                                    type="button"
                                    className="cancel-solve-button"
                                    onClick={handleCancelSolve}
                                >
                                    Cancel search
                                </button>
                            )}

                            {submitStatus && (
                                <p
                                    className={`submit-status ${submitStatus.kind}`}
                                    role={submitStatus.kind === "error" ? "alert" : "status"}
                                    aria-live="polite"
                                >
                                    {submitStatus.message}
                                </p>
                            )}
                            {solverResult !== null && (
                                <section
                                    className="replay-panel"
                                    aria-labelledby="replay-heading"
                                >
                                    <div className="replay-heading">
                                        <div>
                                            <p className="panel-kicker">CONTRACT ANALYSIS</p>
                                            <h3 id="replay-heading">Replay optimal play</h3>
                                        </div>
                                        <strong className="trick-result">
                                            {solverResult.canMakeContract ? "Makes" : "Set"}
                                            <span> / {solverResult.requiredTricks} required</span>
                                        </strong>
                                    </div>

                                    <p className="replay-note">
                                        With best play by both sides, declarer takes{" "}
                                        {solverResult.optimalDeclarerTricks} of{" "}
                                        {solverResult.line.length / 4} tricks.
                                        {" "}One optimal line is shown; equally optimal alternatives
                                        are omitted.
                                    </p>

                                    <p className="replay-progress" aria-live="polite">
                                        Card {replayStep} of {solverResult.line.length}
                                    </p>
                                    <div
                                        className="replay-trick"
                                        aria-label={`Trick ${Math.floor(activeTrickStart / 4) + 1} replay`}
                                    >
                                        {activeTrickPlays.length === 0 ? (
                                            <span className="replay-empty">
                                                Advance to show the opening lead.
                                            </span>
                                        ) : (
                                            activeTrickPlays.map((play: PlayedCard) => (
                                                <div
                                                    className="replay-card"
                                                    key={`${play.player}-${play.card.suit}-${play.card.rank}`}
                                                >
                                                    <span className="replay-seat">
                                                        {DIRECTION_SHORT[play.player]}
                                                    </span>
                                                    <strong>
                                                        {RANK_NAMES[play.card.rank]}
                                                        <span
                                                            className={
                                                                SUIT_DISPLAY[play.card.suit].color === "red"
                                                                    ? "red"
                                                                    : ""
                                                            }
                                                        >
                                                            {SUIT_DISPLAY[play.card.suit].symbol}
                                                        </span>
                                                    </strong>
                                                </div>
                                            ))
                                        )}
                                    </div>

                                    <p className="replay-next-play" aria-live="polite">
                                        {nextReplayPlay === undefined
                                            ? "The replay is complete."
                                            : `Next: ${nextReplayPlay.player} plays ${
                                                RANK_NAMES[nextReplayPlay.card.rank]
                                            }${SUIT_DISPLAY[nextReplayPlay.card.suit].symbol}`}
                                    </p>

                                    <div className="replay-controls">
                                        <button
                                            type="button"
                                            className="replay-control-button"
                                            disabled={replayStep === 0}
                                            onClick={handleRestartReplay}
                                        >
                                            Restart
                                        </button>
                                        <button
                                            type="button"
                                            className="replay-control-button"
                                            disabled={replayStep === 0}
                                            onClick={handlePreviousReplayStep}
                                        >
                                            Previous
                                        </button>
                                        <button
                                            type="button"
                                            className="replay-control-button is-primary"
                                            disabled={replayStep === solverResult.line.length}
                                            onClick={handleNextReplayStep}
                                        >
                                            Next
                                        </button>
                                    </div>
                                </section>
                            )}
                            <p className="privacy-note">
                                Your deal and search stay in this browser.
                            </p>
                        </section>
                    </aside>
                </div>
                {interactiveDeal !== null && createAnalysisSession !== undefined && (
                    <PlayBoard
                        key={interactiveDeal.version}
                        input={interactiveDeal.input}
                        createSession={createAnalysisSession}
                        mode={interactiveDeal.mode}
                        active={workspaceMode === "double-dummy"}
                    />
                )}
                </div>
                <div id="advisor-panel" role="tabpanel" aria-labelledby="advisor-tab" hidden={workspaceMode !== "advisor"}>
                    <AdvisorBoard active={workspaceMode === "advisor"} />
                </div>
            </main>

            <footer className="page-container app-footer">
                <span>Bridge Solver</span>
                <span>Library DDS | Double-dummy play and single-dummy advice</span>
            </footer>
        </div>
    );
};

export default App;
