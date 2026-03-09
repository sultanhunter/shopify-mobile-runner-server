import { ChildProcess, execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { access, constants, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const execFileAsync = promisify(execFile);
const BINARY_BASE64_PREFIX = "__binary_base64__:";
const PERSISTENT_PROJECTS_ROOT = "/var/shopify-mobile/projects";
const DEFAULT_OPENCODE_AGENT = "shopify-app-builder";
const MAX_SYNCED_FILE_BYTES = 1000000;
const PROCESS_IDLE_TIMEOUT_MS = 10 * 60 * 1000;

interface PersistedSessionState {
    projectId: string;
    repoUrl: string;
    branch: string;
    sessionId: string;
    workspacePath: string;
    repoPath: string;
    agent: string;
    updatedAt: string;
}

interface OpenCodePromptInput {
    projectId: string;
    repoUrl: string;
    branch?: string;
    prompt: string;
    model?: string;
    thinking?: string;
}

interface OpenCodePromptResult {
    summary: string;
    sessionId: string;
    workspacePath: string;
    repoPath: string;
    agent: string;
    changedFiles: string[];
    files: Record<string, string>;
}

type OpenCodeEvent = Record<string, unknown>;

const activeSessions = new Map<string, PersistedSessionState>();
const projectLocks = new Map<string, Promise<void>>();
const activeOpenCodeRuns = new Map<string, ChildProcess>();

function nowIso(): string {
    return new Date().toISOString();
}

function sanitizeProjectId(value: string): string {
    const cleaned = value.trim().replace(/[^a-zA-Z0-9_-]+/g, "-");
    return cleaned.length > 0 ? cleaned.slice(0, 120) : "project";
}

function getProjectsRoot(): string {
    return PERSISTENT_PROJECTS_ROOT;
}

function getAgentName(): string {
    return DEFAULT_OPENCODE_AGENT;
}

function normalizeModelId(value: string | undefined): string | undefined {
    const trimmed = value?.trim();
    if (!trimmed) return undefined;
    if (trimmed.includes("/")) return trimmed;
    return trimmed.startsWith("gpt-") ? `openai/${trimmed}` : trimmed;
}

function normalizeThinkingVariant(value: string | undefined): string | undefined {
    const normalized = value?.trim().toLowerCase();
    if (!normalized) return undefined;

    if (normalized === "xhigh") return "max";
    if (normalized === "low" || normalized === "medium" || normalized === "high" || normalized === "max") {
        return normalized;
    }

    return undefined;
}

function getMaxSyncedFileBytes(): number {
    return MAX_SYNCED_FILE_BYTES;
}

function workspacePathForProject(projectId: string): string {
    return path.join(getProjectsRoot(), sanitizeProjectId(projectId));
}

function repoPathForWorkspace(workspacePath: string): string {
    return path.join(workspacePath, "repo");
}

function sessionStatePath(workspacePath: string): string {
    return path.join(workspacePath, "opencode-session.json");
}

async function pathExists(targetPath: string): Promise<boolean> {
    try {
        await access(targetPath, constants.F_OK);
        return true;
    } catch {
        return false;
    }
}

function getGithubToken(): string | undefined {
    return process.env.SHOPIFY_MOBILE_GITHUB_TOKEN?.trim() || process.env.GITHUB_TOKEN?.trim() || undefined;
}

function withGithubToken(repoUrl: string): string {
    const token = getGithubToken();
    if (!token) return repoUrl;

    try {
        const parsed = new URL(repoUrl);
        if (parsed.protocol !== "https:" || parsed.hostname !== "github.com") {
            return repoUrl;
        }

        parsed.username = "x-access-token";
        parsed.password = token;
        return parsed.toString();
    } catch {
        return repoUrl;
    }
}

async function runCommand(command: string, args: string[], cwd?: string, timeoutMs = 120000): Promise<{
    stdout: string;
    stderr: string;
}> {
    try {
        return await execFileAsync(command, args, {
            cwd,
            timeout: timeoutMs,
            maxBuffer: 50 * 1024 * 1024,
            env: {
                ...process.env,
                OPENCODE_CLIENT: "shopify-mobile-runner",
            },
        });
    } catch (error) {
        const cast = error as Error & { stdout?: string; stderr?: string };
        const details = [
            `Command failed: ${command} ${args.join(" ")}`,
            cast.message,
            cast.stderr?.trim() || cast.stdout?.trim() || "",
        ]
            .filter(Boolean)
            .join("\n");

        throw new Error(details);
    }
}

async function ensureRepo(input: {
    projectId: string;
    repoUrl: string;
    branch: string;
}): Promise<{ workspacePath: string; repoPath: string }> {
    const workspacePath = workspacePathForProject(input.projectId);
    const repoPath = repoPathForWorkspace(workspacePath);
    await mkdir(workspacePath, { recursive: true });

    const gitDir = path.join(repoPath, ".git");
    if (!(await pathExists(gitDir))) {
        await runCommand(
            "git",
            ["clone", "--single-branch", "--branch", input.branch, withGithubToken(input.repoUrl), repoPath],
            workspacePath,
            600000,
        );
        return { workspacePath, repoPath };
    }

    const status = await runCommand("git", ["status", "--porcelain"], repoPath, 30000);
    if (status.stdout.trim()) {
        return { workspacePath, repoPath };
    }

    await runCommand("git", ["fetch", "origin", input.branch], repoPath, 180000).catch(() => null);
    await runCommand("git", ["checkout", input.branch], repoPath, 30000).catch(() => null);
    await runCommand("git", ["pull", "--ff-only", "origin", input.branch], repoPath, 180000).catch(() => null);

    return { workspacePath, repoPath };
}

function buildAgentFileContent(): string {
    return [
        "---",
        "description: Builds and updates Shopify mobile Expo apps for this repository",
        "mode: primary",
        "temperature: 0.2",
        "tools:",
        "  bash: true",
        "  read: true",
        "  list: true",
        "  glob: true",
        "  grep: true",
        "  write: true",
        "  edit: true",
        "  todowrite: true",
        "permission:",
        "  edit: allow",
        "  bash:",
        "    \"*\": allow",
        "---",
        "You are the Shopify App Builder agent for this repository.",
        "",
        "Your job:",
        "- Build and evolve an Expo (React Native) Shopify storefront app.",
        "- Keep changes production-minded, minimal, and coherent with existing code style.",
        "- Prioritize mobile UX, Shopify API integration safety, and reliable build behavior.",
        "",
        "Execution rules:",
        "- Prefer editing existing files over large rewrites.",
        "- Run focused checks after changes (type checks/tests/build when relevant).",
        "- Avoid introducing unrelated refactors.",
        "- Never add secrets to code or committed files.",
        "",
        "Response style:",
        "- Briefly describe what you changed and why.",
        "- Mention modified file paths explicitly.",
    ].join("\n");
}

async function ensureAgentFile(repoPath: string): Promise<void> {
    const agentDir = path.join(repoPath, ".opencode", "agents");
    await mkdir(agentDir, { recursive: true });

    const agentPath = path.join(agentDir, `${getAgentName()}.md`);
    await writeFile(agentPath, buildAgentFileContent(), "utf8");
}

async function loadPersistedSession(workspacePath: string): Promise<PersistedSessionState | null> {
    try {
        const raw = await readFile(sessionStatePath(workspacePath), "utf8");
        const parsed = JSON.parse(raw) as Partial<PersistedSessionState>;

        if (
            typeof parsed.projectId === "string" &&
            typeof parsed.repoUrl === "string" &&
            typeof parsed.branch === "string" &&
            typeof parsed.sessionId === "string" &&
            typeof parsed.workspacePath === "string" &&
            typeof parsed.repoPath === "string" &&
            typeof parsed.agent === "string" &&
            typeof parsed.updatedAt === "string"
        ) {
            return parsed as PersistedSessionState;
        }

        return null;
    } catch {
        return null;
    }
}

async function savePersistedSession(state: PersistedSessionState): Promise<void> {
    await writeFile(sessionStatePath(state.workspacePath), JSON.stringify(state, null, 2), "utf8");
}

async function withProjectLock<T>(projectId: string, work: () => Promise<T>): Promise<T> {
    const previous = projectLocks.get(projectId) ?? Promise.resolve();
    let releaseLock!: () => void;
    const lock = new Promise<void>((resolve) => {
        releaseLock = resolve;
    });
    const chain = previous.then(() => lock);
    projectLocks.set(projectId, chain);

    await previous;

    try {
        return await work();
    } finally {
        releaseLock();
        if (projectLocks.get(projectId) === chain) {
            projectLocks.delete(projectId);
        }
    }
}

function parseRunJsonOutput(stdout: string): {
    sessionId?: string;
    assistantText: string;
    errors: string[];
} {
    const errors: string[] = [];
    const textParts: string[] = [];
    let sessionId: string | undefined;

    for (const rawLine of stdout.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line.startsWith("{")) {
            continue;
        }

        let parsed: any;
        try {
            parsed = JSON.parse(line);
        } catch {
            continue;
        }

        if (!sessionId && typeof parsed.sessionID === "string") {
            sessionId = parsed.sessionID;
        }

        if (parsed.type === "text") {
            const maybeText = parsed.part?.text;
            if (typeof maybeText === "string" && maybeText.trim()) {
                textParts.push(maybeText.trim());
            }
        }

        if (parsed.type === "error") {
            const message = parsed.error?.data?.message || parsed.error?.name;
            if (typeof message === "string" && message.trim()) {
                errors.push(message.trim());
            }
        }
    }

    return {
        sessionId,
        assistantText: textParts.length > 0 ? textParts[textParts.length - 1] : "Applied updates to the app workspace.",
        errors,
    };
}

async function runOpenCodeJsonCommand(args: string[], cwd: string, onEvent?: (event: OpenCodeEvent) => void): Promise<{
    sessionId?: string;
    assistantText: string;
    errors: string[];
}>;
async function runOpenCodeJsonCommand(
    args: string[],
    cwd: string,
    onEvent: ((event: OpenCodeEvent) => void) | undefined,
    projectId: string,
): Promise<{
    sessionId?: string;
    assistantText: string;
    errors: string[];
}>;
async function runOpenCodeJsonCommand(
    args: string[],
    cwd: string,
    onEvent?: (event: OpenCodeEvent) => void,
    projectId?: string,
): Promise<{
    sessionId?: string;
    assistantText: string;
    errors: string[];
}> {
    return await new Promise((resolve, reject) => {
        const child = spawn("opencode", args, {
            cwd,
            env: {
                ...process.env,
                OPENCODE_CLIENT: "shopify-mobile-runner",
            },
            stdio: ["ignore", "pipe", "pipe"],
        });

        let stdout = "";
        let stderr = "";
        let streamBuffer = "";
        let idleTimeout: NodeJS.Timeout | null = null;
        let killedByIdleTimeout = false;

        const clearIdleTimeout = () => {
            if (idleTimeout) {
                clearTimeout(idleTimeout);
                idleTimeout = null;
            }
        };

        const resetIdleTimeout = () => {
            clearIdleTimeout();

            idleTimeout = setTimeout(() => {
                killedByIdleTimeout = true;

                try {
                    child.kill("SIGTERM");
                } catch {
                    // Ignore if already exited.
                }

                setTimeout(() => {
                    if (child.exitCode === null) {
                        try {
                            child.kill("SIGKILL");
                        } catch {
                            // Ignore if already exited.
                        }
                    }
                }, 5000).unref();
            }, PROCESS_IDLE_TIMEOUT_MS);

            idleTimeout.unref();
        };

        if (projectId) {
            activeOpenCodeRuns.set(projectId, child);
        }

        const clearActiveRun = () => {
            if (!projectId) return;

            const active = activeOpenCodeRuns.get(projectId);
            if (active === child) {
                activeOpenCodeRuns.delete(projectId);
            }
        };

        resetIdleTimeout();

        if (child.stdout) {
            child.stdout.on("data", (chunk: Buffer | string) => {
                const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
                stdout += text;
                resetIdleTimeout();

                if (!onEvent) {
                    return;
                }

                streamBuffer += text;
                const lines = streamBuffer.split(/\r?\n/);
                streamBuffer = lines.pop() ?? "";
                for (const rawLine of lines) {
                    const line = rawLine.trim();
                    if (!line.startsWith("{")) continue;

                    try {
                        const parsed = JSON.parse(line) as OpenCodeEvent;
                        onEvent(parsed);
                    } catch {
                        // Ignore partial or malformed lines in stream callbacks.
                    }
                }
            });
        }

        if (child.stderr) {
            child.stderr.on("data", (chunk: Buffer | string) => {
                stderr += typeof chunk === "string" ? chunk : chunk.toString("utf8");
                resetIdleTimeout();
            });
        }

        child.on("error", (error) => {
            clearIdleTimeout();
            clearActiveRun();
            reject(error);
        });

        child.on("close", (code) => {
            clearIdleTimeout();
            clearActiveRun();

            const trailing = streamBuffer.trim();
            if (onEvent && trailing.startsWith("{")) {
                try {
                    onEvent(JSON.parse(trailing) as OpenCodeEvent);
                } catch {
                    // Ignore malformed trailing event line.
                }
            }

            const parsed = parseRunJsonOutput(stdout);
            if (killedByIdleTimeout) {
                parsed.errors.push(
                    `OpenCode run was stopped after ${Math.round(
                        PROCESS_IDLE_TIMEOUT_MS / 60000,
                    )} minutes of inactivity. Send another prompt to continue.`,
                );
            }

            if (code !== 0 && parsed.errors.length === 0) {
                const fallback = stderr.trim() || `OpenCode exited with code ${code}.`;
                parsed.errors.push(fallback);
            }

            resolve(parsed);
        });
    });
}

function terminateOpenCodeProcess(processRef: ChildProcess): boolean {
    const pid = processRef.pid;
    let signaled = false;

    if (process.platform !== "win32" && typeof pid === "number") {
        try {
            process.kill(-pid, "SIGTERM");
            signaled = true;
        } catch {
            // Fall through to direct child kill.
        }
    }

    try {
        processRef.kill("SIGTERM");
        signaled = true;
    } catch {
        // Ignore if already exited.
    }

    setTimeout(() => {
        if (processRef.exitCode !== null) {
            return;
        }

        if (process.platform !== "win32" && typeof pid === "number") {
            try {
                process.kill(-pid, "SIGKILL");
            } catch {
                // Fall through.
            }
        }

        try {
            processRef.kill("SIGKILL");
        } catch {
            // Ignore if already exited.
        }
    }, 5000).unref();

    return signaled;
}

export function listActiveOpenCodeRunProjectIds(): string[] {
    return [...activeOpenCodeRuns.keys()];
}

export function stopOpenCodeRunForProject(projectId: string, reason: string): boolean {
    const processRef = activeOpenCodeRuns.get(projectId);
    if (!processRef) {
        return false;
    }

    const signaled = terminateOpenCodeProcess(processRef);
    if (signaled) {
        console.log(`[OPENCODE][${projectId}] run stopped: ${reason}`);
    }

    return signaled;
}

export function stopOpenCodeRunsForProjects(projectIds: string[], reason: string): number {
    let stopped = 0;
    for (const projectId of projectIds) {
        if (stopOpenCodeRunForProject(projectId, reason)) {
            stopped += 1;
        }
    }

    return stopped;
}

function parseGitStatusPaths(stdout: string): string[] {
    const paths = new Set<string>();

    for (const rawLine of stdout.split(/\r?\n/)) {
        if (!rawLine.trim()) continue;

        const candidate = rawLine.slice(3).trim();
        if (!candidate) continue;

        const resolved = candidate.includes(" -> ") ? candidate.split(" -> ").pop() ?? candidate : candidate;
        const normalized = resolved.replace(/\\/g, "/");
        if (normalized) {
            paths.add(normalized);
        }
    }

    return [...paths];
}

function isBinaryBuffer(buffer: Buffer): boolean {
    const sampleSize = Math.min(buffer.length, 4096);
    for (let index = 0; index < sampleSize; index += 1) {
        if (buffer[index] === 0) {
            return true;
        }
    }

    return false;
}

async function collectFileMap(repoPath: string, changedFiles: string[]): Promise<Record<string, string>> {
    const files: Record<string, string> = {};
    const maxBytes = getMaxSyncedFileBytes();

    for (const relativePath of changedFiles) {
        const absolutePath = path.join(repoPath, relativePath);
        if (!absolutePath.startsWith(repoPath)) {
            continue;
        }

        try {
            const fileStat = await stat(absolutePath);
            if (!fileStat.isFile() || fileStat.size > maxBytes) {
                continue;
            }

            const buffer = await readFile(absolutePath);
            files[relativePath] = isBinaryBuffer(buffer)
                ? `${BINARY_BASE64_PREFIX}${buffer.toString("base64")}`
                : buffer.toString("utf8");
        } catch {
            // File might have been deleted or moved; skip.
        }
    }

    return files;
}

function getExistingSession(projectId: string, workspacePath: string): PersistedSessionState | null {
    const inMemory = activeSessions.get(projectId);
    if (!inMemory) {
        return null;
    }

    return inMemory.workspacePath === workspacePath ? inMemory : null;
}

export async function runShopifyOpenCodePrompt(input: OpenCodePromptInput): Promise<OpenCodePromptResult> {
    return withProjectLock(input.projectId, () => runShopifyOpenCodePromptInternal(input));
}

export async function streamShopifyOpenCodePrompt(
    input: OpenCodePromptInput,
    onEvent: (event: OpenCodeEvent) => void,
): Promise<OpenCodePromptResult> {
    return withProjectLock(input.projectId, () => runShopifyOpenCodePromptInternal(input, onEvent));
}

async function runShopifyOpenCodePromptInternal(
    input: OpenCodePromptInput,
    onEvent?: (event: OpenCodeEvent) => void,
): Promise<OpenCodePromptResult> {
    const branch = input.branch?.trim() || "main";
    const agent = getAgentName();
    const model = normalizeModelId(input.model);
    const variant = normalizeThinkingVariant(input.thinking);

    const { workspacePath, repoPath } = await ensureRepo({
        projectId: input.projectId,
        repoUrl: input.repoUrl,
        branch,
    });

    await ensureAgentFile(repoPath);

    const persisted = await loadPersistedSession(workspacePath);
    const current = getExistingSession(input.projectId, workspacePath) ?? persisted;

    const args = ["run", "--format", "json", "--dir", repoPath, "--agent", agent];
    if (current?.sessionId) {
        args.push("--session", current.sessionId);
    }

    if (model) {
        args.push("--model", model);
    }

    if (variant) {
        args.push("--variant", variant);
    }

    args.push(input.prompt);

    const parsed = await runOpenCodeJsonCommand(args, repoPath, onEvent, input.projectId);

    if (parsed.errors.length > 0) {
        throw new Error(parsed.errors.join(" | "));
    }

    const sessionId = parsed.sessionId || current?.sessionId;
    if (!sessionId) {
        throw new Error("OpenCode did not return a session ID.");
    }

    const state: PersistedSessionState = {
        projectId: input.projectId,
        repoUrl: input.repoUrl,
        branch,
        sessionId,
        workspacePath,
        repoPath,
        agent,
        updatedAt: nowIso(),
    };

    activeSessions.set(input.projectId, state);
    await savePersistedSession(state);

    const status = await runCommand("git", ["status", "--porcelain"], repoPath);
    const changedFiles = parseGitStatusPaths(status.stdout);
    const files = await collectFileMap(repoPath, changedFiles);

    return {
        summary: parsed.assistantText,
        sessionId,
        workspacePath,
        repoPath,
        agent,
        changedFiles,
        files,
    };
}
