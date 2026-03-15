import { BaseAgent } from "./baseAgent.js";
import { AgentName } from "../models/debate.js";
import { ATLAS_SYSTEM_PROMPT } from "../prompts/agentPrompts.js";

export class AtlasAgent extends BaseAgent {
    constructor(mcpClient) {
        super({
            name: AgentName.ATLAS,
            systemPrompt: ATLAS_SYSTEM_PROMPT,
            mcpClient,
        });
    }
}