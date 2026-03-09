import { Request, Response, Router } from "express";
import { getDefaultExpoSdk, resolveExpoSupportVersion } from "../services/expoSupportMatrix.js";
import { enqueueCreateWorkspaceTask } from "../services/workspaceTask.js";

interface CreateWorkspaceTaskBody {
    name?: unknown;
    sdk?: unknown;
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
    const requiredToken = process.env.SHOPIFY_MOBILE_AI_SERVER_TOKEN?.trim();
    const token = bearerToken(req.headers.authorization);

    if (requiredToken && token !== requiredToken) {
        res.status(401).json({ error: "Unauthorized" });
        return false;
    }

    return true;
}

const router = Router();

router.post("/shopify-mobile/tasks/workspace/create", async (req: Request, res: Response) => {
    if (!authorizeRequest(req, res)) {
        return;
    }

    const body = req.body as CreateWorkspaceTaskBody;
    const name = asNonEmptyString(body.name);
    const sdk = asNonEmptyString(body.sdk) ?? getDefaultExpoSdk();

    if (!name) {
        return res.status(400).json({ error: "name is required." });
    }

    try {
        const resolved = resolveExpoSupportVersion(sdk);
        const task = await enqueueCreateWorkspaceTask({
            name,
            sdk: resolved.sdk,
        });

        console.log(
            `[TASK ${task.id}] accepted workspace.create name=${name} requestedSdk=${sdk} resolvedSdk=${resolved.sdk}`,
        );

        return res.status(202).json({ task });
    } catch (error) {
        return res.status(500).json({
            error: error instanceof Error ? error.message : "Failed to enqueue workspace creation task.",
        });
    }
});

export default router;
