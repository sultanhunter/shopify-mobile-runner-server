import { Request, Response, Router } from "express";
import { provisionRuntimeDatabase } from "../services/runtimeDatabase.js";

interface ProvisionRuntimeDatabaseBody {
    projectId?: unknown;
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

function authorizeRequest(req: Request, res: Response): boolean {
    const requiredToken = process.env.RUNNER_SERVER_TOKEN?.trim() || process.env.SHOPIFY_MOBILE_AI_SERVER_TOKEN?.trim();
    const token = bearerToken(req.headers.authorization);

    if (requiredToken && token !== requiredToken) {
        res.status(401).json({ error: "Unauthorized" });
        return false;
    }

    return true;
}

const router = Router();

router.post("/shopify-mobile/runtime-db/provision", async (req: Request, res: Response) => {
    if (!authorizeRequest(req, res)) {
        return;
    }

    const body = req.body as ProvisionRuntimeDatabaseBody;
    const projectId = asNonEmptyString(body.projectId);
    if (!projectId) {
        return res.status(400).json({ error: "projectId is required." });
    }

    try {
        const runtimeDatabase = await provisionRuntimeDatabase(projectId);
        return res.json({ runtimeDatabase });
    } catch (error) {
        const message =
            error instanceof Error && error.message.trim().length > 0
                ? error.message.trim()
                : "Failed to provision runtime database.";

        return res.status(500).json({
            error: message,
        });
    }
});

export default router;
