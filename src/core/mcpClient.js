import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import dotenv from "dotenv";
import { logger } from "../utils/logger.js";

dotenv.config();

export class NotionMCPClient {
    constructor() {
        this.apiKey = process.env.NOTION_API_KEY;
        const rawDb = String(process.env.NOTION_DATABASE_ID || "");
        const hyphenUuid = rawDb.match(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/);
        const plain32 = rawDb.match(/([0-9a-fA-F]{32})/);
        if (hyphenUuid) {
            this.databaseId = hyphenUuid[0];
        } else if (plain32) {
            const s = plain32[1];
            this.databaseId = `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
        } else {
            this.databaseId = rawDb;
        }
        this.client = null;
        this.transport = null;
        this.tools = [];
        this.toolMap = {};
        this._lastToolErrorTimes = {};
        this._cachedQueryDataSourceArgs = null;
    }

    // Connection

    async connect() {
        this.transport = new StdioClientTransport({
            command: "npx",
            args: ["-y", "@notionhq/notion-mcp-server"],
            env: {
                ...process.env,
                OPENAPI_MCP_HEADERS: JSON.stringify({
                    "Authorization": `Bearer ${this.apiKey}`,
                    "Notion-Version": "2022-06-28",
                }),
            },
        });

        this.client = new Client(
            { name: "the-council", version: "1.0.0" },
            { capabilities: {} }
        );

        await this.client.connect(this.transport);

        const toolsResult = await this.client.listTools();
        this.tools = toolsResult.tools || [];
        this.toolMap = {};

        for (const tool of this.tools) {
            this.toolMap[tool.name] = tool;
        }

        logger.info(
            `Notion MCP connected | ` +
            `${this.tools.length} tools | ` +
            `Names: ${this.tools.map((t) => t.name).join(", ")}`
        );

        return this;
    }

    async disconnect() {
        if (this.transport) {
            await this.transport.close();
            this.client = null;
            this.transport = null;
            this.tools = [];
            this.toolMap = {};
            logger.info("Notion MCP disconnected");
        }
    }

    // Core Tool Caller

    async callTool(toolName, args = {}) {
        if (!this.client) {
            throw new Error("Not connected. Call connect() first.");
        }

        try {
            logger.debug(`MCP → ${toolName} | args: ${JSON.stringify(args)}`);

            const pathArgs = {};
            const bodyArgs = {};
            for (const [k, v] of Object.entries(args || {})) {
                if (/_id$/.test(k)) pathArgs[k] = v;
                else bodyArgs[k] = v;
            }

            const finalArgs = { ...pathArgs, ...bodyArgs };

            logger.info(`MCP → calling tool: ${toolName} with args: ${JSON.stringify(finalArgs)}`);

            const result = await this.client.callTool({
                name: toolName,
                arguments: finalArgs,
            });

            // Extract text from response
            if (result?.content?.length > 0) {
                for (const item of result.content) {
                    if (item.type === "text") {
                        return item.text;
                    }
                }
            }

            return null;

        } catch (err) {
            // Log full error details when available
            try {
                const now = Date.now();
                const last = this._lastToolErrorTimes[toolName] || 0;
                const QUIET_MS = 60 * 1000;

                if (now - last > QUIET_MS) {
                    const details = {
                        message: err.message,
                        code: err.code,
                        status: err.status || err?.response?.status,
                        statusText: err?.response?.statusText,
                        body: err?.response?.data || err?.body || null,
                    };
                    logger.error(`MCP [${toolName}] failed: ${JSON.stringify(details)}`);
                    this._lastToolErrorTimes[toolName] = now;
                } else {
                    logger.warn(`MCP [${toolName}] failing repeatedly: ${err.message}`);
                }
            } catch (logErr) {
                logger.error(`MCP [${toolName}] failed: ${err.message}`);
            }
            throw err;
        }
    }

    // ID normalization helper: strip URL query params and hyphenate 32-char uuids
    _normalizeId(maybeId = "") {
        if (!maybeId) return maybeId;
        let s = String(maybeId || "");
        // Strip Notion URL query params like "?v=..." and trailing fragments
        const q = s.indexOf("?");
        if (q !== -1) s = s.slice(0, q);
        s = s.replace(/https?:\/\/[\w\.-]+\//, "");
        // Extract 32 hex chars if present
        const plain32 = s.match(/([0-9a-fA-F]{32})/);
        if (plain32) {
            const p = plain32[1];
            return `${p.slice(0, 8)}-${p.slice(8, 12)}-${p.slice(12, 16)}-${p.slice(16, 20)}-${p.slice(20)}`;
        }
        // If already hyphenated uuid, return as-is (but remove accidental whitespace)
        const hy = s.match(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/);
        if (hy) return hy[0];
        return s;
    }

    // Safe Tool Caller

    async safeCallTool(toolName, args = {}) {
        const maxRetries = 3;
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                return await this.callTool(toolName, args);
            } catch (err) {
                const status = err?.status || err?.response?.status;

                // If client error (4xx) don't retry
                if (status && status >= 400 && status < 500) {
                    logger.error(`MCP tool [${toolName}] client error ${status}: ${err.message}`);
                    return null;
                }

                // Transient or server error — retry with backoff
                logger.warn(`Safe call attempt ${attempt}/${maxRetries} failed [${toolName}]: ${err.message}`);

                if (attempt === maxRetries) {
                    logger.error(`MCP tool [${toolName}] failed after ${maxRetries} attempts`);
                    return null;
                }

                // Exponential backoff
                const backoff = 200 * Math.pow(2, attempt - 1);
                await new Promise((r) => setTimeout(r, backoff));
            }
        }
    }

    // Parse Helper

    #parse(result) {
        if (!result) return null;
        if (typeof result === "object") return result;
        try {
            return JSON.parse(result);
        } catch {
            return null;
        }
    }

    // Notion Operations

    async queryDatabase(filterParams = null) {
        /**
         * Tool: API-query-data-source
         * Query the debates database
         */
        const tryArgs = [];

        // Helper to clone and attach filter if present
        const attachFilter = (obj) => {
            const copy = { ...obj };
            if (filterParams) copy.filter = filterParams;
            return copy;
        };

        // Common shapes
        tryArgs.push(attachFilter({ data_source_id: this.databaseId }));
        tryArgs.push(attachFilter({ database_id: this.databaseId }));
        tryArgs.push(attachFilter({ parent: { database_id: this.databaseId } }));
        tryArgs.push(attachFilter({ request: { database_id: this.databaseId } }));
        tryArgs.push(attachFilter({ body: { database_id: this.databaseId } }));
        tryArgs.push(attachFilter({ query: { database_id: this.databaseId } }));

        if (this._cachedQueryDataSourceArgs) {
            tryArgs.unshift(this._cachedQueryDataSourceArgs);
        }

        const tool = this.toolMap["API-query-data-source"];
        try {
            if (tool) {
                // helpful fields: tool.input_schema, tool.parameters, tool.schema
                const schema = tool.input_schema || tool.parameters || tool.schema || null;
                const raw = JSON.stringify(schema || tool).toLowerCase();

                // If the tool mentions "data_source" prefer data_source_id
                if (raw.includes("data_source") && !tryArgs.some(a => a.data_source_id)) {
                    tryArgs.unshift(attachFilter({ data_source_id: this.databaseId }));
                }
                if (raw.includes("database_id") && !tryArgs.some(a => a.database_id)) {
                    tryArgs.unshift(attachFilter({ database_id: this.databaseId }));
                }

                // If the schema exposes explicit property names, try to use them
                if (schema && typeof schema === "object") {
                    const props = schema.properties || schema.fields || null;
                    if (props && typeof props === "object") {
                        for (const key of Object.keys(props)) {
                            const lname = key.toLowerCase();
                            if (lname.includes("data") || lname.includes("database") || lname.includes("source")) {
                                const candidate = {};
                                candidate[key] = this.databaseId;
                                tryArgs.unshift(attachFilter(candidate));
                            }
                        }
                    }
                }
            }
        } catch (e) {
            // ignore parsing errors and continue with defaults
        }

        let parsed = null;
        for (const attemptArgs of tryArgs) {
            logger.debug(`🔎 Trying API-query-data-source with args: ${JSON.stringify(attemptArgs)}`);
            const result = await this.safeCallTool("API-query-data-source", attemptArgs);
            const p = this.#parse(result);
            if (p && Array.isArray(p.results)) {
                // Cache the successful shape so subsequent calls prefer it
                try {
                    this._cachedQueryDataSourceArgs = attemptArgs;
                    logger.info(`🔎 API-query-data-source working args cached: ${JSON.stringify(attemptArgs)}`);
                } catch (e) {
                    // ignore cache failures
                }
                return p.results;
            }
            // keep the last parsed result for logging if needed
            parsed = p || parsed;
        }

        logger.warn("API-query-data-source returned no usable results for tried argument shapes; falling back to API-post-search");

        const searchRes = await this.safeCallTool("API-post-search", { query: "", page_size: 100 });
        const searchParsed = this.#parse(searchRes) || {};
        const items = searchParsed?.results || [];

        // Filter pages that belong to our database by inspecting the parent object
        const filtered = items.filter((item) => {
            try {
                const parent = item?.parent || {};
                return (
                    parent?.database_id === this.databaseId ||
                    (parent?.type === "database_id" && parent?.database_id === this.databaseId)
                );
            } catch {
                return false;
            }
        });

        return filtered;
    }

    async getPage(pageId) {
        /**
         * Tool: API-retrieve-a-page
         * Get a page's full properties
         */
        const normalized = this._normalizeId(pageId);
        const result = await this.safeCallTool(
            "API-retrieve-a-page",
            { page_id: normalized }
        );

        return this.#parse(result) || {};
    }

    async getPageContent(pageId) {
        /**
         * Tool: API-get-block-children
         * Get all blocks from a page as plain text
         */
        const normalized = this._normalizeId(pageId);
        const result = await this.safeCallTool(
            "API-get-block-children",
            { block_id: normalized }
        );

        const parsed = this.#parse(result);
        if (!parsed) return "";

        const blocks = parsed?.results || [];
        return this.#blocksToText(blocks);
    }

    async updatePage(pageId, properties) {
        /**
         * Tool: API-patch-page
         * Update page properties (Status, Vote, etc.)
         */
        const normalized = this._normalizeId(pageId);
        const result = await this.safeCallTool(
            "API-patch-page",
            {
                page_id: normalized,
                properties: properties,
            }
        );

        return this.#parse(result) || {};
    }

    async appendBlocks(blockId, children) {
        /**
         * Tool: API-patch-block-children
         * Append blocks to a page
         * This is how agents write to Notion
         */
        const normalized = this._normalizeId(blockId);
        const result = await this.safeCallTool(
            "API-patch-block-children",
            {
                block_id: normalized,
                children: children,
            }
        );

        return this.#parse(result) || {};
    }

    async retrieveDatabase(databaseId) {
        /**
         * Tool: API-retrieve-a-data-source
         * Get database metadata and properties
         */
        const result = await this.safeCallTool(
            "API-retrieve-a-database",
            { database_id: databaseId || this.databaseId }
        );

        return this.#parse(result) || {};
    }

    async getDatabaseProperties() {
        // Cache properties for a short time to avoid frequent retrieve calls
        if (this._dbProperties && Date.now() - this._dbProperties._ts < 30 * 1000) {
            return this._dbProperties.props;
        }

        const db = await this.retrieveDatabase(this.databaseId);
        const props = db?.properties || {};
        this._dbProperties = { props, _ts: Date.now() };
        return props;
    }

    formatPropertiesForDatabase(simpleProps = {}) {
        /**
         * Convert a simple key->value map into Notion property shapes by
         * inferring types from the cached database properties. If a property
         * is not known, try reasonable defaults.
         *
         * Example input:
         *  { Question: 'Is X?', Status: 'pending', Vote: 'ATLAS', Created: '2024-01-01T00:00:00Z' }
         */
        const formatted = {};
        const props = this._dbProperties?.props || {};

        for (const [key, val] of Object.entries(simpleProps || {})) {
            const dbProp = props[key];
            // If property doesn't exist in DB schema, make a best-effort attempt
            const v = val;

            if (dbProp) {
                const t = dbProp.type;
                if (t === "title") {
                    formatted[key] = { title: [{ type: "text", text: { content: String(v) } }] };
                } else if (t === "rich_text") {
                    formatted[key] = { rich_text: [{ type: "text", text: { content: String(v) } }] };
                } else if (t === "select") {
                    formatted[key] = { select: { name: String(v) } };
                } else if (t === "multi_select") {
                    const items = Array.isArray(v) ? v : String(v).split(",").map(s => s.trim()).filter(Boolean);
                    formatted[key] = { multi_select: items.map((i) => ({ name: i })) };
                } else if (t === "date") {
                    const start = v instanceof Date ? v.toISOString() : String(v);
                    formatted[key] = { date: { start } };
                } else if (t === "number") {
                    formatted[key] = { number: Number(v) };
                } else if (t === "checkbox") {
                    formatted[key] = { checkbox: Boolean(v) };
                } else {
                    formatted[key] = { rich_text: [{ type: "text", text: { content: String(v) } }] };
                }
            } else {
                const lname = key.toLowerCase();
                if (lname === "title" || lname === "question" || lname === "name") {
                    formatted[key] = { title: [{ type: "text", text: { content: String(v) } }] };
                } else if (lname === "decision" || lname === "debate" || lname === "summary") {
                    formatted[key] = { rich_text: [{ type: "text", text: { content: String(v) } }] };
                } else if (lname === "status" || lname === "vote") {
                    formatted[key] = { select: { name: String(v) } };
                } else {
                    formatted[key] = { rich_text: [{ type: "text", text: { content: String(v) } }] };
                }
            }
        }

        return formatted;
    }

    async updatePageFormatted(pageId, simpleProps = {}) {
        await this.getDatabaseProperties();
        const formatted = this.formatPropertiesForDatabase(simpleProps);
        return this.updatePage(pageId, formatted);
    }

    // Helpers

    getTitle(page) {
        /**
         * Extract the question text from a Notion page.
         * Tries multiple property name formats.
         */
        try {
            const props = page?.properties || {};

            // Try "Question" property
            const qProp = props?.Question?.title || [];
            if (qProp.length > 0) {
                return (
                    qProp[0]?.plain_text ||
                    qProp[0]?.text?.content ||
                    ""
                );
            }

            // Fallback: try "Name" (default Notion title)
            const nProp = props?.Name?.title || [];
            if (nProp.length > 0) {
                return (
                    nProp[0]?.plain_text ||
                    nProp[0]?.text?.content ||
                    ""
                );
            }

            return "";
        } catch {
            return "";
        }
    }

    getStatus(page) {
        /**
         * Extract Status select value from a page
         */
        try {
            return page?.properties?.Status?.select?.name || null;
        } catch {
            return null;
        }
    }

    getAvailableTools() {
        return this.tools.map((t) => ({
            name: t.name,
            description: t.description?.slice(0, 80) || "",
        }));
    }

    #blocksToText(blocks) {
        return blocks
            .map((block) => {
                const type = block?.type;
                const content = block?.[type] || {};
                const texts = content?.rich_text || [];
                return texts
                    .map((t) => t?.plain_text || t?.text?.content || "")
                    .join(" ");
            })
            .filter(Boolean)
            .join("\n");
    }
}

export const notionMcp = new NotionMCPClient();