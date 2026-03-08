import { Request, Response, Router } from "express";
import {
    applyAndPushDevSessionChanges,
    getDevSession,
    listDevSessions,
    startDevSession,
    stopDevSession,
} from "../services/devSession.js";

interface StartDevSessionBody {
    projectId?: unknown;
    repoUrl?: unknown;
    branch?: unknown;
    install?: unknown;
    useTunnel?: unknown;
}

interface ApplyAndPushBody {
    files?: unknown;
    commitMessage?: unknown;
    runInstall?: unknown;
}

function asNonEmptyString(value: unknown): string | null {
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
    return typeof value === "boolean" ? value : fallback;
}

function bearerToken(headerValue: string | undefined): string | null {
    if (!headerValue) return null;
    const [scheme, token] = headerValue.split(" ");
    if (!scheme || !token) return null;
    if (scheme.toLowerCase() !== "bearer") return null;
    return token;
}

function authorizeRequest(req: Request, res: Response): boolean {
    const requiredToken = process.env.SHOPIFY_MOBILE_AI_SERVER_TOKEN?.trim();
    const token = bearerToken(req.headers.authorization);

    if (requiredToken && token !== requiredToken) {
        res.status(401).json({ error: "Unauthorized" });
        return false;
    }

    return true;
}

const router = Router();

router.post("/shopify-mobile/dev-session/start", async (req: Request, res: Response) => {
    if (!authorizeRequest(req, res)) {
        return;
    }

    const body = req.body as StartDevSessionBody;
    const projectId = asNonEmptyString(body.projectId);
    const repoUrl = asNonEmptyString(body.repoUrl);
    const branch = asNonEmptyString(body.branch) ?? "main";

    if (!projectId || !repoUrl) {
        return res.status(400).json({ error: "projectId and repoUrl are required." });
    }

    try {
        const session = await startDevSession({
            projectId,
            repoUrl,
            branch,
            install: asBoolean(body.install, true),
            useTunnel: asBoolean(body.useTunnel, true),
        });

        return res.status(202).json({ session });
    } catch (error) {
        return res.status(500).json({
            error: error instanceof Error ? error.message : "Failed to start dev session.",
        });
    }
});

router.get("/shopify-mobile/dev-session/:sessionId/status", async (req: Request, res: Response) => {
    if (!authorizeRequest(req, res)) {
        return;
    }

    const sessionId = req.params.sessionId;
    const logLines = Number(req.query.logLines ?? "200");

    const session = getDevSession(sessionId, Number.isFinite(logLines) ? logLines : 200);
    if (!session) {
        return res.status(404).json({ error: "Session not found." });
    }

    return res.json({ session });
});

router.get("/shopify-mobile/dev-session", async (req: Request, res: Response) => {
    if (!authorizeRequest(req, res)) {
        return;
    }

    const logLines = Number(req.query.logLines ?? "100");
    const sessions = listDevSessions(Number.isFinite(logLines) ? logLines : 100);
    return res.json({ sessions });
});

router.post("/shopify-mobile/dev-session/:sessionId/stop", async (req: Request, res: Response) => {
    if (!authorizeRequest(req, res)) {
        return;
    }

    const session = await stopDevSession(req.params.sessionId);
    if (!session) {
        return res.status(404).json({ error: "Session not found." });
    }

    return res.json({ session });
});

router.post("/shopify-mobile/dev-session/:sessionId/apply-and-push", async (req: Request, res: Response) => {
    if (!authorizeRequest(req, res)) {
        return;
    }

    const body = req.body as ApplyAndPushBody;
    const files = body.files as Record<string, string> | undefined;
    const commitMessage = asNonEmptyString(body.commitMessage) ?? undefined;
    const runInstall = asBoolean(body.runInstall, false);

    try {
        const result = await applyAndPushDevSessionChanges(req.params.sessionId, {
            files,
            commitMessage,
            runInstall,
        });

        return res.json(result);
    } catch (error) {
        return res.status(500).json({
            error: error instanceof Error ? error.message : "Failed to commit and push changes.",
        });
    }
});

export default router;
