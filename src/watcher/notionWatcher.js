import { NotionMCPClient } from "../core/mcpClient.js";
import { CouncilOrchestrator } from "../core/orchestrator.js";
import { logger } from "../utils/logger.js";
import dotenv from "dotenv";

dotenv.config();

export class NotionWatcher {
    /**
     * Polls Notion database via MCP for new debates.
     * Spawns each debate as a background task.
     */

    constructor() {
        this.orchestrator = new CouncilOrchestrator();
        this.pollInterval = parseInt(
            process.env.POLL_INTERVAL_SECONDS || "10"
        ) * 1000;
        this.processing = new Set();
        this.consecutiveErrors = 0;
        this.maxErrors = 5;
        this.running = false;
    }

    async start() {
        // Start polling loop
        this.running = true;
        logger.info("👁️  Notion Watcher started");
        logger.info(`⏱️  Polling every ${this.pollInterval / 1000}s`);

        while (this.running) {
            try {
                await this.#checkForDebates();
                this.consecutiveErrors = 0;

            } catch (err) {
                this.consecutiveErrors++;
                logger.error(
                    `Watcher error [${this.consecutiveErrors}/${this.maxErrors}]: ${err.message}`
                );

                if (this.consecutiveErrors >= this.maxErrors) {
                    const backoff = Math.min(
                        (this.pollInterval / 1000) * this.consecutiveErrors,
                        120
                    ) * 1000;

                    logger.warn(`Backing off ${backoff / 1000}s`);
                    await this.#sleep(backoff);
                    this.consecutiveErrors = 0;
                    continue;
                }
            }

            await this.#sleep(this.pollInterval);
        }
    }

    stop() {
        this.running = false;
        logger.info("👁️  Watcher stopped");
    }

    async #checkForDebates() {
        // Open MCP connection, check for pending pages
        const mcp = new NotionMCPClient();

        try {
            await mcp.connect();

            const pages = await mcp.queryDatabase();
            const deadlockedCandidates = pages || [];
            const deadlockedPages = (deadlockedCandidates || []).filter((p) => {
                try {
                    const status = (mcp.getStatus(p) || "").toLowerCase();
                    return status === "deadlocked" || status === "awaiting_vote";
                } catch {
                    return false;
                }
            });

            const pendingPages = (pages || []).filter((p) => {
                try {
                    const status = (mcp.getStatus(p) || "").toLowerCase();
                    return status === "pending";
                } catch {
                    return false;
                }
            });

            if (pendingPages.length > 0) {
                logger.info(`📋 Found ${pendingPages.length} pending debates (filtered locally)`);
            } else {
                logger.debug(`📋 No pending debates found (checked ${pages?.length || 0} pages)`);
            }

            for (const page of pendingPages) {
                const pageId = page.id;


                if (this.processing.has(pageId)) {
                    logger.debug(`Skipping ${pageId} — already processing`);
                    continue;
                }

                const question = mcp.getTitle(page) || "";

                if (!question?.trim()) {
                    logger.warn(`Skipping ${pageId} — empty or missing title/question`);
                    continue;
                }

                logger.info(`🔔 New debate: ${question.slice(0, 50)}...`);

                // Mark as processing early to avoid races with the watcher loop
                this.processing.add(pageId);

                // Spawn as background — never blocks watcher
                this.#runDebateBackground(pageId, question);
            }

            // Process deadlocked pages: if a Vote select is present, finalize the debate
            for (const page of deadlockedPages) {
                const pageId = page.id;

                // Skip if another process is currently handling this page
                if (this.processing.has(pageId)) {
                    logger.debug(`Skipping deadlocked ${pageId} — already processing`);
                    continue;
                }

                // Try to read Vote property (select name)
                const vote = page?.properties?.Vote?.select?.name || null;
                if (!vote) {
                    continue; // no vote yet
                }

                logger.info(`🗳️ Deadlocked page ${pageId.slice(0, 8)} has vote: ${vote} — auto-completing`);

                this.processing.add(pageId);

                // Finalize: append a small block and mark Status=completed and Decision=vote
                (async () => {
                    try {
                        // Append a concluding block noting the chosen vote
                        await mcp.appendBlocks(pageId, [
                            {
                                object: "block",
                                type: "callout",
                                callout: {
                                    rich_text: [
                                        {
                                            type: "text",
                                            text: { content: `Final vote: ${vote} — debate closed by watcher.` },
                                        },
                                    ],
                                    icon: { emoji: "🗳️" },
                                    color: "blue_background",
                                },
                            },
                        ]);

                        await mcp.updatePageFormatted(pageId, {
                            Vote: vote,
                            Status: "completed",
                            Decision: vote,
                        });

                        logger.info(`Auto-completed debate ${pageId.slice(0, 8)} with vote ${vote}`);
                    } catch (err) {
                        logger.error(`Failed to auto-complete vote for ${pageId.slice(0, 8)}: ${err.message}`);
                    } finally {
                        this.processing.delete(pageId);
                    }
                })();
            }

        } finally {
            await mcp.disconnect();
        }
    }

    async #runDebateBackground(pageId, question) {
        /** Run debate and always cleanup */
        try {
            for await (const event of this.orchestrator.runDebateStream(
                pageId,
                question
            )) {
                logger.debug(
                    `[${pageId.slice(0, 8)}] ${event.type}`
                );
            }
        } catch (err) {
            logger.error(
                `Debate failed [${pageId.slice(0, 8)}]: ${err.message}`
            );
        } finally {
            this.processing.delete(pageId);
            logger.info(
                `Debate finished [${pageId.slice(0, 8)}]`
            );
        }
    }

    #sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
}