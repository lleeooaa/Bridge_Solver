import { useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import {
    DIRECTIONS, RANKS, SUITS, formatHand, parseHandNotation,
    type Card, type Contract, type EngineAnalysisSession, type PlayedCard, type SolverInput,
} from "./bridge";
import { createAdvisorClient, type AdvisorClient } from "./ai/advisorClient";
import { buildBeliefFeatures } from "./ai/belief";
import {
    pickRandomValidationDeal, type ValidationFullInformation,
} from "./ai/validationDataset";
import {
    VULNERABILITIES, createAdvisorContext, parseAuction, type AdvisorContext, type Vulnerability,
} from "./ai/context";
import { defaultBeliefManifestUrl } from "./ai/modelPolicy";
import { buildObservation, getDummy, getObservedPlayableCards } from "./ai/observation";
import type { Advice, AdvisorInput } from "./ai/types";
import { createBrowserDdsEngine, getDdsRuntimeUrl } from "./dds/browser";
import { cardKey } from "./dds/engine";
import { createDdsAnalysisSession } from "./dds/session";
import { getTrickWinner, isDeclarerSide } from "./play";
import { formatCard, formatContract, formatPlayedCard } from "./solverText";

const strains = [...SUITS, "no-trump"] as const;
const doublingOptions = ["undoubled", "doubled", "redoubled"] as const;
const messageFor = (error: unknown): string => error instanceof Error ? error.message : "Advisor failed.";
const percent = (value: number): string => `${(value * 100).toFixed(1)}%`;
const vulnerabilityLabels: Record<Vulnerability, string> = {
    unknown: "Unknown", none: "Neither side", "north-south": "North / South", "east-west": "East / West", both: "Both sides",
};

const AdvisorContextFields = ({ value, auctionText, onChange, onAuctionChange }: {
    value: AdvisorContext; auctionText: string;
    onChange: (value: AdvisorContext) => void; onAuctionChange: (value: string) => void;
}) => (
    <fieldset className="advisor-context">
        <legend>Auction context (optional)</legend>
        <p className="advisor-help">Learned mode requires the complete auction, dealer and vulnerability. Uniform mode does not weight deals using this context.</p>
        <div className="advisor-fields">
            <label htmlFor="advisor-dealer">Dealer
                <select id="advisor-dealer" value={value.dealer ?? ""} onChange={(event) => {
                    const dealer = DIRECTIONS.find((seat) => seat === event.target.value) ?? null;
                    onChange({ ...value, dealer });
                }}>
                    <option value="">Unknown</option>
                    {DIRECTIONS.map((seat) => <option key={seat}>{seat}</option>)}
                </select>
            </label>
            <label htmlFor="advisor-vulnerability">Vulnerability
                <select id="advisor-vulnerability" value={value.vulnerability} onChange={(event) => {
                    const vulnerability = VULNERABILITIES.find((entry) => entry === event.target.value);
                    if (vulnerability !== undefined) onChange({ ...value, vulnerability });
                }}>
                    {VULNERABILITIES.map((entry) => <option key={entry} value={entry}>{vulnerabilityLabels[entry]}</option>)}
                </select>
            </label>
        </div>
        <label className="advisor-context-field" htmlFor="advisor-auction">Complete auction, starting with dealer
            <textarea id="advisor-auction" value={auctionText} onChange={(event) => onAuctionChange(event.target.value)}
                maxLength={2000} rows={2} placeholder="1C P 1H P 1NT P 3NT P P P" aria-describedby="advisor-auction-help" />
        </label>
        <p id="advisor-auction-help" className="advisor-help">Use P, X, XX and bids 1C through 7NT, separated by spaces. Leave blank if unknown. A supplied auction must be legal, complete and match the selected contract and declarer.</p>
    </fieldset>
);

interface AdvisorView {
    readonly history: readonly PlayedCard[];
    readonly samples: number;
    readonly seed: string;
    readonly beliefKey: string;
    readonly advice?: Advice;
    readonly error?: string;
    readonly pending: boolean;
}

interface ValidationBoardInfo {
    readonly dealId: string;
    readonly auction: string;
    readonly contract: Contract;
    readonly openingLead: PlayedCard;
    readonly eligibleDeals: number;
}

interface ValidationDdsSession {
    readonly dealId: string;
    readonly analysis: EngineAnalysisSession;
}

const AdvisorBoard = ({ active }: { active: boolean }) => {
    const [contract, setContract] = useState<Contract>({
        level: 3, strain: "no-trump", declarer: "South", doubling: "undoubled",
    });
    const [declarerText, setDeclarerText] = useState("");
    const [dummyText, setDummyText] = useState("");
    const [context, setContext] = useState(createAdvisorContext);
    const [auctionText, setAuctionText] = useState("");
    const [input, setInput] = useState<AdvisorInput | null>(null);
    const [history, setHistory] = useState<readonly PlayedCard[]>([]);
    const [samples, setSamples] = useState(200);
    const [seed, setSeed] = useState("1");
    const [beliefMode, setBeliefMode] = useState<"uniform" | "learned">("uniform");
    const [modelUrl, setModelUrl] = useState(() => defaultBeliefManifestUrl(window.location.hostname));
    const [error, setError] = useState<string | null>(null);
    const [view, setView] = useState<AdvisorView | null>(null);
    const [paused, setPaused] = useState(false);
    const [retry, setRetry] = useState(0);
    const [validationFiles, setValidationFiles] = useState<readonly File[]>([]);
    const [validationBusy, setValidationBusy] = useState(false);
    const [validationStatus, setValidationStatus] = useState("No validation dataset selected.");
    const [validationBoard, setValidationBoard] = useState<ValidationBoardInfo | null>(null);
    const [validationHybridActive, setValidationHybridActive] = useState(false);
    const [validationHybridStatus, setValidationHybridStatus] = useState("");
    const client = useRef<AdvisorClient | null>(null);
    const validationDirectoryInput = useRef<HTMLInputElement | null>(null);
    const validationFullInformation = useRef<ValidationFullInformation | null>(null);
    const validationDdsSession = useRef<ValidationDdsSession | null>(null);
    const validationDdsController = useRef<AbortController | null>(null);
    const disposeValidationDdsSession = (): void => {
        const controller = validationDdsController.current;
        validationDdsController.current = null;
        controller?.abort();
        const current = validationDdsSession.current;
        validationDdsSession.current = null;
        current?.analysis.dispose();
    };
    const observation = useMemo(() => input === null ? null : buildObservation(input, history), [input, history]);
    const trickHistory = useMemo(() => {
        if (input === null) return [];
        return Array.from({ length: Math.ceil(history.length / 4) }, (_, index) => {
            const plays = history.slice(index * 4, index * 4 + 4);
            return {
                number: index + 1,
                plays,
                winner: plays.length === 4 ? getTrickWinner(plays, input.contract) : null,
            };
        });
    }, [history, input]);
    const beliefKey = `${beliefMode}:${beliefMode === "learned" ? modelUrl : ""}`;
    const currentView = view?.history === history && view.samples === samples && view.seed === seed &&
        view.beliefKey === beliefKey ? view : null;
    const advice = currentView?.advice;
    const controlled = input !== null && observation !== null &&
        isDeclarerSide(observation.playerToMove, input.contract);
    const playable = input === null || observation === null ? [] : getObservedPlayableCards(observation, input.contract);
    const playableKeys = new Set(playable.map(cardKey));
    const top = advice?.candidates[0];
    const recommended = new Set(advice?.candidates.filter((candidate) =>
        candidate.makeProbability === top?.makeProbability && candidate.expectedTricks === top.expectedTricks)
        .map((candidate) => cardKey(candidate.card)));

    useEffect(() => {
        if (!active || input === null) return;
        try {
            const created = createAdvisorClient();
            client.current = created;
            return () => { client.current = null; created.dispose(); };
        } catch (failure: unknown) {
            setView({ history, samples, seed, beliefKey, error: messageFor(failure), pending: false });
        }
    }, [active, input, retry]);

    useEffect(() => {
        if (!active || input === null || observation === null || observation.isComplete || !controlled || paused) return;
        const connection = client.current;
        if (connection === null) return;
        const controller = new AbortController();
        const base = { history, samples, seed, beliefKey };
        if (seed.trim() === "") {
            setView({ ...base, pending: false, error: "Enter an unsigned 32-bit integer seed." });
            return;
        }
        setView({ ...base, pending: true });
        void connection.analyze(input, history, {
            samples, seed: Number(seed), belief: beliefMode === "learned" ?
                { type: "learned", manifestUrl: modelUrl } : { type: "uniform" },
        }, controller.signal, (progress) => {
            if (!controller.signal.aborted) setView({ ...base, pending: true, advice: progress });
        }).then((result) => {
            if (!controller.signal.aborted) {
                setView({ ...base, pending: false, advice: result });
                if (result.model === "learned-joint") {
                    console.info("[Bridge Advisor] Learned model and DDS advice", {
                        modelId: result.modelId,
                        modelVersion: result.modelVersion,
                        samples: result.samples,
                        effectiveSampleSize: result.effectiveSampleSize,
                        candidates: result.candidates.map((candidate) => ({
                            card: formatCard(candidate.card),
                            makeProbability: candidate.makeProbability,
                            expectedTricks: candidate.expectedTricks,
                            samplingInterval: candidate.samplingInterval,
                        })),
                    });
                }
            }
        }, (failure: unknown) => {
            if (!controller.signal.aborted) setView({ ...base, pending: false, error: messageFor(failure) });
        });
        return () => controller.abort();
    }, [active, input, observation, controlled, history, samples, seed, paused, retry, beliefMode, modelUrl, beliefKey]);

    useEffect(() => () => {
        const controller = validationDdsController.current;
        validationDdsController.current = null;
        controller?.abort();
        const session = validationDdsSession.current;
        validationDdsSession.current = null;
        session?.analysis.dispose();
    }, []);

    useEffect(() => {
        if (!active || !validationHybridActive || input === null || observation === null ||
            observation.isComplete || controlled) return;
        const current = validationDdsSession.current;
        if (current === null || validationBoard === null || current.dealId !== validationBoard.dealId) {
            const message = "The full-information DDS session is unavailable for this validation deal. Stop and start interactive hybrid play again.";
            setError(message);
            setValidationHybridStatus(`Hybrid play stopped: ${message}`);
            setValidationHybridActive(false);
            disposeValidationDdsSession();
            return;
        }

        const controller = new AbortController();
        validationDdsController.current = controller;
        const player = observation.playerToMove;
        setValidationHybridStatus(`Full-information DDS is choosing ${player}'s defensive card...`);
        void current.analysis.analyze(history, controller.signal).then((result) => {
            if (controller.signal.aborted) return;
            const card = result.recommendedCards[0];
            if (card === undefined) throw new Error("DDS did not provide an optimal defensive card.");
            const played: PlayedCard = { player, card };
            const next = [...history, played];
            const nextObservation = buildObservation(input, next);
            setError(null);
            setHistory(next);
            console.info("[Bridge Advisor] Validation hybrid DDS defense", {
                dealId: current.dealId,
                card: formatPlayedCard(played),
                cardsPlayed: next.length,
            });
            if (nextObservation.isComplete) {
                const made = nextObservation.declarerTricksWon >= input.contract.level + 6;
                setValidationHybridStatus(
                    `Hybrid play complete: ${nextObservation.declarerTricksWon} declarer tricks; ${made ? "contract made" : "contract set"}.`,
                );
                setValidationHybridActive(false);
                disposeValidationDdsSession();
            } else {
                setValidationHybridStatus(
                    `DDS played ${formatPlayedCard(played)}. The model will analyze the next declarer/dummy decision.`,
                );
            }
        }).catch((failure: unknown) => {
            if (controller.signal.aborted) return;
            const message = messageFor(failure);
            setError(message);
            setValidationHybridStatus(`DDS defender play failed: ${message}`);
            setValidationHybridActive(false);
            disposeValidationDdsSession();
        }).finally(() => {
            if (validationDdsController.current === controller) validationDdsController.current = null;
        });
        return () => {
            controller.abort();
            if (validationDdsController.current === controller) validationDdsController.current = null;
        };
    }, [active, validationHybridActive, input, observation, controlled, history, validationBoard?.dealId]);

    useEffect(() => {
        if (!active || !validationHybridActive || !controlled || advice?.complete !== true) return;
        setValidationHybridStatus("Model advice is ready. Choose a declarer/dummy card to continue.");
    }, [active, validationHybridActive, controlled, advice?.complete]);

    const start = (event: FormEvent): void => {
        event.preventDefault();
        try {
            const declarer = parseHandNotation(declarerText);
            const dummy = parseHandNotation(dummyText);
            if (!declarer.ok) throw new Error(`Declarer: ${declarer.error}`);
            if (!dummy.ok) throw new Error(`Dummy: ${dummy.error}`);
            const next: AdvisorInput = {
                contract: { ...contract }, declarerHand: declarer.hand, dummyHand: dummy.hand,
                context: { ...context, auction: parseAuction(auctionText, context.dealer) },
            };
            const observed = buildObservation(next);
            setError(null);
            disposeValidationDdsSession();
            setValidationHybridActive(false);
            setValidationHybridStatus("");
            setHistory([]);
            setView(null);
            setPaused(false);
            setInput({ ...next, context: observed.context });
            validationFullInformation.current = null;
            setValidationBoard(null);
        } catch (failure: unknown) {
            setError(messageFor(failure));
        }
    };

    const chooseValidationFolder = (): void => {
        const picker = validationDirectoryInput.current;
        if (picker === null) return;
        picker.setAttribute("webkitdirectory", "");
        picker.click();
    };

    const onValidationFolderChange = (event: ChangeEvent<HTMLInputElement>): void => {
        const files = Array.from(event.currentTarget.files ?? []);
        event.currentTarget.value = "";
        if (files.length === 0) return;
        disposeValidationDdsSession();
        setValidationHybridActive(false);
        setValidationHybridStatus("");
        if (!files.some((file) => file.name.toLowerCase() === "manifest.json")) {
            const message = "Choose the prepared dataset folder containing manifest.json and its validation shards.";
            setValidationFiles([]);
            validationFullInformation.current = null;
            setValidationBoard(null);
            setValidationStatus(message);
            setError(message);
            return;
        }
        setValidationFiles(files);
        validationFullInformation.current = null;
        setValidationBoard(null);
        setInput(null);
        setHistory([]);
        setView(null);
        setPaused(false);
        setError(null);
        setValidationStatus(`Selected ${files.length.toLocaleString()} local files. Ready to pick a validation board.`);
    };

    const pickValidationBoard = async (): Promise<void> => {
        if (validationFiles.length === 0 || validationBusy || validationHybridActive) return;
        disposeValidationDdsSession();
        setValidationHybridStatus("");
        setValidationBusy(true);
        setValidationBoard(null);
        setValidationStatus("Reading the local validation set...");
        setError(null);
        try {
            const selection = await pickRandomValidationDeal(validationFiles, { onProgress: setValidationStatus });
            const sample = selection.sample;
            validationFullInformation.current = selection.fullInformation;
            const nextInput: AdvisorInput = {
                contract: sample.contract,
                declarerHand: sample.declarerHand,
                dummyHand: sample.dummyHand,
                context: sample.context,
            };
            const nextHistory: readonly PlayedCard[] = [sample.openingLead];
            const observed = buildObservation(nextInput, nextHistory);
            setContract(sample.contract);
            setDeclarerText(formatHand(sample.declarerHand));
            setDummyText(formatHand(sample.dummyHand));
            setContext(sample.context);
            setAuctionText(sample.auction.join(" "));
            setHistory(nextHistory);
            setView(null);
            setPaused(false);
            setInput({ ...nextInput, context: observed.context });
            setValidationBoard({
                dealId: sample.dealId,
                auction: sample.auction.join(" "),
                contract: sample.contract,
                openingLead: sample.openingLead,
                eligibleDeals: sample.eligibleDeals,
            });
            setValidationStatus(
                `Loaded ${formatContract(sample.contract)} after ${formatCard(sample.openingLead.card)}; ` +
                `sampled uniformly from ${sample.eligibleDeals.toLocaleString()} eligible unique deals.`,
            );
        } catch (failure: unknown) {
            const message = messageFor(failure);
            setError(message);
            setValidationStatus(`Could not load a validation board: ${message}`);
        } finally {
            setValidationBusy(false);
        }
    };

    const startInteractiveHybridPlay = (): void => {
        const fullInformation = validationFullInformation.current;
        const numericSeed = Number(seed);
        if (input === null || validationBoard === null || fullInformation === null) return;
        if (seed.trim() === "" || !Number.isInteger(numericSeed) || numericSeed < 0 || numericSeed > 0xffffffff) {
            setError("Enter an unsigned 32-bit integer seed before starting interactive hybrid play.");
            return;
        }

        disposeValidationDdsSession();
        setError(null);
        setPaused(false);
        setView(null);
        let ddsEngine: ReturnType<typeof createBrowserDdsEngine> | null = null;
        let ddsSession: EngineAnalysisSession | null = null;
        try {
            ddsEngine = createBrowserDdsEngine(getDdsRuntimeUrl());
            const fullDeal: SolverInput = { hands: fullInformation.hands, contract: input.contract };
            ddsSession = createDdsAnalysisSession(fullDeal, ddsEngine);
            validationDdsSession.current = { dealId: validationBoard.dealId, analysis: ddsSession };
            ddsSession = null;
            ddsEngine = null;
            setHistory([validationBoard.openingLead]);
            setValidationHybridStatus(
                `Interactive hybrid play started with the recorded opening lead ${formatPlayedCard(validationBoard.openingLead)}. ` +
                "Choose declarer/dummy cards; full-information DDS will play the defenders.",
            );
            setValidationHybridActive(true);
            console.info("[Bridge Advisor] Interactive validation hybrid started", {
                dealId: validationBoard.dealId,
                contract: formatContract(validationBoard.contract),
                openingLead: formatPlayedCard(validationBoard.openingLead),
                belief: beliefMode,
            });
        } catch (failure: unknown) {
            if (ddsSession !== null) ddsSession.dispose();
            else ddsEngine?.dispose();
            const message = messageFor(failure);
            setError(message);
            setValidationHybridStatus(`Could not start interactive hybrid play: ${message}`);
        }
    };

    const stopInteractiveHybridPlay = (): void => {
        disposeValidationDdsSession();
        setValidationHybridActive(false);
        setValidationHybridStatus("Interactive hybrid play stopped. Defender cards can now be entered manually.");
    };

    const play = (card: Card): void => {
        if (input === null || observation === null) return;
        try {
            const next = [...history, { player: observation.playerToMove, card }];
            const nextObservation = buildObservation(input, next);
            setError(null);
            setPaused(false);
            setHistory(next);
            if (validationHybridActive) {
                if (nextObservation.isComplete) {
                    const made = nextObservation.declarerTricksWon >= input.contract.level + 6;
                    setValidationHybridStatus(
                        `Hybrid play complete: ${nextObservation.declarerTricksWon} declarer tricks; ${made ? "contract made" : "contract set"}.`,
                    );
                    setValidationHybridActive(false);
                    disposeValidationDdsSession();
                } else if (isDeclarerSide(nextObservation.playerToMove, input.contract)) {
                    setValidationHybridStatus("Your card was played. The model will analyze the next declarer/dummy decision.");
                } else {
                    setValidationHybridStatus("Your card was played. Full-information DDS will choose the defender's card.");
                }
            }
        } catch (failure: unknown) {
            setError(messageFor(failure));
        }
    };

    const downloadFeatures = (): void => {
        if (input === null) return;
        try {
            const features = buildBeliefFeatures(input, history);
            const url = URL.createObjectURL(new Blob([JSON.stringify(features, null, 2)], { type: "application/json" }));
            const link = document.createElement("a");
            link.href = url;
            link.download = "bridge-belief-features-v1.json";
            try {
                link.click();
            } finally {
                window.setTimeout(() => URL.revokeObjectURL(url), 0);
            }
            setError(null);
        } catch (failure: unknown) {
            setError(messageFor(failure));
        }
    };

    return (
        <section className="advisor-workspace" aria-labelledby="advisor-title">
            <div className="page-heading">
                <div>
                    <p className="eyebrow">IMPERFECT INFORMATION</p>
                    <h1 id="advisor-title">Single-dummy advisor</h1>
                    <p className="page-description">The advisor sees declarer, dummy and public play. Record actual defender cards manually, or use validation hybrid play to let full-information DDS choose the defense.</p>
                </div>
                <div className="page-tag">Library DDS + Monte Carlo</div>
            </div>
            <p className="advisor-disclaimer">
                <strong>Belief inference:</strong> choose uniform hard constraints or an explicitly loaded mixed-system auction-and-play model.
                No trained human model is bundled. Estimates assume double-dummy continuation in each sample, not a guaranteed playable strategy.
            </p>
            <section className="panel advisor-setup advisor-validation-picker" aria-labelledby="advisor-validation-title">
                <h2 id="advisor-validation-title">Test with a validation deal</h2>
                <p>Select the local prepared dataset folder. The app verifies and scans only the validation shards listed in its manifest; the files stay in your browser and are never uploaded. It picks a complete, unclaimed deal uniformly by unique deal, then loads its auction and recorded opening lead.</p>
                <input
                    ref={validationDirectoryInput}
                    id="advisor-validation-folder"
                    type="file"
                    multiple
                    hidden
                    aria-label="Local prepared validation dataset files"
                    disabled={validationHybridActive}
                    onChange={onValidationFolderChange}
                />
                <div className="play-controls">
                    <button type="button" disabled={validationBusy || validationHybridActive} onClick={chooseValidationFolder}>Choose prepared dataset folder</button>
                    <button type="button" disabled={validationFiles.length === 0 || validationBusy || validationHybridActive}
                        onClick={() => { void pickValidationBoard(); }}>Pick random validation board</button>
                </div>
                <p role="status" aria-live="polite">{validationStatus}</p>
                {validationBoard !== null && <p className="advisor-help">
                    Deal ID: <code>{validationBoard.dealId}</code>. {formatContract(validationBoard.contract)}; opening lead {formatPlayedCard(validationBoard.openingLead)}.
                    Auction: {validationBoard.auction}. The advisor receives only declarer/dummy hands and public context; all four hands stay separate and are used only by DDS during hybrid defense.
                </p>}
                {validationBoard !== null && <p className="advisor-help">
                    Interactive hybrid play starts from the recorded opening lead. You choose cards for declarer/dummy using the model's advice; DDS sees the full deal and automatically chooses every defender card. The model still receives only the two visible hands and public play.
                </p>}
                {validationBoard !== null && (
                    <div className="play-controls">
                        {validationHybridActive
                            ? <button type="button" onClick={stopInteractiveHybridPlay}>Stop interactive hybrid play</button>
                            : <button type="button" disabled={input === null || validationFullInformation.current === null}
                                onClick={startInteractiveHybridPlay}>Start interactive hybrid play</button>}
                    </div>
                )}
                {validationHybridStatus !== "" && <p role="status" aria-live="polite">{validationHybridStatus}</p>}
            </section>
            {error !== null && <p className="advisor-error" role="alert">{error}</p>}
            {input === null ? (
                <form className="panel advisor-setup" onSubmit={start}>
                    <h2>Enter the two visible hands</h2>
                    <p>Use Spades.Hearts.Diamonds.Clubs notation, T for ten, and - for a void. Each original hand must contain 13 cards.</p>
                    <div className="advisor-fields">
                        <label htmlFor="advisor-declarer">Declarer
                            <select id="advisor-declarer" value={contract.declarer} onChange={(event) => {
                                const seat = DIRECTIONS.find((value) => value === event.target.value);
                                if (seat !== undefined) setContract({ ...contract, declarer: seat });
                            }}>{DIRECTIONS.map((seat) => <option key={seat}>{seat}</option>)}</select>
                        </label>
                        <label htmlFor="advisor-level">Level
                            <select id="advisor-level" value={contract.level} onChange={(event) => setContract({ ...contract, level: Number(event.target.value) })}>
                                {[1, 2, 3, 4, 5, 6, 7].map((level) => <option key={level}>{level}</option>)}
                            </select>
                        </label>
                        <label htmlFor="advisor-strain">Strain
                            <select id="advisor-strain" value={contract.strain} onChange={(event) => {
                                const strain = strains.find((value) => value === event.target.value);
                                if (strain !== undefined) setContract({ ...contract, strain });
                            }}>{strains.map((strain) => <option key={strain} value={strain}>{strain === "no-trump" ? "No trump" : strain}</option>)}</select>
                        </label>
                        <label htmlFor="advisor-doubling">Doubling
                            <select id="advisor-doubling" value={contract.doubling} onChange={(event) => {
                                const doubling = doublingOptions.find((value) => value === event.target.value);
                                if (doubling !== undefined) setContract({ ...contract, doubling });
                            }}>{doublingOptions.map((doubling) => <option key={doubling}>{doubling}</option>)}</select>
                        </label>
                    </div>
                    <label className="advisor-hand-input" htmlFor="advisor-own-hand">{contract.declarer}'s original hand (declarer)
                        <input id="advisor-own-hand" value={declarerText} onChange={(event) => setDeclarerText(event.target.value)} placeholder="AKQ.JT9.876.5432" autoComplete="off" spellCheck={false} required />
                    </label>
                    <label className="advisor-hand-input" htmlFor="advisor-dummy-hand">{getDummy(contract.declarer)}'s original hand (dummy)
                        <input id="advisor-dummy-hand" value={dummyText} onChange={(event) => setDummyText(event.target.value)} placeholder="JT9.AKQ.5432.876" autoComplete="off" spellCheck={false} required />
                    </label>
                    <AdvisorContextFields value={context} auctionText={auctionText} onChange={setContext} onAuctionChange={setAuctionText} />
                    <div className="play-controls">
                        <button type="submit">Start advisor</button>
                        <button type="button" onClick={() => {
                            setContract({ level: 1, strain: "no-trump", declarer: "West", doubling: "undoubled" });
                            setDeclarerText("AJ.AQ5.96543.Q72");
                            setDummyText("Q7652.32.JT.KT63");
                            setContext(createAdvisorContext());
                            setAuctionText("");
                            setError(null);
                        }}>Load example hands</button>
                    </div>
                    <p className="advisor-help">Example: 1NT by West, dummy East. After starting, record North's KD opening lead. No defender hand is loaded.</p>
                </form>
            ) : observation !== null && (
                <div className="panel advisor-play">
                    <div className="play-heading">
                        <div>
                            <h2>{formatContract(input.contract)}</h2>
                            <p>{observation.isComplete ? "Play complete" : `${observation.playerToMove} to play`} | Declarer {observation.declarerTricksWon}, defenders {observation.defenderTricksWon} | {history.length}/52 cards</p>
                        </div>
                        <div className="play-controls">
                            <button type="button" disabled={history.length === 0 || validationHybridActive} onClick={() => {
                                setHistory(history.slice(0, -1)); setError(null); setPaused(false);
                            }}>Undo one card</button>
                            <button type="button" disabled={history.length === 0 || validationHybridActive} onClick={() => {
                                setHistory([]); setError(null); setPaused(false);
                            }}>Restart play</button>
                            <button type="button" disabled={validationHybridActive} onClick={() => {
                                disposeValidationDdsSession();
                                setValidationHybridStatus("");
                                setInput(null);
                                setError(null);
                                validationFullInformation.current = null;
                                setValidationBoard(null);
                            }}>Edit visible hands</button>
                            <button type="button" disabled={!controlled || observation.isComplete} onClick={downloadFeatures}>Download model features</button>
                        </div>
                    </div>
                    <details className="advisor-context">
                        <summary>Auction context</summary>
                        <p className="advisor-help">{beliefMode === "uniform" ?
                            "Uniform baseline active; this context is recorded but not used to weight deals. No trained model is loaded." :
                            "Learned mode uses the dealer, vulnerability, auction and public play."}</p>
                        <p>Dealer: {observation.context.dealer ?? "Unknown"} | Vulnerability: {vulnerabilityLabels[observation.context.vulnerability]}</p>
                        <p>Auction: {observation.context.auction.map((entry) => `${entry.player}: ${entry.call}`).join(" | ") || "Unknown"}</p>
                    </details>
                    <div className="advisor-visible-hands">
                        {[
                            { seat: input.contract.declarer, hand: observation.declarerHand, role: "Declarer" },
                            { seat: observation.dummy, hand: observation.dummyHand, role: "Dummy" },
                        ].map(({ seat, hand, role }) => (
                            <section key={seat} className={`play-hand ${seat === observation.playerToMove ? "is-active" : ""}`} aria-label={`${seat} ${role} hand`}>
                                <h3>{seat} <span>{role}</span></h3>
                                {SUITS.map((suit) => (
                                    <div key={suit} className="advisor-suit-row"><span>{suit}</span>
                                        {[...RANKS].reverse().filter((rank) => hand[suit].includes(rank)).map((rank) => {
                                            const card = { suit, rank };
                                            const key = cardKey(card);
                                            return <button type="button" key={key} className={`advisor-card ${seat === observation.playerToMove && recommended.has(key) ? "is-recommended" : ""}`}
                                                disabled={seat !== observation.playerToMove || !playableKeys.has(key)}
                                                aria-label={`Play ${formatCard(card)} from ${seat}`} onClick={() => play(card)}>{formatCard(card)}</button>;
                                        })}
                                        {hand[suit].length === 0 && <span className="advisor-void">-</span>}
                                    </div>
                                ))}
                            </section>
                        ))}
                    </div>
                    <div className="advisor-public-trick" aria-live="polite">
                        <strong>{observation.currentTrick.length > 0 ? "Current trick" : "Last trick"}:</strong>{" "}
                        {(observation.currentTrick.length > 0 ? observation.currentTrick : observation.lastTrick).map(formatPlayedCard).join(" | ") || "Awaiting the opening lead"}
                    </div>
                    <section className="advisor-play-history" aria-labelledby="advisor-history-title">
                        <div className="advisor-play-history-heading">
                            <h3 id="advisor-history-title">Public play history</h3>
                            <p>{history.length}/52 cards · {observation.declarerTricksWon} declarer tricks · {observation.defenderTricksWon} defender tricks</p>
                        </div>
                        {trickHistory.length === 0
                            ? <p className="advisor-play-history-empty">No cards have been recorded yet.</p>
                            : <ol className="advisor-history-tricks">
                                {trickHistory.map(({ number, plays, winner }) => (
                                    <li key={number} className={`advisor-history-trick ${winner === null ? "is-in-progress" : ""}`}>
                                        <div className="advisor-history-trick-heading">
                                            <strong>Trick {number}</strong>
                                            <span>{winner === null ? `In progress · ${plays.length}/4 cards` : `Taken by ${winner}`}</span>
                                        </div>
                                        <ol className="advisor-history-cards">
                                            {plays.map((entry, index) => (
                                                <li key={`${entry.player}:${cardKey(entry.card)}`}
                                                    className={`advisor-history-card ${index === 0 ? "is-lead" : ""}`}>
                                                    <span className="advisor-history-card-player">{entry.player}</span>
                                                    <strong className="advisor-history-card-value">{formatCard(entry.card)}</strong>
                                                    <span className="advisor-history-card-order">{index === 0 ? "Lead" : `Play ${index + 1}`}</span>
                                                </li>
                                            ))}
                                        </ol>
                                    </li>
                                ))}
                            </ol>}
                    </section>
                    {!controlled && !observation.isComplete && validationHybridActive && (
                        <p className="advisor-help" role="status">
                            Full-information DDS is choosing {observation.playerToMove}'s defensive card. The advisor will receive only the resulting public play.
                        </p>
                    )}
                    {!controlled && !observation.isComplete && !validationHybridActive && (
                        <section className="play-hand advisor-observed-hand is-active"
                            aria-label={`Record ${observation.playerToMove}'s observed ${history.length === 0 ? "opening lead" : "card"}`}>
                            <h3>Record {observation.playerToMove}'s observed {history.length === 0 ? "opening lead" : "card"}
                                <span>{observation.playerToMove} · Defender</span></h3>
                            <p className="advisor-help">
                                Click the card {observation.playerToMove} actually played. Only unseen cards that could still belong to this defender are shown. Follow-suit is not filtered because the hidden hand is unknown; suits this defender has already shown void in are excluded.
                            </p>
                            {SUITS.map((suit) => {
                                const suitCards = playable.filter((card) => card.suit === suit);
                                return (
                                    <div key={suit} className="advisor-suit-row"><span>{suit}</span>
                                        {suitCards.map((card) => (
                                            <button type="button" key={cardKey(card)} className="advisor-card"
                                                aria-label={`Record ${formatCard(card)} played by ${observation.playerToMove}`}
                                                onClick={() => play(card)}>{formatCard(card)}</button>
                                        ))}
                                        {suitCards.length === 0 && <span className="advisor-void">-</span>}
                                    </div>
                                );
                            })}
                        </section>
                    )}
                    {controlled && !observation.isComplete && (
                        <section className="advisor-analysis" aria-labelledby="advisor-analysis-title">
                            <h3 id="advisor-analysis-title">DD-based make estimates</h3>
                            <p className="advisor-help">{beliefMode === "uniform" ?
                                "Belief model: uniform hard constraints. Auction context is not used." :
                                "Belief model: learned joint hidden-card allocations. Missing assets or context cause an explicit error, never a silent uniform fallback."}{" "}
                                Feature downloads contain only visible hands and public information.</p>
                            <div className="advisor-fields">
                                <label htmlFor="advisor-belief-model">Belief model
                                    <select id="advisor-belief-model" value={beliefMode} onChange={(event) => {
                                        if (event.target.value === "uniform" || event.target.value === "learned") {
                                            setBeliefMode(event.target.value); setPaused(false);
                                        }
                                    }}>
                                        <option value="uniform">Uniform hard constraints</option>
                                        <option value="learned">Learned mixed-system model</option>
                                    </select>
                                </label>
                                {beliefMode === "learned" && <label htmlFor="advisor-model-url">Model manifest URL (same origin)
                                    <input id="advisor-model-url" value={modelUrl} onChange={(event) => {
                                        setModelUrl(event.target.value); setPaused(false);
                                    }} />
                                </label>}
                                <label htmlFor="advisor-samples">Samples
                                    <select id="advisor-samples" value={samples} onChange={(event) => { setSamples(Number(event.target.value)); setPaused(false); }}>
                                        <option value={200}>200</option><option value={500}>500</option>
                                    </select>
                                </label>
                                <label htmlFor="advisor-seed">Random seed
                                    <input id="advisor-seed" inputMode="numeric" value={seed} onChange={(event) => { setSeed(event.target.value); setPaused(false); }} />
                                </label>
                                <div className="play-controls">
                                    {currentView?.pending && <button type="button" onClick={() => setPaused(true)}>Pause analysis</button>}
                                    {(paused || currentView?.error !== undefined) && <button type="button" onClick={() => { setPaused(false); setRetry(retry + 1); }}>Resume analysis</button>}
                                    <button type="button" disabled={top === undefined} onClick={() => { if (top !== undefined) play(top.card); }}>Play current recommendation</button>
                                </div>
                            </div>
                            {currentView?.error !== undefined && <p className="advisor-error" role="alert">{currentView.error}</p>}
                            <p role="status">{paused ? "Analysis paused." : currentView?.error !== undefined ? "Analysis failed." : currentView?.pending ? beliefMode === "learned" ? "Loading model / analyzing weighted deals..." : "Analyzing compatible deals..." : advice?.complete ? "Analysis complete." : "Preparing analysis..."}{" "}
                                {advice !== undefined
                                    ? `${advice.samples}/${advice.requestedSamples} samples in ${(advice.elapsedMilliseconds / 1000).toFixed(2)}s.`
                                    : currentView?.pending
                                        ? `0/${samples} DDS samples complete; ${beliefMode === "learned" ? "model loading and deal weighting" : "deal preparation"} happens first.`
                                        : ""}
                            </p>
                            {currentView?.pending && <p className="advisor-help">
                                Playing a card now cancels this position's unfinished estimate. Wait for the sample count to reach {samples}/{samples} to see its recommendation.
                            </p>}
                            <progress max={samples} value={advice?.samples ?? 0} aria-label="Completed Monte Carlo samples" />
                            {advice?.model === "learned-joint" && <p className="advisor-help">
                                Model: {advice.modelId} v{advice.modelVersion}. Effective sample size: {advice.effectiveSampleSize?.toFixed(1)} / {advice.samples}.
                                {" "}{advice.modelNotice}
                            </p>}
                            {advice?.warning !== undefined && <p role="alert" className="advisor-error">{advice.warning}</p>}
                            {advice !== undefined && (
                                <div className="advisor-table-scroll">
                                    <table className="advisor-results">
                                        <caption>All legal cards on the same sampled deals; make probability first, expected tricks second.</caption>
                                        <thead><tr><th>Card</th><th>Make estimate</th><th>Expected tricks</th><th>{beliefMode === "learned" ? "Approx. 95% weighted interval" : "95% sampling interval"}</th></tr></thead>
                                        <tbody>{advice.candidates.map((candidate) => (
                                            <tr key={cardKey(candidate.card)} className={recommended.has(cardKey(candidate.card)) ? "is-recommended" : ""}>
                                                <td><button type="button" className="quiet-button" aria-label={`Play evaluated ${formatCard(candidate.card)}`} onClick={() => play(candidate.card)}>{formatCard(candidate.card)}</button></td>
                                                <td>{percent(candidate.makeProbability)}</td><td>{candidate.expectedTricks.toFixed(2)}</td>
                                                <td>{percent(candidate.samplingInterval[0])} - {percent(candidate.samplingInterval[1])}</td>
                                            </tr>
                                        ))}</tbody>
                                    </table>
                                </div>
                            )}
                            <p className="advisor-help">Intervals measure Monte Carlo sampling uncertainty only. Learned intervals use importance-sampling variance, not Wilson intervals; [0%, 100%] is shown when ESS or variation is insufficient. They do not cover incorrect beliefs, unmodeled signals, or the advantage of seeing all cards during DDS continuation. Playing during analysis cancels the estimate for this position; another estimate starts only if declarer or dummy is next.</p>
                        </section>
                    )}
                    <div className="advisor-public-facts">
                        {DIRECTIONS.filter((seat) => !isDeclarerSide(seat, input.contract)).map((seat) => (
                            <p key={seat}><strong>{seat}:</strong> {observation.remainingCounts[seat]} cards remaining; shown voids: {observation.voids[seat].join(", ") || "none"}</p>
                        ))}
                    </div>
                </div>
            )}
        </section>
    );
};

export default AdvisorBoard;
