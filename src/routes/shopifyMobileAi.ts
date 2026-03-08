import { Request, Response, Router } from "express";
import { generateShopifyMobilePreviewUpdate } from "../services/shopifyMobileAi.js";

interface GeneratePreviewBody {
    projectId?: unknown;
    prompt?: unknown;
    model?: unknown;
    preview?: unknown;
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

export default router;
