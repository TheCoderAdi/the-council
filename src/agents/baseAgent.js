import dotenv from "dotenv";
import { logger } from "../utils/logger.js";
import { generate } from "../core/llmClient.js";
import { createArgument } from "../models/debate.js";
import { NotionFormatter } from "../core/notionFormatter.js";

dotenv.config();

export class BaseAgent {
    /**
     * Each agent:
     * 1. Reads Notion page via MCP for context
     * 2. Generates argument using Gemini / Groq
     * 3. Writes argument back to Notion via MCP
     *
     * MCP is the bridge between the AI and Notion.
     */

    constructor({ name, systemPrompt, mcpClient }) {
        this.name = name;
        this.mcpClient = mcpClient;
        this.systemInstruction = systemPrompt;
        this.defaultModel = process.env.GEMINI_MODEL || process.env.GROQ_MODEL;
    }

    // Main Argue Method

    async argue({
        question,
        roundNumber,
        previousArguments,
        pageId,
    }) {
        /**
         * Full cycle:
         * READ Notion → THINK with Gemini → WRITE to Notion
         */

        // 1. Read page context via MCP
        let pageContext = "";
        try {
            const content = await this.mcpClient.getPageContent(pageId);
            if (content) {
                pageContext = `\nPage context from Notion:\n${content}\n`;
            }
        } catch (err) {
            logger.warn(
                `${this.name} could not read Notion page: ${err.message}`
            );
        }

        // 2. Build prompt
        const prevText = this.#buildContext(previousArguments);

        const prompt = `
                Question being debated: "${question}"
                Round: ${roundNumber}

                ${pageContext}

                Previous council arguments:
                ${prevText}

                Make your argument for Round ${roundNumber}.
                ${roundNumber === 1
                ? "This is Round 1 — make your strongest opening argument."
                : "Directly counter the weakest opposing argument above."
            }
        `;

        // 3. Generate with Gemini
        let argument;

        try {
            const out = await generate(prompt, {
                model: this.defaultModel,
                systemInstruction: this.systemInstruction,
            });

            const text = (out && out.text) ? String(out.text).trim() : "";

            argument = createArgument({
                agent: this.name,
                content: text,
                roundNumber,
            });

            logger.info(`💬 ${this.name} argued [Round ${roundNumber}] (provider=${out.provider})`);

        } catch (err) {
            logger.error(`❌ ${this.name} LLM failed: ${err.message}`);

            // Fallback deterministic stance so debate continues
            const lowLevel = String(err.message || "").toLowerCase();
            const roleStances = {
                SENTINEL: `Prioritize security and robustness. In my view, the safest option is to favor secure defaults and minimize attack surface for long-term reliability.`,
                MERCURY: `Prioritize speed and user experience. The fastest solution that delivers value earlier is preferred to iterate and learn quickly.`,
                MIDAS: `Prioritize cost-effectiveness. Choose the approach that minimizes ongoing costs while meeting requirements.`,
                ATLAS: `Prioritize scalability and maintainability. Opt for solutions that scale gracefully as usage grows.`,
            };

            let fallback = roleStances[this.name] || `${this.name} default stance.`;

            if (lowLevel.includes("quota") || lowLevel.includes("429") || lowLevel.includes("rate limit")) {
                fallback = `${fallback} (Note: model unavailable due to quota; this is a fallback opinion.)`;
            }

            const content = `Fallback argument — ${this.name} [Round ${roundNumber}]:\n${fallback}`;

            argument = createArgument({ agent: this.name, content, roundNumber });
        }

        // 4. Write to Notion via MCP
        await this.#writeToNotion(pageId, argument);

        return argument;
    }

    async #writeToNotion(pageId, argument) {
        /** Agent writes its own argument to Notion via MCP */
        try {
            const blocks = NotionFormatter.agentArgument(
                argument.agent,
                argument.content,
                argument.roundNumber
            );

            await this.mcpClient.appendBlocks(pageId, blocks);

            logger.info(
                `✅ ${this.name} wrote to Notion via MCP`
            );

            // Also update the Debate property so the DB table shows the latest content
            try {
                const page = await this.mcpClient.getPage(pageId);
                const existing = (page?.properties?.Debate?.rich_text?.[0]?.plain_text)
                    || (page?.properties?.Debate?.title?.[0]?.plain_text)
                    || "";

                const newDebate = [existing, argument.content].filter(Boolean).join("\n\n");

                await this.mcpClient.updatePageFormatted(pageId, {
                    Debate: newDebate,
                });
            } catch (err) {
                logger.warn(`${this.name} failed to update Debate property: ${err.message}`);
            }

        } catch (err) {
            logger.warn(
                `${this.name} Notion write failed: ${err.message}`
            );
        }
    }

    #buildContext(previousArguments) {
        /** Format previous arguments for prompt context */
        if (!previousArguments || previousArguments.length === 0) {
            return "No previous arguments. This is Round 1.";
        }

        return previousArguments
            .map(
                (arg) =>
                    `\n${arg.agent} [Round ${arg.roundNumber}]:\n${arg.content}\n---`
            )
            .join("\n");
    }
}