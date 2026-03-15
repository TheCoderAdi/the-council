import { BaseAgent } from "./baseAgent.js";
import { AgentName } from "../models/debate.js";
import { MERCURY_SYSTEM_PROMPT } from "../prompts/agentPrompts.js";

export class MercuryAgent extends BaseAgent {
    constructor(mcpClient) {
        super({
            name: AgentName.MERCURY,
            systemPrompt: MERCURY_SYSTEM_PROMPT,
            mcpClient,
        });
    }
}