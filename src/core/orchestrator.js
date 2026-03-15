import { generate } from "./llmClient.js";
import dotenv from "dotenv";
import { logger } from "../utils/logger.js";

import { SentinelAgent } from "../agents/sentinel.js";
import { MercuryAgent } from "../agents/mercury.js";
import { MidasAgent } from "../agents/midas.js";
import { AtlasAgent } from "../agents/atlas.js";
import { NotionMCPClient } from "./mcpClient.js";
import { NotionFormatter } from "./notionFormatter.js";

import {
    createDebateState,
    createStreamEvent,
    DebateStatus,
    EventType,
} from "../models/debate.js";

import { CONSENSUS_PROMPT } from "../prompts/agentPrompts.js";

dotenv.config();

const ARBITER_MODEL = process.env.GEMINI_MODEL || "gemini-2.0-flash";

export class CouncilOrchestrator {
    /**
     * Runs the full debate as an async generator.
     * Yields StreamEvents so the API streams them live.
     * All Notion interactions go through MCP.
     * API never blocks.
     */

    async *runDebateStream(pageId, question, rounds) {
        // Full debate loop as async generator.

        // Connect to Notion MCP
        const mcp = new NotionMCPClient();

        try {
            await mcp.connect();
        } catch (err) {
            yield createStreamEvent({
                type: EventType.ERROR,
                data: { message: `MCP connection failed: ${err.message}` },
            });
            return;
        }

        // Inject MCP into all agents
        const agents = [
            new SentinelAgent(mcp),
            new MercuryAgent(mcp),
            new MidasAgent(mcp),
            new AtlasAgent(mcp),
        ];

        const resolvedRounds = (typeof rounds !== "undefined" && rounds !== null)
            ? parseInt(rounds, 10)
            : parseInt(process.env.DEBATE_MAX_ROUNDS || "3", 10);

        const maxRounds = Number.isFinite(resolvedRounds) && resolvedRounds > 0 ? resolvedRounds : 3;

        const state = createDebateState({
            question,
            notionPageId: pageId,
            maxRounds,
        });

        try {
            // Assembling
            yield createStreamEvent({
                type: EventType.STATUS,
                data: {
                    message: "🏛️ The Council is assembling...",
                    mcpTools: mcp.getAvailableTools(),
                },
            });

            await this.#safeNotionCall(() =>
                mcp.updatePageFormatted(pageId, {
                    Status: "assembling",
                })
            );

            await this.#writeHeaderBlock(mcp, pageId, question);
            await this.#sleep(500);
            // Also surface action items into page properties so they appear in DB views.
            // Strategy:
            // 1) Mirror the action items into the `Debate` rich_text property (fallback)
            // 2) If the database exposes per-item properties like `Action Item 1`, `Action 1`,
            //    write each item into that property (rich_text) and set any matching
            //    `Action Item N Done` / `Action N Done` checkbox properties to false.
            // Debating
            yield createStreamEvent({
                type: EventType.STATUS,
                data: { message: "⚔️ The debate has begun!" },
            });

            await this.#safeNotionCall(() =>
                mcp.updatePageFormatted(pageId, {
                    Status: "debating",
                })
            );
            // Inspect DB properties to populate per-item properties if available
            try {
                const dbProps = await mcp.getDatabaseProperties();
                const updates = {};

                for (let i = 0; i < items.length; i++) {
                    const n = i + 1;
                    const tryNames = [
                        `Action Item ${n}`,
                        `Action ${n}`,
                        `ActionItem${n}`,
                        `Action${n}`,
                    ];

                    const propName = tryNames.find((name) => Object.prototype.hasOwnProperty.call(dbProps, name));
                    if (propName) {
                        const pType = dbProps[propName].type;
                        // If the property is a rich_text or title, write the item text.
                        if (pType === "rich_text" || pType === "title") {
                            updates[propName] = items[i];
                        } else if (pType === "checkbox") {
                            // Checkbox can't store text; mark it unchecked to indicate pending
                            updates[propName] = false;
                        } else {
                            updates[propName] = items[i];
                        }
                    }

                    const doneNames = [
                        `Action Item ${n} Done`,
                        `Action ${n} Done`,
                        `ActionItem${n}Done`,
                        `Action${n}Done`,
                    ];

                    const doneProp = doneNames.find((name) => Object.prototype.hasOwnProperty.call(dbProps, name));
                    if (doneProp) {
                        updates[doneProp] = false;
                    }
                }

                if (Object.keys(updates).length > 0) {
                    await this.#safeNotionCall(() => mcp.updatePageFormatted(pageId, updates));
                    logger.info(`Wrote action items into page properties: ${Object.keys(updates).join(", ")}`);
                }
            } catch (err) {
                logger.warn(`Failed to mirror action items into per-item properties: ${err?.message || err}`);
            }

            // Rounds
            for (let round = 1; round <= state.maxRounds; round++) {
                yield createStreamEvent({
                    type: EventType.ROUND_START,
                    data: { round, of: state.maxRounds },
                });

                await this.#safeNotionCall(() =>
                    this.#writeRoundHeader(mcp, pageId, round, state.maxRounds)
                );

                // All agents argue in parallel
                const agentTasks = agents.map((agent) =>
                    agent.argue({
                        question,
                        roundNumber: round,
                        previousArguments: state.arguments,
                        pageId,
                    })
                );

                // Stream each result as it completes
                const results = await Promise.allSettled(agentTasks);

                for (const result of results) {
                    if (result.status === "fulfilled") {
                        const argument = result.value;
                        state.arguments.push(argument);

                        yield createStreamEvent({
                            type: EventType.ARGUMENT,
                            data: {
                                agent: argument.agent,
                                round,
                                content: argument.content,
                                writtenToNotion: true,
                            },
                        });

                    } else {
                        logger.error(
                            `Agent task failed: ${result.reason}`
                        );

                        yield createStreamEvent({
                            type: EventType.ERROR,
                            data: {
                                message: `Agent error: ${result.reason}`,
                            },
                        });
                    }
                }

                // Divider between rounds
                await this.#safeNotionCall(() =>
                    mcp.appendBlocks(pageId, [
                        { object: "block", type: "divider", divider: {} },
                    ])
                );

                await this.#sleep(300);
            }

            // Consensus Check
            yield createStreamEvent({
                type: EventType.STATUS,
                data: { message: "🔍 Arbiter is evaluating..." },
            });

            const consensus = await this.#checkConsensus(state);

            // Consensus Reached
            if (consensus?.hasConsensus) {
                state.status = DebateStatus.CONSENSUS;
                state.consensus = consensus.decision;
                state.actionItems = consensus.actionItems;

                await this.#safeNotionCall(() =>
                    this.#writeConsensus(mcp, pageId, consensus)
                );

                await this.#safeNotionCall(() =>
                    mcp.updatePageFormatted(pageId, {
                        Status: "completed",
                        Decision: consensus.decision,
                    })
                );

                // Also surface action items into the page property so they appear in DB views
                try {
                    const items = (consensus.actionItems || []).filter(Boolean);
                    if (items.length > 0) {
                        const debateText = `Action Items:\n${items.map((it, i) => `• ${it}`).join("\n")}`;
                        await this.#safeNotionCall(() =>
                            mcp.updatePageFormatted(pageId, {
                                Debate: debateText,
                            })
                        );
                        logger.info(`Wrote ${items.length} action items to page property 'Debate'`);
                    }
                } catch (err) {
                    logger.warn(`Failed to write action items to page property: ${err?.message || err}`);
                }

                yield createStreamEvent({
                    type: EventType.CONSENSUS,
                    data: {
                        decision: consensus.decision,
                        reasoning: consensus.reasoning,
                        winningPerspective: consensus.winningPerspective,
                        provider: consensus.provider || null,
                        actionItems: consensus.actionItems,
                        rejectedArguments: consensus.rejectedArguments,
                    },
                });

                yield createStreamEvent({
                    type: EventType.COMPLETE,
                    data: {
                        status: "success",
                        message: "✅ The Council has spoken!",
                        summary: {
                            question: question,
                            rounds: state.maxRounds,
                            totalArguments: state.arguments.length,
                            decision: consensus.decision,
                            actionItems: consensus.actionItems,
                        },
                    },
                });

                // Deadlocked
            } else {
                state.status = DebateStatus.DEADLOCKED;
                state.deadlocked = true;

                await this.#safeNotionCall(() =>
                    this.#writeDeadlock(mcp, pageId)
                );

                await this.#safeNotionCall(() =>
                    mcp.updatePageFormatted(pageId, {
                        Status: "deadlocked",
                    })
                );

                yield createStreamEvent({
                    type: EventType.DEADLOCK,
                    data: {
                        message: "🔒 The Council is deadlocked!",
                        instruction:
                            "Open Notion and cast your vote using the Vote property",
                    },
                });
            }

            logger.info(
                `🏛️ Debate complete | ${question.slice(0, 40)}... | ${state.status}`
            );

        } finally {
            await mcp.disconnect();
        }
    }

    // Notion Block Writers

    async #writeHeaderBlock(mcp, pageId, question) {
        const blocks = NotionFormatter.debateHeader(question || "");
        await mcp.appendBlocks(pageId, blocks);
    }

    async #writeRoundHeader(mcp, pageId, roundNumber, totalRounds) {
        const blocks = NotionFormatter.roundHeader(roundNumber, totalRounds || undefined);
        await mcp.appendBlocks(pageId, blocks);
    }

    async #writeConsensus(mcp, pageId, consensus) {
        const blocks = NotionFormatter.consensusSection({
            decision: consensus.decision,
            reasoning: consensus.reasoning,
            winningPerspective: consensus.winningPerspective,
            actionItems: consensus.actionItems,
            rejectedArguments: consensus.rejectedArguments,
        });

        await mcp.appendBlocks(pageId, blocks);
    }

    async #writeDeadlock(mcp, pageId) {
        const blocks = NotionFormatter.deadlockSection();
        await mcp.appendBlocks(pageId, blocks);
    }

    // Consensus Logic

    async #checkConsensus(state, retries = 3) {
        // Gemini arbiter reviews all arguments and decides

        const allArgs = state.arguments
            .map(
                (arg) =>
                    `\n${arg.agent} [Round ${arg.roundNumber}]:\n${arg.content}\n---`
            )
            .join("\n");

        const prompt = CONSENSUS_PROMPT
            .replace("{question}", state.question)
            .replace("{allArguments}", allArgs);

        for (let attempt = 1; attempt <= retries; attempt++) {
            try {
                const out = await generate(prompt, { model: ARBITER_MODEL });
                const providerUsed = out?.provider || null;
                let text = (out && out.text) ? String(out.text).trim() : "";

                if (text.includes("```")) {
                    const parts = text.split("```");
                    text = parts[1] || parts[0];
                    if (text.startsWith("json")) {
                        text = text.slice(4).trim();
                    }
                }

                const parsed = JSON.parse(text);
                // Attach provider metadata so callers know which LLM produced the result
                return { ...parsed, provider: providerUsed };

            } catch (err) {
                logger.warn(`Consensus attempt ${attempt}/${retries} failed: ${err.message}`);

                if (attempt === retries) {
                    logger.error("All consensus attempts failed");
                    return {
                        hasConsensus: false,
                        decision: null,
                        reasoning: "Arbiter failed to evaluate",
                        winningPerspective: null,
                        actionItems: [],
                        rejectedArguments: "",
                        provider: null,
                    };
                }

                await this.#sleep(2000 * attempt);
            }
        }
    }

    // Utilities

    async #safeNotionCall(fn) {
        try {
            await fn();
        } catch (err) {
            logger.warn(`⚠️ Non-fatal Notion call failed: ${err.message}`);
        }
    }

    #sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
}