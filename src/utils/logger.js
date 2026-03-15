import winston from "winston";

const { combine, timestamp, colorize, printf } = winston.format;

const logFormat = printf(({ level, message, timestamp }) => {
    return `${timestamp} | ${level.padEnd(7)} | ${message}`;
});

export const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || "info",
    format: combine(
        timestamp({ format: "HH:mm:ss" }),
        colorize(),
        logFormat
    ),
    transports: [
        new winston.transports.Console(),
        new winston.transports.File({
            filename: "logs/council.log",
            maxsize: 10 * 1024 * 1024,
            maxFiles: 3,
            format: combine(
                timestamp(),
                winston.format.json()
            ),
        }),
    ],
});