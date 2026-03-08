import dotenv from "dotenv";
import { randomUUID } from "node:crypto";

import cors from "cors";
import express from "express";
import devSessionRoutes from "./routes/devSession.js";
import expoScaffoldRoutes from "./routes/expoScaffold.js";
import shopifyMobileAiRoutes from "./routes/shopifyMobileAi.js";
import { getDevSessionStats } from "./services/devSession.js";

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.use(cors());
app.use(express.json({ limit: "10mb" }));

app.use((req, res, next) => {
    const shouldLog =
        req.originalUrl.startsWith("/api/shopify-mobile/dev-session") ||
        req.originalUrl.startsWith("/api/shopify-mobile/scaffold-expo") ||
        req.originalUrl.startsWith("/api/shopify-mobile/generate-preview") ||
        req.originalUrl.startsWith("/api/shopify-mobile/opencode/prompt");

    if (!shouldLog) {
        next();
        return;
    }

    const requestId = randomUUID().slice(0, 8);
    const start = Date.now();
    const startIso = new Date().toISOString();

    console.log(
        `[REQ ${requestId}] -> ${req.method} ${req.originalUrl} ip=${req.ip ?? "unknown"} at=${startIso}`,
    );

    res.on("finish", () => {
        const durationMs = Date.now() - start;
        console.log(
            `[REQ ${requestId}] <- ${req.method} ${req.originalUrl} status=${res.statusCode} durationMs=${durationMs}`,
        );
    });

    next();
});

app.get("/", (req, res) => {
    res.json({
        status: "ok",
        message: "Shopify mobile runner server is running",
        timestamp: new Date().toISOString(),
        pid: process.pid,
        uptimeSeconds: Math.floor(process.uptime()),
        memory: {
            rssMb: Math.round(process.memoryUsage().rss / (1024 * 1024)),
            heapUsedMb: Math.round(process.memoryUsage().heapUsed / (1024 * 1024)),
        },
        devSessions: getDevSessionStats(),
    });
});

app.use("/api", shopifyMobileAiRoutes);
app.use("/api", expoScaffoldRoutes);
app.use("/api", devSessionRoutes);

app.use(
    (
        err: any,
        req: express.Request,
        res: express.Response,
        next: express.NextFunction,
    ) => {
        console.error("Unhandled error:", err);
        res.status(500).json({
            error: "Internal server error",
            message: err.message,
        });
    },
);

const server = app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Server is running on port ${PORT}`);
    console.log(`📍 Environment: ${process.env.NODE_ENV || "development"}`);
    console.log(`📍 Health check: http://localhost:${PORT}/`);
    console.log(`📍 Dev session API: http://localhost:${PORT}/api/shopify-mobile/dev-session`);
});

server.on("error", (error) => {
    console.error("[SERVER_ERROR]", error);
});

setInterval(() => {
    const memoryUsage = process.memoryUsage();
    const stats = getDevSessionStats();
    console.log(
        `[HEARTBEAT] pid=${process.pid} uptimeSec=${Math.floor(process.uptime())} rssMb=${Math.round(memoryUsage.rss / (1024 * 1024))} heapUsedMb=${Math.round(memoryUsage.heapUsed / (1024 * 1024))} sessions=${stats.total} ready=${stats.byStatus.ready} starting=${stats.byStatus.starting} failed=${stats.byStatus.failed}`,
    );
}, Number(process.env.SERVER_HEARTBEAT_MS ?? "30000"));

process.on("unhandledRejection", (reason) => {
    console.error("[UNHANDLED_REJECTION]", reason);
});

process.on("uncaughtException", (error) => {
    console.error("[UNCAUGHT_EXCEPTION]", error);
});

process.on("SIGTERM", () => {
    console.warn("[SIGNAL] SIGTERM received, shutting down server.");
    server.close(() => {
        console.warn("[SIGNAL] Server closed after SIGTERM.");
        process.exit(0);
    });
});

process.on("SIGINT", () => {
    console.warn("[SIGNAL] SIGINT received, shutting down server.");
    server.close(() => {
        console.warn("[SIGNAL] Server closed after SIGINT.");
        process.exit(0);
    });
});
