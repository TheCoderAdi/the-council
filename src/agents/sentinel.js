import { BaseAgent } from "./baseAgent.js";
import { AgentName } from "../models/debate.js";
import { SENTINEL_SYSTEM_PROMPT } from "../prompts/agentPrompts.js";

export class SentinelAgent extends BaseAgent {
    constructor(mcpClient) {
        super({
            name: AgentName.SENTINEL,
            systemPrompt: SENTINEL_SYSTEM_PROMPT,
            mcpClient,
        });
    }
}