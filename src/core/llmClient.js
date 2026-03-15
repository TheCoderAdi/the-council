import dotenv from "dotenv";
import { logger } from "../utils/logger.js";
dotenv.config();

// Lightweight, pluggable LLM client wrapper with automatic fallback.
// Primary provider selected via process.env.LLM_PROVIDER (default: gemini).
// If Gemini returns a 429/quota error, the client will attempt Groq (if configured).

let _cached = {};

async function _createProvider(providerName) {
    const provider = (providerName || (process.env.LLM_PROVIDER || "gemini")).toLowerCase();

    if (provider === "gemini") {
        const { GoogleGenerativeAI } = await import("@google/generative-ai");
        const apiKey = process.env.GEMINI_API_KEY;
        const client = new GoogleGenerativeAI(apiKey);
        return {
            provider: "gemini",
            getGenerativeModel: (opts = {}) => client.getGenerativeModel(opts),
        };
    }

    if (provider === "groq") {
        const groqApiKey = process.env.GROQ_API_KEY;
        const groqUrl = process.env.GROQ_API_URL || "https://api.groq.com/openai/v1";

        return {
            provider: "groq",
            getGenerativeModel: ({ model, systemInstruction } = {}) => {
                const modelName = model || process.env.GROQ_MODEL;

                return {
                    generateContent: async (prompt) => {
                        if (!groqApiKey) {
                            const err = new Error("GROQ_API_KEY is not set");
                            err.status = 401;
                            throw err;
                        }

                        if (!modelName) {
                            const err = new Error("Groq model not specified (GROQ_MODEL or model param)");
                            err.status = 400;
                            throw err;
                        }

                        try {
                            const { default: OpenAI } = await import("openai");
                            const client = new OpenAI({ apiKey: groqApiKey, baseURL: groqUrl });

                            const payload = {
                                model: modelName,
                                input: `${systemInstruction ? systemInstruction + "\n\n" : ""}${prompt}`,
                            };

                            const res = await client.responses.create(payload);

                            const generated =
                                res.output_text ||
                                (res.output && Array.isArray(res.output) && res.output[0] && ((res.output[0].content && res.output[0].content.map(c => c.text).join("")) || res.output[0].text)) ||
                                JSON.stringify(res);

                            return {
                                response: {
                                    text: () => String(generated),
                                },
                            };
                        } catch (e) {
                            const err = new Error(`Groq API error: ${e.message}`);
                            err.status = e?.status || e?.code || 500;
                            throw err;
                        }
                    },
                };
            },
        };
    }

    throw new Error(`Unsupported LLM_PROVIDER: ${provider}`);
}

/**
 * Generate text using the configured provider and automatically fall back to Groq
 * when Gemini returns a quota/429 error.
 *
 * Returns: { provider, text, raw }
 */
export async function generate(prompt, { model, systemInstruction } = {}) {
    const MAX_CONCURRENCY = parseInt(process.env.LLM_MAX_CONCURRENCY || "2", 10);
    const MIN_DELAY_MS = parseInt(process.env.LLM_MIN_DELAY_MS || "150", 10);

    // Simple semaphore/queue implementation
    if (!global.__llm_semaphore) {
        global.__llm_semaphore = {
            running: 0,
            queue: [],
            lastRun: 0,
        };
    }

    const sem = global.__llm_semaphore;

    const runWithLock = (fn) =>
        new Promise((resolve, reject) => {
            const task = async () => {
                try {
                    // enforce minimum delay since last run
                    const now = Date.now();
                    const since = now - (sem.lastRun || 0);
                    if (since < MIN_DELAY_MS) {
                        await new Promise((r) => setTimeout(r, MIN_DELAY_MS - since));
                    }

                    sem.running += 1;
                    sem.lastRun = Date.now();
                    const res = await fn();
                    resolve(res);
                } catch (e) {
                    reject(e);
                } finally {
                    sem.running -= 1;
                    // schedule next queued task if any
                    if (sem.queue.length > 0) {
                        const next = sem.queue.shift();
                        setTimeout(next, 0);
                    }
                }
            };

            if (sem.running < MAX_CONCURRENCY) {
                task();
            } else {
                sem.queue.push(task);
            }
        });

    const _doGenerate = async () => {
        const primaryProvider = (process.env.LLM_PROVIDER || "gemini").toLowerCase();
        let primary = _cached[primaryProvider];
        if (!primary) {
            primary = await _createProvider(primaryProvider);
            _cached[primaryProvider] = primary;
        }

        const modelName = model || (primaryProvider === "gemini" ? process.env.GEMINI_MODEL : process.env.GROQ_MODEL);

        // Helper to unify response
        const _unwrap = (result) => {
            try {
                if (result?.response && typeof result.response.text === "function") {
                    return String(result.response.text());
                }
                if (typeof result === "string") return result;
                if (result?.text) return String(result.text);
                return JSON.stringify(result);
            } catch (e) {
                return String(result);
            }
        };

        // Try primary
        try {
            const modelObj = primary.getGenerativeModel({ model: modelName, systemInstruction });
            const res = await modelObj.generateContent(prompt);
            return { provider: primary.provider, text: _unwrap(res), raw: res };
        } catch (err) {
            // Detect quota/429 from Gemini
            const msg = String(err?.message || "").toLowerCase();
            const status = err?.status || null;
            if ((primary.provider === "gemini") && (status === 429 || msg.includes("429") || msg.includes("quota") || msg.includes("rate limit"))) {
                logger.warn(`LLM ${primary.provider} returned quota/429.`);

                // Only attempt Groq fallback if it appears configured (API key + model)
                const groqKey = process.env.GROQ_API_KEY;
                const groqModel = model || process.env.GROQ_MODEL;
                if (!groqKey || !groqModel) {
                    logger.warn("Groq fallback not attempted: GROQ_API_KEY or GROQ_MODEL missing.");
                    throw err;
                }

                logger.warn("Attempting fallback to groq.");

                // Attempt Groq
                try {
                    const fallback = _cached["groq"] || (await _createProvider("groq"));
                    _cached["groq"] = fallback;

                    const fallbackModelName = process.env.GROQ_MODEL || "openai/gpt-oss-20b";

                    const modelObj = fallback.getGenerativeModel({ model: fallbackModelName, systemInstruction });
                    const res = await modelObj.generateContent(prompt);
                    return { provider: fallback.provider, text: _unwrap(res), raw: res };
                } catch (err2) {
                    logger.error(`Groq fallback failed: ${err2.message}`);
                    throw err2;
                }
            }

            // Not a fallback-able error; rethrow
            throw err;
        }
    };

    // Run the generation through the rate-limited queue
    return await runWithLock(_doGenerate);
}

// Backwards-compatible helper
export async function getLLM() {
    const provider = (process.env.LLM_PROVIDER || "gemini").toLowerCase();
    if (!_cached[provider]) {
        _cached[provider] = await _createProvider(provider);
    }
    return _cached[provider];
}
