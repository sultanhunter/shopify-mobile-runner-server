const USER_IDLE_TIMEOUT_MS = Number(process.env.SHOPIFY_MOBILE_USER_IDLE_TIMEOUT_MS ?? "600000");

const projectActivity = new Map<string, number>();

function nowMs(): number {
    return Date.now();
}

function safeTimeoutMs(): number {
    return Number.isFinite(USER_IDLE_TIMEOUT_MS) && USER_IDLE_TIMEOUT_MS > 0 ? USER_IDLE_TIMEOUT_MS : 600000;
}

export function markProjectActivity(projectId: string, source?: string): void {
    if (!projectId?.trim()) {
        return;
    }

    const normalized = projectId.trim();
    projectActivity.set(normalized, nowMs());

    if ((process.env.SERVER_REQUEST_LOGS ?? "true").toLowerCase() !== "false" && source) {
        // Keep this low-noise; only debug when explicitly needed.
    }
}

export function collectIdleProjectIds(activeProjectIds: string[]): string[] {
    const current = nowMs();
    const timeoutMs = safeTimeoutMs();
    const active = new Set(activeProjectIds.filter(Boolean));
    const idle: string[] = [];

    for (const projectId of active) {
        const last = projectActivity.get(projectId);

        if (!last) {
            projectActivity.set(projectId, current);
            continue;
        }

        if (current - last >= timeoutMs) {
            idle.push(projectId);
        }
    }

    for (const projectId of projectActivity.keys()) {
        if (!active.has(projectId)) {
            projectActivity.delete(projectId);
        }
    }

    return idle;
}

export function getUserIdleTimeoutMs(): number {
    return safeTimeoutMs();
}
