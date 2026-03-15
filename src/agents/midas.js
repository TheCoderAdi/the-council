import { BaseAgent } from "./baseAgent.js";
import { AgentName } from "../models/debate.js";
import { MIDAS_SYSTEM_PROMPT } from "../prompts/agentPrompts.js";

export class MidasAgent extends BaseAgent {
    constructor(mcpClient) {
        super({
            name: AgentName.MIDAS,
            systemPrompt: MIDAS_SYSTEM_PROMPT,
            mcpClient,
        });
    }
}