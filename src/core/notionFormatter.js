/**
 * Beautiful Notion block builders.
 * Makes the debate page look incredible.
 */

export const NotionFormatter = {

    // Page Header

    debateHeader(question) {
        return [
            {
                object: "block",
                type: "callout",
                callout: {
                    rich_text: [{
                        type: "text",
                        text: { content: `🏛️ THE COUNCIL HAS BEEN SUMMONED\n\n"${question}"` },
                        annotations: { bold: true }
                    }],
                    icon: { emoji: "⚖️" },
                    color: "blue_background"
                }
            },
            {
                object: "block",
                type: "divider",
                divider: {}
            }
        ];
    },

    // Round Header

    roundHeader(roundNumber, totalRounds) {
        return [
            {
                object: "block",
                type: "heading_2",
                heading_2: {
                    rich_text: [{
                        type: "text",
                        text: { content: `⚔️ Round ${roundNumber} of ${totalRounds}` },
                        annotations: { bold: true, color: "orange" }
                    }],
                    color: "orange_background"
                }
            }
        ];
    },

    // Agent Argument

    agentArgument(agent, content, roundNumber) {
        const styles = {
            SENTINEL: { emoji: "⚔️", color: "red_background" },
            MERCURY: { emoji: "⚡", color: "yellow_background" },
            MIDAS: { emoji: "💰", color: "green_background" },
            ATLAS: { emoji: "🌍", color: "blue_background" },
        };

        const style = styles[agent] || { emoji: "🤖", color: "default" };

        return [
            {
                object: "block",
                type: "callout",
                callout: {
                    rich_text: [
                        {
                            type: "text",
                            text: { content: `${agent}  ·  Round ${roundNumber}\n` },
                            annotations: { bold: true }
                        },
                        {
                            type: "text",
                            text: { content: content }
                        }
                    ],
                    icon: { emoji: style.emoji },
                    color: style.color
                }
            }
        ];
    },

    // Divider

    divider() {
        return [{
            object: "block",
            type: "divider",
            divider: {}
        }];
    },

    // Consensus Block

    consensusSection(consensus) {
        const blocks = [
            // Big header
            {
                object: "block",
                type: "divider",
                divider: {}
            },
            {
                object: "block",
                type: "heading_1",
                heading_1: {
                    rich_text: [{
                        type: "text",
                        text: { content: "✅ THE COUNCIL HAS SPOKEN" },
                        annotations: { bold: true, color: "green" }
                    }]
                }
            },

            // Decision callout
            {
                object: "block",
                type: "callout",
                callout: {
                    rich_text: [
                        {
                            type: "text",
                            text: { content: "FINAL DECISION\n" },
                            annotations: { bold: true }
                        },
                        {
                            type: "text",
                            text: { content: consensus.decision }
                        }
                    ],
                    icon: { emoji: "🏆" },
                    color: "green_background"
                }
            },

            // Reasoning
            {
                object: "block",
                type: "callout",
                callout: {
                    rich_text: [
                        {
                            type: "text",
                            text: { content: "REASONING\n" },
                            annotations: { bold: true }
                        },
                        {
                            type: "text",
                            text: { content: consensus.reasoning }
                        }
                    ],
                    icon: { emoji: "📖" },
                    color: "gray_background"
                }
            },

            // Winning perspective
            {
                object: "block",
                type: "callout",
                callout: {
                    rich_text: [{
                        type: "text",
                        text: {
                            content: `🥇 Winning Perspective: ${consensus.winningPerspective}`
                        },
                        annotations: { bold: true }
                    }],
                    icon: { emoji: "🎯" },
                    color: "yellow_background"
                }
            },

            // Action items header
            {
                object: "block",
                type: "heading_2",
                heading_2: {
                    rich_text: [{
                        type: "text",
                        text: { content: "📋 Action Items" },
                        annotations: { bold: true }
                    }]
                }
            },

            // Action items as to-dos
            ...(consensus.actionItems || []).map((item, i) => ({
                object: "block",
                type: "to_do",
                to_do: {
                    rich_text: [{
                        type: "text",
                        text: { content: `${item}` }
                    }],
                    checked: false
                }
            })),

            // Rejected arguments
            {
                object: "block",
                type: "divider",
                divider: {}
            },
            {
                object: "block",
                type: "callout",
                callout: {
                    rich_text: [
                        {
                            type: "text",
                            text: { content: "WHY OTHER POSITIONS LOST\n" },
                            annotations: { bold: true }
                        },
                        {
                            type: "text",
                            text: { content: consensus.rejectedArguments }
                        }
                    ],
                    icon: { emoji: "❌" },
                    color: "red_background"
                }
            }
        ];

        return blocks;
    },

    // Deadlock Block

    deadlockSection() {
        return [
            {
                object: "block",
                type: "callout",
                callout: {
                    rich_text: [
                        {
                            type: "text",
                            text: { content: "🔒 THE COUNCIL IS DEADLOCKED\n\n" },
                            annotations: { bold: true }
                        },
                        {
                            type: "text",
                            text: {
                                content:
                                    "The agents could not reach consensus.\n\n" +
                                    "Cast your deciding vote using the Vote property:\n\n" +
                                    "⚔️  SENTINEL — Prioritize Security\n" +
                                    "⚡  MERCURY  — Prioritize Speed\n" +
                                    "💰  MIDAS    — Prioritize Cost\n" +
                                    "🌍  ATLAS    — Prioritize Scale"
                            }
                        }
                    ],
                    icon: { emoji: "⚖️" },
                    color: "orange_background"
                }
            }
        ];
    },

    // Stats Block

    statsBlock(stats) {
        return [
            {
                object: "block",
                type: "callout",
                callout: {
                    rich_text: [{
                        type: "text",
                        text: {
                            content:
                                `📊 Debate Stats\n\n` +
                                `• Total Rounds     : ${stats.rounds}\n` +
                                `• Total Arguments  : ${stats.totalArguments}\n` +
                                `• Duration         : ${stats.duration}s\n` +
                                `• Agents           : SENTINEL, MERCURY, MIDAS, ATLAS`
                        }
                    }],
                    icon: { emoji: "📊" },
                    color: "purple_background"
                }
            }
        ];
    }
};