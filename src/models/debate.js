// Enums

export const AgentName = Object.freeze({
    SENTINEL: "SENTINEL",
    MERCURY: "MERCURY",
    MIDAS: "MIDAS",
    ATLAS: "ATLAS",
});

export const DebateStatus = Object.freeze({
    PENDING: "pending",
    ASSEMBLING: "assembling",
    DEBATING: "debating",
    CONSENSUS: "consensus",
    DEADLOCKED: "deadlocked",
    AWAITING_VOTE: "awaiting_vote",
    COMPLETED: "completed",
});

export const EventType = Object.freeze({
    STATUS: "status",
    ROUND_START: "round_start",
    ARGUMENT: "argument",
    CONSENSUS: "consensus",
    DEADLOCK: "deadlock",
    COMPLETE: "complete",
    ERROR: "error",
});

// Factories

export const createArgument = ({
    agent,
    content,
    roundNumber,
}) => ({
    agent,
    content,
    roundNumber,
    timestamp: new Date().toISOString(),
});

export const createDebateState = ({
    question,
    notionPageId,
    maxRounds = 3,
}) => ({
    question,
    notionPageId,
    round: 0,
    maxRounds,
    arguments: [],
    consensus: null,
    deadlocked: false,
    actionItems: [],
    status: DebateStatus.PENDING,
    createdAt: new Date().toISOString(),
});

export const createStreamEvent = ({ type, data }) => ({
    type,
    data,
    timestamp: new Date().toISOString(),
});
