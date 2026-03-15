import express from "express";
import cors from "cors";
import { v4 as uuidv4 } from "uuid";
import dotenv from "dotenv";

import { logger } from "../src/utils/logger.js";
import { NotionWatcher } from "../src/watcher/notionWatcher.js";
import { CouncilOrchestrator } from "../src/core/orchestrator.js";
import { NotionMCPClient } from "../src/core/mcpClient.js";
import { AgentName } from "../src/models/debate.js";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

// Utility: extract a Notion page id from a URL or return input if already an id
function extractNotionPageId(input) {
    if (!input) return "";
    // try URL
    try {
        const url = new URL(input);
        const path = url.pathname;
        const last = path.split("/").filter(Boolean).pop() || path;
        const m = last.match(/[0-9a-fA-F]{32}|[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}/);
        if (m) return m[0];
    } catch (e) {
        // not a URL, fall back
    }

    const m2 = String(input).match(/[0-9a-fA-F]{32}|[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}/);
    return m2 ? m2[0] : String(input);
}

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Global State
const watcher = new NotionWatcher();
const orchestrator = new CouncilOrchestrator();
const activeDebates = new Map();

// Start Watcher
watcher.start().catch((err) => {
    logger.error(`Watcher crashed: ${err.message}`);
});

// Serve frontend
app.use(express.static(path.join(__dirname, "../public")));

// Routes
app.get("/", (req, res) => {
    res.json({
        name: "The Council",
        status: "active",
        activeDebates: activeDebates.size,
        message: "🏛️ Multi-Agent Debate Arena is running",
    });
});

app.get("/health", (req, res) => {
    res.json({
        status: "healthy",
        activeDebates: activeDebates.size,
        uptime: process.uptime(),
    });
});

// Show MCP tools
app.get("/mcp/tools", async (req, res) => {
    const mcp = new NotionMCPClient();
    try {
        await mcp.connect();
        const tools = mcp.getAvailableTools();
        res.json({ count: tools.length, tools });
    } catch (err) {
        res.status(500).json({ error: err.message });
    } finally {
        await mcp.disconnect();
    }
});

// Diagnostic: return raw tool metadata from MCP (helps debug expected args/schema)
app.get("/mcp/tool/:name", async (req, res) => {
    const { name } = req.params;
    const mcp = new NotionMCPClient();
    try {
        await mcp.connect();
        const tool = mcp.toolMap[name] || null;
        res.json({ tool });
    } catch (err) {
        res.status(500).json({ error: err.message });
    } finally {
        await mcp.disconnect();
    }
});

// List debates from Notion database (returns simple view)
app.get("/debates", async (req, res) => {
    const mcp = new NotionMCPClient();
    try {
        await mcp.connect();
        const pages = await mcp.queryDatabase();
        const simplified = (pages || []).map((p) => ({
            id: p.id,
            title: mcp.getTitle(p),
            status: mcp.getStatus(p),
            vote: p?.properties?.Vote?.select?.name || null,
            decision: p?.properties?.Decision?.rich_text?.[0]?.plain_text || p?.properties?.Decision?.rich_text?.[0]?.text?.content || null,
            created_time: p?.created_time || null,
        }));

        res.json({ count: simplified.length, debates: simplified });
    } catch (err) {
        res.status(500).json({ error: err.message });
    } finally {
        await mcp.disconnect();
    }
});

// Create a debate page in the configured database
app.post("/debates/create", async (req, res) => {
    const { question } = req.body;
    if (!question || !String(question).trim()) {
        return res.status(400).json({ error: "question is required" });
    }

    const mcp = new NotionMCPClient();
    try {
        await mcp.connect();

        const props = {
            Question: { title: [{ type: "text", text: { content: String(question) } }] },
            Name: { title: [{ type: "text", text: { content: String(question) } }] },
            Debate: { title: [{ type: "text", text: { content: String(question) } }], rich_text: [{ type: "text", text: { content: String(question) } }] },
            Status: { select: { name: "pending" } },
        };

        const pageArgs = {
            parent: { database_id: mcp.databaseId },
            properties: props,
        };

        // Format properties for the database
        try {
            await mcp.getDatabaseProperties();
            const formatted = mcp.formatPropertiesForDatabase(props);
            pageArgs.properties = formatted;
        } catch (e) {
            // If formatting fails, fall back to raw props
            logger.warn(`Property formatting failed: ${e.message}`);
            pageArgs.properties = props;
        }

        const page = await mcp.callTool("API-post-page", pageArgs);

        res.json({ status: "created", page: page });
    } catch (err) {
        res.status(500).json({ error: err.message });
    } finally {
        await mcp.disconnect();
    }
});

app.get("/debate/stream", async (req, res) => {
    let { page_id, question, rounds } = req.query;

    page_id = extractNotionPageId(String(page_id || ""));

    if (!page_id || !question) {
        return res.status(400).json({
            error: "page_id and question are required",
        });
    }

    const mcpValidator = new NotionMCPClient();
    try {
        await mcpValidator.connect();
        try {
            await mcpValidator.callTool("API-retrieve-a-page", { page_id });
        } catch (err) {
            await mcpValidator.disconnect();
            return res.status(400).json({ error: `Notion integration cannot access page '${page_id}': ${err.message}` });
        }
    } catch (err) {
        return res.status(500).json({ error: `MCP connection failed: ${err.message}` });
    } finally {
        try { await mcpValidator.disconnect(); } catch { };
    }

    const debateId = uuidv4().slice(0, 8);

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    activeDebates.set(debateId, {
        pageId: page_id,
        question,
        status: "running",
    });

    logger.info(
        `Stream [${debateId}] started: ${question.slice(0, 40)}...`
    );

    (async () => {
        const mcpUpdater = new NotionMCPClient();
        try {
            await mcpUpdater.connect();
            await mcpUpdater.updatePageFormatted(page_id, {
                Question: question,
                Debate: question,
            });
            logger.info(`Wrote question to page properties for ${page_id.slice(0, 8)}`);
        } catch (err) {
            logger.warn(`Could not write question to page properties: ${err?.message || err}`);
        } finally {
            try { await mcpUpdater.disconnect(); } catch { }
        }
    })();

    const sendEvent = (eventName, data) => {
        res.write(`event: ${eventName}\n`);
        res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    let clientConnected = true;

    req.on("close", () => {
        clientConnected = false;
        activeDebates.delete(debateId);
        logger.info(`🔌 Client disconnected [${debateId}]`);
    });

    try {
        sendEvent("connected", {
            debateId,
            message: "Connected to The Council 🏛️",
        });

        const parsedRounds = parseInt(String(rounds || ""), 10);
        const safeRounds = Number.isFinite(parsedRounds) && parsedRounds > 0 ? Math.min(parsedRounds, 50) : undefined;

        // Stream debate events
        for await (const event of orchestrator.runDebateStream(
            page_id,
            question,
            safeRounds
        )) {
            // Stop if client disconnected
            if (!clientConnected) break;

            activeDebates.get(debateId) &&
                (activeDebates.get(debateId).status = event.type);

            sendEvent(event.type, {
                ...event.data,
                timestamp: event.timestamp,
            });
        }

    } catch (err) {
        logger.error(`Stream error [${debateId}]: ${err.message}`);

        if (clientConnected) {
            sendEvent("error", {
                message: err.message,
                debateId,
            });
        }

    } finally {
        activeDebates.delete(debateId);
        logger.info(`Stream closed [${debateId}]`);

        if (clientConnected) {
            res.end();
        }
    }
});

// Trigger without streaming
app.post("/debate/trigger", async (req, res) => {
    let { page_id, question, rounds } = req.body;
    page_id = extractNotionPageId(String(page_id || ""));

    if (!page_id || !question) {
        return res.status(400).json({
            error: "page_id and question are required",
        });
    }

    // Validate page access before triggering
    const mcpValidator = new NotionMCPClient();
    try {
        await mcpValidator.connect();
        try {
            await mcpValidator.callTool("API-retrieve-a-page", { page_id });
        } catch (err) {
            await mcpValidator.disconnect();
            return res.status(400).json({ error: `Notion integration cannot access page '${page_id}': ${err.message}` });
        }
    } catch (err) {
        return res.status(500).json({ error: `MCP connection failed: ${err.message}` });
    } finally {
        try { await mcpValidator.disconnect(); } catch { };
    }

    const debateId = uuidv4().slice(0, 8);

    // Run in background
    (async () => {
        try {
            const parsedRounds = parseInt(String(rounds || ""), 10);
            const safeRounds = Number.isFinite(parsedRounds) && parsedRounds > 0 ? Math.min(parsedRounds, 50) : undefined;

            for await (const _ of orchestrator.runDebateStream(
                page_id,
                question,
                safeRounds
            )) {
                // Results go to Notion
            }
        } catch (err) {
            logger.error(`Background debate failed: ${err.message}`);
        }
    })();

    res.json({
        status: "triggered",
        debateId,
        message: "Debate running. Check Notion for live results.",
    });
});

/** Validate a page_id and question without starting the debate stream
 * Returns 200 if the MCP bridge can access the page, otherwise 400 with an error message.
 */
app.get("/debate/validate", async (req, res) => {
    let { page_id, question } = req.query;
    page_id = extractNotionPageId(String(page_id || ""));

    if (!page_id || !question) {
        return res.status(400).json({ error: "page_id and question are required" });
    }

    const mcpValidator = new NotionMCPClient();
    try {
        await mcpValidator.connect();
        try {
            await mcpValidator.callTool("API-retrieve-a-page", { page_id });
            return res.json({ ok: true, page_id });
        } catch (err) {
            return res.status(400).json({ error: `Notion integration cannot access page '${page_id}': ${err.message}` });
        }
    } catch (err) {
        return res.status(500).json({ error: `MCP connection failed: ${err.message}` });
    } finally {
        try { await mcpValidator.disconnect(); } catch { };
    }
});

// Get active debates
app.get("/debates/active", (req, res) => {
    res.json({
        count: activeDebates.size,
        debates: Object.fromEntries(activeDebates),
    });
});

// Cast vote on deadlocked debate
app.post("/debate/vote", async (req, res) => {
    const { page_id, chosen_agent } = req.body;

    if (!page_id || !chosen_agent) {
        return res.status(400).json({
            error: "page_id and chosen_agent are required",
        });
    }

    const normalizedPageId = extractNotionPageId(String(page_id || ""));

    // Quick validation: ensure page exists / is accessible
    const mcpValidator = new NotionMCPClient();
    try {
        await mcpValidator.connect();
        try {
            await mcpValidator.callTool("API-retrieve-a-page", { page_id: normalizedPageId });
        } catch (err) {
            await mcpValidator.disconnect();
            return res.status(400).json({ error: `Notion integration cannot access page '${normalizedPageId}': ${err.message}` });
        }
    } catch (err) {
        return res.status(500).json({ error: `MCP connection failed: ${err.message}` });
    } finally {
        try { await mcpValidator.disconnect(); } catch { };
    }

    if (!Object.values(AgentName).includes(chosen_agent)) {
        return res.status(400).json({
            error: `chosen_agent must be one of: ${Object.values(AgentName).join(", ")}`,
        });
    }

    const mcp = new NotionMCPClient();

    try {
        await mcp.connect();

        await mcp.updatePageFormatted(page_id, {
            Vote: chosen_agent,
            Status: "completed",
        });

        logger.info(`Vote: ${chosen_agent} | Page: ${page_id.slice(0, 8)}`);

        res.json({
            status: "success",
            vote: chosen_agent,
            page_id,
        });

    } catch (err) {
        logger.error(`Vote failed: ${err.message}`);
        res.status(500).json({ error: err.message });

    } finally {
        await mcp.disconnect();
    }
});

// 404
app.use((req, res) => {
    res.status(404).json({ error: "Route not found" });
});

app.listen(PORT, () => {
    logger.info(`🏛️ THE COUNCIL IS OPEN FOR BUSINESS`);
    logger.info(`🐦‍🔥 Server running on http://localhost:${PORT}`);
});

export default app;