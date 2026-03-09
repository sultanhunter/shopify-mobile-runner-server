import { Request, Response, Router } from "express";
import { runShopifyOpenCodePrompt, stopOpenCodeRunForProject, streamShopifyOpenCodePrompt } from "../services/opencodeSession.js";
import { generateShopifyMobilePreviewUpdate } from "../services/shopifyMobileAi.js";
import { markProjectActivity } from "../services/activityTracker.js";

interface GeneratePreviewBody {
    projectId?: unknown;
    prompt?: unknown;
    model?: unknown;
    preview?: unknown;
}

interface OpenCodePromptBody {
    projectId?: unknown;
    repoUrl?: unknown;
    branch?: unknown;
    prompt?: unknown;
    model?: unknown;
    thinking?: unknown;
}

function asNonEmptyString(value: unknown): string | null {
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function bearerToken(headerValue: string | undefined): string | null {
    if (!headerValue) return null;
    const [scheme, token] = headerValue.split(" ");
    if (!scheme || !token) return null;
    if (scheme.toLowerCase() !== "bearer") return null;
    return token;
}

const router = Router();

router.post("/shopify-mobile/generate-preview", async (req: Request, res: Response) => {
    const requiredToken = process.env.SHOPIFY_MOBILE_AI_SERVER_TOKEN?.trim();
    const token = bearerToken(req.headers.authorization);

    if (requiredToken && token !== requiredToken) {
        return res.status(401).json({ error: "Unauthorized" });
    }

    const body = req.body as GeneratePreviewBody;
    const projectId = asNonEmptyString(body.projectId);
    const prompt = asNonEmptyString(body.prompt);
    const model = asNonEmptyString(body.model);

    if (!projectId || !prompt || !body.preview || typeof body.preview !== "object") {
        return res.status(400).json({
            error: "projectId, prompt, and preview are required.",
        });
    }

    try {
        const result = await generateShopifyMobilePreviewUpdate({
            projectId,
            prompt,
            model: model ?? undefined,
            preview: body.preview as any,
        });

        return res.json({ result });
    } catch (error) {
        return res.status(500).json({
            error: error instanceof Error ? error.message : "Failed to generate preview update.",
        });
    }
});

router.post("/shopify-mobile/opencode/prompt", async (req: Request, res: Response) => {
    const requiredToken = process.env.SHOPIFY_MOBILE_AI_SERVER_TOKEN?.trim();
    const token = bearerToken(req.headers.authorization);

    if (requiredToken && token !== requiredToken) {
        return res.status(401).json({ error: "Unauthorized" });
    }

    const body = req.body as OpenCodePromptBody;
    const projectId = asNonEmptyString(body.projectId);
    const repoUrl = asNonEmptyString(body.repoUrl);
    const branch = asNonEmptyString(body.branch) ?? "main";
    const prompt = asNonEmptyString(body.prompt);
    const model = asNonEmptyString(body.model);
    const thinking = asNonEmptyString(body.thinking);

    if (!projectId || !repoUrl || !prompt) {
        return res.status(400).json({ error: "projectId, repoUrl, and prompt are required." });
    }

    try {
        markProjectActivity(projectId, "opencode/prompt");

        const keepAliveActivity = setInterval(() => {
            markProjectActivity(projectId, "opencode/prompt/keepalive");
        }, 15000);
        keepAliveActivity.unref();

        const result = await runShopifyOpenCodePrompt({
            projectId,
            repoUrl,
            branch,
            prompt,
            model: model ?? undefined,
            thinking: thinking ?? undefined,
        }).finally(() => {
            clearInterval(keepAliveActivity);
        });

        return res.json({ result });
    } catch (error) {
        return res.status(500).json({
            error: error instanceof Error ? error.message : "Failed to run OpenCode prompt.",
        });
    }
});

router.post("/shopify-mobile/opencode/prompt/stream", async (req: Request, res: Response) => {
    const requiredToken = process.env.SHOPIFY_MOBILE_AI_SERVER_TOKEN?.trim();
    const token = bearerToken(req.headers.authorization);

    if (requiredToken && token !== requiredToken) {
        return res.status(401).json({ error: "Unauthorized" });
    }

    const body = req.body as OpenCodePromptBody;
    const projectId = asNonEmptyString(body.projectId);
    const repoUrl = asNonEmptyString(body.repoUrl);
    const branch = asNonEmptyString(body.branch) ?? "main";
    const prompt = asNonEmptyString(body.prompt);
    const model = asNonEmptyString(body.model);
    const thinking = asNonEmptyString(body.thinking);

    if (!projectId || !repoUrl || !prompt) {
        return res.status(400).json({ error: "projectId, repoUrl, and prompt are required." });
    }

    res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    markProjectActivity(projectId, "opencode/stream/start");

    let streamClosedEarly = false;
    const keepAliveActivity = setInterval(() => {
        markProjectActivity(projectId, "opencode/stream/keepalive");
    }, 15000);
    keepAliveActivity.unref();

    req.on("close", () => {
        streamClosedEarly = true;
        clearInterval(keepAliveActivity);
        stopOpenCodeRunForProject(projectId, "client disconnected during stream");
    });

    const writeEvent = (payload: Record<string, unknown>) => {
        res.write(`${JSON.stringify(payload)}\n`);
    };

    try {
        const result = await streamShopifyOpenCodePrompt(
            {
                projectId,
                repoUrl,
                branch,
                prompt,
                model: model ?? undefined,
                thinking: thinking ?? undefined,
            },
            (event) => {
                markProjectActivity(projectId, "opencode/stream/event");
                writeEvent({ type: "event", event });
            },
        );

        clearInterval(keepAliveActivity);

        if (streamClosedEarly) {
            return;
        }

        writeEvent({ type: "result", result });
        res.end();
    } catch (error) {
        clearInterval(keepAliveActivity);

        if (streamClosedEarly) {
            return;
        }

        writeEvent({
            type: "error",
            error: error instanceof Error ? error.message : "Failed to run OpenCode prompt stream.",
        });
        res.end();
    }
});

export default router;
