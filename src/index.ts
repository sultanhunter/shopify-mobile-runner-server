import dotenv from "dotenv";
import { randomUUID } from "node:crypto";

import cors from "cors";
import express from "express";
import devSessionRoutes from "./routes/devSession.js";
import expoScaffoldRoutes from "./routes/expoScaffold.js";
import repoWorkspaceRoutes from "./routes/repoWorkspace.js";
import shopifyMobileAiRoutes from "./routes/shopifyMobileAi.js";
import taskRoutes from "./routes/tasks.js";
import { collectIdleProjectIds, getUserIdleTimeoutMs } from "./services/activityTracker.js";
import { getDevSessionStats, listActiveDevSessionProjectIds, stopDevSessionsForProjects } from "./services/devSession.js";
import { listActiveOpenCodeRunProjectIds, stopOpenCodeRunsForProjects } from "./services/opencodeSession.js";

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const ENABLE_REQUEST_LOGS = (process.env.SERVER_REQUEST_LOGS ?? "true").toLowerCase() !== "false";
const ENABLE_HEARTBEAT_LOGS = (process.env.SERVER_HEARTBEAT_LOGS ?? "false").toLowerCase() === "true";
const IDLE_SWEEP_INTERVAL_MS = Number(process.env.SERVER_IDLE_SWEEP_MS ?? "30000");

app.use(cors());
app.use(express.json({ limit: "10mb" }));

app.use((req, res, next) => {
    if (!ENABLE_REQUEST_LOGS) {
        next();
        return;
    }

    const isDevSessionStatusPoll =
        req.method === "GET" &&
        req.originalUrl.startsWith("/api/shopify-mobile/dev-session/") &&
        req.originalUrl.includes("/status");

    const shouldLog =
        (req.originalUrl.startsWith("/api/shopify-mobile/dev-session") && !isDevSessionStatusPoll) ||
        req.originalUrl.startsWith("/api/shopify-mobile/scaffold-expo") ||
        req.originalUrl.startsWith("/api/shopify-mobile/generate-preview") ||
        req.originalUrl.startsWith("/api/shopify-mobile/opencode/prompt") ||
        req.originalUrl.startsWith("/api/shopify-mobile/tasks/workspace/create") ||
        req.originalUrl.startsWith("/api/shopify-mobile/repo/");

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
app.use("/api", taskRoutes);
app.use("/api", repoWorkspaceRoutes);

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

if (ENABLE_HEARTBEAT_LOGS) {
    setInterval(() => {
        const memoryUsage = process.memoryUsage();
        const stats = getDevSessionStats();
        console.log(
            `[HEARTBEAT] pid=${process.pid} uptimeSec=${Math.floor(process.uptime())} rssMb=${Math.round(memoryUsage.rss / (1024 * 1024))} heapUsedMb=${Math.round(memoryUsage.heapUsed / (1024 * 1024))} sessions=${stats.total} ready=${stats.byStatus.ready} starting=${stats.byStatus.starting} failed=${stats.byStatus.failed}`,
        );
    }, Number(process.env.SERVER_HEARTBEAT_MS ?? "30000"));
}

let idleSweepInProgress = false;
setInterval(() => {
    if (idleSweepInProgress) {
        return;
    }

    idleSweepInProgress = true;
    void (async () => {
        try {
            const activeProjects = new Set<string>([
                ...listActiveDevSessionProjectIds(),
                ...listActiveOpenCodeRunProjectIds(),
            ]);

            if (activeProjects.size === 0) {
                return;
            }

            const idleProjectIds = collectIdleProjectIds([...activeProjects]);
            if (idleProjectIds.length === 0) {
                return;
            }

            const reason = `user idle timeout reached (${Math.round(getUserIdleTimeoutMs() / 60000)}m)`;
            const [stoppedDevSessions, stoppedOpenCodeRuns] = await Promise.all([
                stopDevSessionsForProjects(idleProjectIds, reason),
                Promise.resolve(stopOpenCodeRunsForProjects(idleProjectIds, reason)),
            ]);

            console.log(
                `[IDLE_SWEEP] projects=${idleProjectIds.length} stoppedDevSessions=${stoppedDevSessions} stoppedOpenCodeRuns=${stoppedOpenCodeRuns}`,
            );
        } catch (error) {
            console.error("[IDLE_SWEEP_ERROR]", error);
        } finally {
            idleSweepInProgress = false;
        }
    })();
}, Number.isFinite(IDLE_SWEEP_INTERVAL_MS) && IDLE_SWEEP_INTERVAL_MS > 0 ? IDLE_SWEEP_INTERVAL_MS : 30000).unref();

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
