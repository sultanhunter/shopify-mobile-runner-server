import { Request, Response, Router } from "express";
import { generateExpoSdk55Scaffold } from "../services/expoScaffold.js";

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

router.post("/shopify-mobile/scaffold-expo", async (req: Request, res: Response) => {
    const requiredToken = process.env.SHOPIFY_MOBILE_AI_SERVER_TOKEN?.trim();
    const token = bearerToken(req.headers.authorization);

    if (requiredToken && token !== requiredToken) {
        return res.status(401).json({ error: "Unauthorized" });
    }

    const projectName = asNonEmptyString(req.body?.projectName);
    if (!projectName) {
        return res.status(400).json({ error: "projectName is required." });
    }

    try {
        const scaffold = await generateExpoSdk55Scaffold(projectName);
        return res.json(scaffold);
    } catch (error) {
        return res.status(500).json({
            error: error instanceof Error ? error.message : "Failed to generate Expo scaffold.",
        });
    }
});

export default router;
