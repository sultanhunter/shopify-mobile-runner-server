import { GoogleGenAI } from "@google/genai";

interface PreviewScreen {
    id: string;
    title: string;
    description: string;
    blocks: string[];
}

interface PreviewModel {
    appName: string;
    theme: "light" | "dark";
    primaryColor: string;
    screens: PreviewScreen[];
}

interface ShopifyMobileAiRequest {
    projectId: string;
    prompt: string;
    model?: string;
    preview: PreviewModel;
}

interface ShopifyMobileAiResult {
    summary: string;
    preview: PreviewModel;
}

function normalizePrimaryColor(value: unknown, fallback: string): string {
    if (typeof value !== "string") {
        return fallback;
    }

    const trimmed = value.trim();
    return /^#[0-9a-fA-F]{6}$/.test(trimmed) ? trimmed : fallback;
}

function normalizeScreen(screen: unknown, index: number): PreviewScreen {
    if (!screen || typeof screen !== "object") {
        return {
            id: `screen-${index + 1}`,
            title: `Screen ${index + 1}`,
            description: "",
            blocks: [],
        };
    }

    const raw = screen as Record<string, unknown>;
    const id = typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : `screen-${index + 1}`;
    const title = typeof raw.title === "string" && raw.title.trim() ? raw.title.trim() : id;
    const description = typeof raw.description === "string" ? raw.description.trim() : "";
    const blocks = Array.isArray(raw.blocks)
        ? raw.blocks
            .filter((item): item is string => typeof item === "string")
            .map((item) => item.trim())
            .filter(Boolean)
        : [];

    return {
        id,
        title,
        description,
        blocks: [...new Set(blocks)],
    };
}

function normalizePreview(value: unknown, fallback: PreviewModel): PreviewModel {
    if (!value || typeof value !== "object") {
        return fallback;
    }

    const raw = value as Record<string, unknown>;
    const appName = typeof raw.appName === "string" && raw.appName.trim() ? raw.appName.trim() : fallback.appName;
    const theme = raw.theme === "light" || raw.theme === "dark" ? raw.theme : fallback.theme;
    const rawScreens = Array.isArray(raw.screens)
        ? raw.screens.map((screen, index) => normalizeScreen(screen, index))
        : fallback.screens;

    const dedupedScreens = rawScreens.filter(
        (screen, index, all) => all.findIndex((candidate) => candidate.id === screen.id) === index,
    );

    return {
        appName,
        theme,
        primaryColor: normalizePrimaryColor(raw.primaryColor, fallback.primaryColor),
        screens: dedupedScreens.length > 0 ? dedupedScreens : fallback.screens,
    };
}

function buildPrompt(input: ShopifyMobileAiRequest): string {
    return [
        "You are editing an Expo Shopify mobile app preview model.",
        "Return STRICT JSON only.",
        "Output format:",
        "{\"summary\":\"string\",\"preview\":{\"appName\":\"string\",\"theme\":\"light|dark\",\"primaryColor\":\"#RRGGBB\",\"screens\":[{\"id\":\"string\",\"title\":\"string\",\"description\":\"string\",\"blocks\":[\"string\"]}]}}",
        "Rules:",
        "- Keep useful existing screens unless user explicitly asks to remove.",
        "- Summary must be one short sentence.",
        "- Primary color must stay in #RRGGBB format.",
        "Current preview:",
        JSON.stringify(input.preview),
        "User prompt:",
        input.prompt,
    ].join("\n");
}

function extractJsonObject(rawText: string): Record<string, unknown> {
    const text = rawText.trim();
    if (!text) {
        throw new Error("Vertex returned an empty response.");
    }

    try {
        return JSON.parse(text) as Record<string, unknown>;
    } catch {
        const fenced = text.match(/```json\s*([\s\S]*?)```/i) ?? text.match(/```\s*([\s\S]*?)```/i);
        if (fenced?.[1]) {
            return JSON.parse(fenced[1]) as Record<string, unknown>;
        }

        const firstBrace = text.indexOf("{");
        const lastBrace = text.lastIndexOf("}");
        if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
            throw new Error("Vertex did not return a valid JSON object.");
        }

        return JSON.parse(text.slice(firstBrace, lastBrace + 1)) as Record<string, unknown>;
    }
}

function getVertexApiKey(): string {
    const key = process.env.VERTEX_API_KEY ?? process.env.GOOGLE_CLOUD_API_KEY;
    if (!key) {
        throw new Error("Missing VERTEX_API_KEY (or GOOGLE_CLOUD_API_KEY) on Node server.");
    }

    return key;
}

export async function generateShopifyMobilePreviewUpdate(
    input: ShopifyMobileAiRequest,
): Promise<ShopifyMobileAiResult> {
    const ai = new GoogleGenAI({
        apiKey: getVertexApiKey(),
    });

    const model =
        input.model?.trim() || process.env.VERTEX_MODEL || process.env.LLM_MODEL || "gemini-3.1-flash-lite-preview";

    const response = await ai.models.generateContent({
        model,
        contents: [
            {
                role: "user",
                parts: [{ text: buildPrompt(input) }],
            },
        ],
        config: {
            maxOutputTokens: 65535,
            temperature: 0.6,
            topP: 0.95,
            responseMimeType: "application/json",
            thinkingConfig: {
                thinkingBudget: 1024,
            },
        },
    });

    const parsed = extractJsonObject(response.text ?? "");
    const preview = normalizePreview(parsed.preview, input.preview);
    const summary =
        typeof parsed.summary === "string" && parsed.summary.trim()
            ? parsed.summary.trim()
            : "Updated the app preview based on your request.";

    return {
        summary,
        preview,
    };
}
