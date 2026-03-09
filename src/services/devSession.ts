import { ChildProcess, execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const BINARY_BASE64_PREFIX = "__binary_base64__:";
const DEV_WORKSPACES_ROOT = "/var/shopify-mobile/dev-workspaces";
const SHARED_PROJECTS_ROOT = "/var/shopify-mobile/projects";
const LEGACY_DEV_WORKSPACES_ROOT = "/tmp/shopify-mobile-dev-workspaces";
const EXPO_DEFAULT_PORT = 8081;

export type DevSessionStatus = "starting" | "ready" | "failed" | "stopped";

export interface StartDevSessionInput {
    projectId: string;
    repoUrl: string;
    branch?: string;
    install?: boolean;
    useTunnel?: boolean;
}

export interface ApplyAndPushInput {
    files?: Record<string, string>;
    commitMessage?: string;
    runInstall?: boolean;
}

export interface DevSessionPublic {
    id: string;
    projectId: string;
    repoUrl: string;
    branch: string;
    status: DevSessionStatus;
    createdAt: string;
    updatedAt: string;
    workspacePath: string;
    repoPath: string;
    packageManager: string;
    installCommand: string;
    expoUrl?: string;
    webUrl?: string;
    error?: string;
    logs: string[];
}

interface PackageManagerInstallCommand {
    packageManager: string;
    command: string;
    args: string[];
}

interface DevSessionInternal {
    id: string;
    projectId: string;
    repoUrl: string;
    branch: string;
    status: DevSessionStatus;
    createdAt: string;
    updatedAt: string;
    workspacePath: string;
    repoPath: string;
    packageManager: string;
    installCommand: string;
    expoUrl?: string;
    webUrl?: string;
    error?: string;
    logs: string[];
    expoProcess?: ChildProcess;
    webWarmupStatus?: "running" | "completed" | "failed";
    stopRequested?: boolean;
    expoUrlBackfillInFlight?: boolean;
    expoUrlBackfillAttempts?: number;
}

const sessions = new Map<string, DevSessionInternal>();
const DEFAULT_LOG_LIMIT = Number(process.env.SHOPIFY_MOBILE_DEV_LOG_LIMIT ?? "500");
const LOG_ERRORS_TO_STDOUT = (process.env.SHOPIFY_MOBILE_VERBOSE_LOGS ?? "true").toLowerCase() !== "false";
const ENABLE_WEB_WARMUP = (process.env.SHOPIFY_MOBILE_WEB_WARMUP ?? "false").toLowerCase() === "true";
const EXPO_URL_BACKFILL_INTERVAL_MS = 2000;
const EXPO_URL_BACKFILL_MAX_ATTEMPTS = 30;

function nowIso(): string {
    return new Date().toISOString();
}

function isActiveSessionStatus(status: DevSessionStatus): boolean {
    return status === "starting" || status === "ready";
}

function redactSecrets(value: string): string {
    return value
        .replace(/(x-access-token:)[^@\s]+@/g, "$1***@")
        .replace(/ghp_[A-Za-z0-9_]+/g, "ghp_***")
        .replace(/github_pat_[A-Za-z0-9_]+/g, "github_pat_***");
}

function getWorkspacesRoot(): string {
    return DEV_WORKSPACES_ROOT;
}

function sanitizeProjectId(value: string): string {
    const cleaned = value.trim().replace(/[^a-zA-Z0-9_-]+/g, "-");
    return cleaned.length > 0 ? cleaned.slice(0, 120) : "project";
}

function appendLog(session: DevSessionInternal, line: string) {
    const normalized = redactSecrets(line.replace(/\u001b\[[0-9;]*m/g, "").trimEnd());
    if (!normalized) return;

    session.logs.push(`${new Date().toISOString()} ${normalized}`);
    if (session.logs.length > DEFAULT_LOG_LIMIT) {
        session.logs = session.logs.slice(session.logs.length - DEFAULT_LOG_LIMIT);
    }

    if (LOG_ERRORS_TO_STDOUT && (/\berror\b/i.test(normalized) || /\bfailed\b/i.test(normalized))) {
        console.warn(`[DEV_SESSION][${session.id}] ${normalized}`);
    }
}

function logSessionEvent(session: DevSessionInternal, message: string) {
    console.log(`[DEV_SESSION][${session.id}][${session.projectId}] ${message}`);
}

function updateSession(session: DevSessionInternal, patch: Partial<DevSessionInternal>) {
    Object.assign(session, patch, { updatedAt: nowIso() });
}

function isStopRequested(session: DevSessionInternal): boolean {
    return session.stopRequested === true || session.status === "stopped";
}

function toPublicSession(session: DevSessionInternal, logLines: number): DevSessionPublic {
    const safeLogLines = Number.isFinite(logLines) && logLines > 0 ? Math.min(logLines, 500) : 200;

    return {
        id: session.id,
        projectId: session.projectId,
        repoUrl: session.repoUrl,
        branch: session.branch,
        status: session.status,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        workspacePath: session.workspacePath,
        repoPath: session.repoPath,
        packageManager: session.packageManager,
        installCommand: session.installCommand,
        expoUrl: session.expoUrl,
        webUrl: session.webUrl,
        error: session.error,
        logs: session.logs.slice(-safeLogLines),
    };
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

async function pathExists(targetPath: string): Promise<boolean> {
    try {
        await stat(targetPath);
        return true;
    } catch {
        return false;
    }
}

async function detectInstallCommand(repoPath: string): Promise<PackageManagerInstallCommand> {
    if (await pathExists(path.join(repoPath, "pnpm-lock.yaml"))) {
        return {
            packageManager: "pnpm",
            command: "pnpm",
            args: ["install", "--frozen-lockfile"],
        };
    }

    if (await pathExists(path.join(repoPath, "yarn.lock"))) {
        return {
            packageManager: "yarn",
            command: "yarn",
            args: ["install", "--frozen-lockfile"],
        };
    }

    if (await pathExists(path.join(repoPath, "bun.lockb")) || await pathExists(path.join(repoPath, "bun.lock"))) {
        return {
            packageManager: "bun",
            command: "bun",
            args: ["install", "--frozen-lockfile"],
        };
    }

    if (await pathExists(path.join(repoPath, "package-lock.json"))) {
        return {
            packageManager: "npm",
            command: "npm",
            args: ["ci"],
        };
    }

    return {
        packageManager: "npm",
        command: "npm",
        args: ["install"],
    };
}

async function runExec(session: DevSessionInternal, command: string, args: string[], opts?: {
    cwd?: string;
    timeoutMs?: number;
    env?: NodeJS.ProcessEnv;
}) {
    appendLog(session, `$ ${command} ${args.join(" ")}`);

    try {
        const result = await execFileAsync(command, args, {
            cwd: opts?.cwd,
            timeout: opts?.timeoutMs ?? 600000,
            maxBuffer: 20 * 1024 * 1024,
            env: {
                ...process.env,
                ...opts?.env,
            },
        });

        if (result.stdout) {
            for (const line of result.stdout.split(/\r?\n/)) {
                appendLog(session, line);
            }
        }

        if (result.stderr) {
            for (const line of result.stderr.split(/\r?\n/)) {
                appendLog(session, line);
            }
        }

        return result;
    } catch (error) {
        const cast = error as Error & { stdout?: string; stderr?: string };
        if (cast.stdout) {
            for (const line of cast.stdout.split(/\r?\n/)) {
                appendLog(session, line);
            }
        }

        if (cast.stderr) {
            for (const line of cast.stderr.split(/\r?\n/)) {
                appendLog(session, line);
            }
        }

        throw error;
    }
}

async function ensureRepoForDevSession(
    session: DevSessionInternal,
    input: StartDevSessionInput,
    timeoutMs: number,
): Promise<void> {
    await mkdir(session.workspacePath, { recursive: true });

    const gitDir = path.join(session.repoPath, ".git");
    if (!(await pathExists(gitDir))) {
        const cloneRepoUrl = withGithubToken(input.repoUrl);
        await runExec(
            session,
            "git",
            ["clone", "--single-branch", "--branch", session.branch, cloneRepoUrl, session.repoPath],
            { timeoutMs },
        );
        return;
    }

    const status = await runExec(session, "git", ["status", "--porcelain"], {
        cwd: session.repoPath,
        timeoutMs: 30000,
    });

    if (status.stdout.trim()) {
        appendLog(session, "Reusing existing repo with local changes; skipping pull.");
        return;
    }

    await runExec(session, "git", ["fetch", "origin", session.branch], {
        cwd: session.repoPath,
        timeoutMs: 180000,
    });
    await runExec(session, "git", ["checkout", session.branch], {
        cwd: session.repoPath,
        timeoutMs: 30000,
    });
    await runExec(session, "git", ["pull", "--ff-only", "origin", session.branch], {
        cwd: session.repoPath,
        timeoutMs: 180000,
    });
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function isProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

async function listListeningPidsOnPort(port: number): Promise<number[]> {
    try {
        const result = await execFileAsync("lsof", ["-nP", "-ti", `tcp:${String(port)}`], {
            timeout: 15000,
            maxBuffer: 5 * 1024 * 1024,
        });

        return result.stdout
            .split(/\r?\n/)
            .map((line) => Number(line.trim()))
            .filter((pid) => Number.isInteger(pid) && pid > 0);
    } catch {
        return [];
    }
}

async function readProcessCommand(pid: number): Promise<string> {
    try {
        const result = await execFileAsync("ps", ["-o", "command=", "-p", String(pid)], {
            timeout: 10000,
            maxBuffer: 2 * 1024 * 1024,
        });

        return result.stdout.trim();
    } catch {
        return "";
    }
}

function isManagedExpoCommand(command: string): boolean {
    const normalized = command.toLowerCase();
    const looksLikeExpo = normalized.includes(" expo ") || normalized.includes("npx expo") || normalized.includes("@expo");
    const inKnownWorkspace =
        normalized.includes(DEV_WORKSPACES_ROOT.toLowerCase()) ||
        normalized.includes(LEGACY_DEV_WORKSPACES_ROOT.toLowerCase());

    return looksLikeExpo && inKnownWorkspace;
}

async function terminateExternalProcess(pid: number): Promise<void> {
    const killWithFallback = (signal: NodeJS.Signals) => {
        if (process.platform !== "win32") {
            try {
                process.kill(-pid, signal);
                return;
            } catch {
                // Fall through to direct kill.
            }
        }

        try {
            process.kill(pid, signal);
        } catch {
            // Process may have exited already.
        }
    };

    killWithFallback("SIGTERM");
    await delay(1800);

    if (isProcessAlive(pid)) {
        killWithFallback("SIGKILL");
    }
}

async function cleanupResidualExpoProcesses(session: DevSessionInternal): Promise<void> {
    const pids = await listListeningPidsOnPort(EXPO_DEFAULT_PORT);
    if (pids.length === 0) {
        return;
    }

    for (const pid of pids) {
        const command = await readProcessCommand(pid);
        const label = isManagedExpoCommand(command) ? "managed Expo process" : "process";
        appendLog(session, `Stopping stale ${label} pid=${pid} on port ${EXPO_DEFAULT_PORT}.`);
        await terminateExternalProcess(pid);
    }
}

function extractExpoUrl(line: string): string | undefined {
    const exp = line.match(/(exp:\/\/[\w\-./?=&%:+]+)/);
    if (exp?.[1]) return exp[1];

    const http = line.match(/(https?:\/\/[\w\-./?=&%:+]+)/);
    if (http?.[1] && (line.toLowerCase().includes("expo") || line.toLowerCase().includes("tunnel"))) {
        return http[1];
    }

    return undefined;
}

function extractWebUrl(line: string): string | undefined {
    const web = line.match(/(https?:\/\/[\w\-./?=&%:+]+)/);
    if (!web?.[1]) return undefined;

    if (line.toLowerCase().includes("web") || line.toLowerCase().includes("localhost")) {
        return web[1];
    }

    return undefined;
}

function toExpoDeepLink(publicUrl: string): string | null {
    try {
        const parsed = new URL(publicUrl);
        return `exp://${parsed.host}${parsed.pathname}${parsed.search}`;
    } catch {
        return null;
    }
}

async function tryResolveExpoUrlFromNgrokApi(session: DevSessionInternal): Promise<string | null> {
    let targetPort = "8081";
    if (session.webUrl) {
        try {
            targetPort = new URL(session.webUrl).port || "8081";
        } catch {
            targetPort = "8081";
        }
    }

    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 2500);

        const response = await fetch("http://127.0.0.1:4040/api/tunnels", {
            signal: controller.signal,
        });

        clearTimeout(timeout);

        if (!response.ok) {
            return null;
        }

        const payload = (await response.json().catch(() => null)) as
            | {
                tunnels?: Array<{
                    public_url?: string;
                    proto?: string;
                    config?: { addr?: string };
                }>;
            }
            | null;

        const tunnels = payload?.tunnels ?? [];
        const matching = tunnels.find((tunnel) => {
            const addr = tunnel.config?.addr ?? "";
            return addr.includes(`:${targetPort}`) && typeof tunnel.public_url === "string";
        });

        const candidate = matching?.public_url ?? tunnels.find((tunnel) => typeof tunnel.public_url === "string")?.public_url;
        if (!candidate) {
            return null;
        }

        return toExpoDeepLink(candidate);
    } catch {
        return null;
    }
}

function triggerExpoUrlBackfill(session: DevSessionInternal) {
    if (session.expoUrl || session.stopRequested || session.status === "stopped" || session.status === "failed") {
        return;
    }

    if (session.expoUrlBackfillInFlight) {
        return;
    }

    session.expoUrlBackfillInFlight = true;
    session.expoUrlBackfillAttempts = (session.expoUrlBackfillAttempts ?? 0) + 1;
    const currentAttempt = session.expoUrlBackfillAttempts;

    void (async () => {
        const resolved = await tryResolveExpoUrlFromNgrokApi(session);
        session.expoUrlBackfillInFlight = false;

        if (!resolved || session.expoUrl) {
            if (
                !session.expoUrl &&
                !session.stopRequested &&
                session.status !== "stopped" &&
                session.status !== "failed" &&
                currentAttempt < EXPO_URL_BACKFILL_MAX_ATTEMPTS
            ) {
                if (currentAttempt === 1 || currentAttempt % 5 === 0) {
                    appendLog(session, `Waiting for tunnel URL (attempt ${currentAttempt}/${EXPO_URL_BACKFILL_MAX_ATTEMPTS})...`);
                }

                setTimeout(() => triggerExpoUrlBackfill(session), EXPO_URL_BACKFILL_INTERVAL_MS);
            }

            if (currentAttempt >= EXPO_URL_BACKFILL_MAX_ATTEMPTS && !session.expoUrl) {
                appendLog(session, "Could not resolve Expo tunnel URL automatically.");
            }
            return;
        }

        updateSession(session, { expoUrl: resolved });
        appendLog(session, `Resolved Expo URL from tunnel API: ${resolved}`);
        logSessionEvent(session, `resolved expoUrl=${resolved}`);
    })();
}

function tryMarkReadyFromLine(session: DevSessionInternal, line: string) {
  const expoUrl = extractExpoUrl(line);
  if (expoUrl && !session.expoUrl) {
    updateSession(session, { expoUrl });
    }

    const webUrl = extractWebUrl(line);
    if (webUrl && !session.webUrl) {
        updateSession(session, { webUrl });
    }

    if ((session.expoUrl || session.webUrl) && session.status === "starting") {
        updateSession(session, { status: "ready" });
        appendLog(session, "Dev session is ready.");
        logSessionEvent(session, `ready expoUrl=${session.expoUrl ?? "n/a"} webUrl=${session.webUrl ?? "n/a"}`);

        if (!session.expoUrl) {
            triggerExpoUrlBackfill(session);
        }

        if (ENABLE_WEB_WARMUP && session.webUrl && !session.webWarmupStatus) {
            void warmupWebPreview(session);
        }
    }

    if (!session.expoUrl && line.toLowerCase().includes("tunnel ready")) {
        triggerExpoUrlBackfill(session);
    }
}

async function warmupWebPreview(session: DevSessionInternal) {
  if (!session.webUrl || session.webWarmupStatus === "running" || session.webWarmupStatus === "completed") {
    return;
  }

    session.webWarmupStatus = "running";
    appendLog(session, "Warming up Expo web preview bundle...");
    logSessionEvent(session, "web warmup started");

  try {
    const pageResponse = await fetch(new URL("/", session.webUrl).toString(), {
      headers: {
        Accept: "text/html"
      }
    });

    const html = await pageResponse.text();
    if (!pageResponse.ok) {
      throw new Error(`Web warmup page failed with status ${pageResponse.status}`);
    }

    const scriptMatch = html.match(/<script[^>]+src="([^"]+)"/i);
    const scriptPath =
      scriptMatch?.[1] ??
      "/node_modules/expo-router/entry.bundle?platform=web&dev=true&hot=false&lazy=true&transform.engine=hermes&transform.routerRoot=src%2Fapp&unstable_transformProfile=hermes-stable";

    const scriptUrl = new URL(scriptPath, session.webUrl).toString();
    const scriptResponse = await fetch(scriptUrl, {
      headers: {
        Accept: "*/*"
      }
    });

    if (!scriptResponse.ok) {
      throw new Error(`Web warmup bundle failed with status ${scriptResponse.status}`);
    }

    await scriptResponse.arrayBuffer();
    session.webWarmupStatus = "completed";
    appendLog(session, "Expo web preview bundle warmed up.");
    logSessionEvent(session, "web warmup completed");
  } catch (error) {
    session.webWarmupStatus = "failed";
    appendLog(
      session,
      `Expo web warmup failed: ${error instanceof Error ? error.message : "unknown error"}`
    );
    logSessionEvent(session, `web warmup failed: ${error instanceof Error ? error.message : "unknown error"}`);
  }
}

function listenStream(session: DevSessionInternal, stream: NodeJS.ReadableStream, prefix: string) {
    let buffer = "";

    stream.on("data", (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";

        for (const line of lines) {
            const decorated = `[${prefix}] ${line}`;
            appendLog(session, decorated);
            tryMarkReadyFromLine(session, line);
        }
    });

    stream.on("end", () => {
        if (!buffer) return;
        const decorated = `[${prefix}] ${buffer}`;
        appendLog(session, decorated);
        tryMarkReadyFromLine(session, buffer);
        buffer = "";
    });
}

function getExpoStartArgs(useTunnel: boolean): string[] {
    const args = ["expo", "start", "--port", String(EXPO_DEFAULT_PORT)];
    if (useTunnel) {
        args.push("--tunnel");
    }

    const extra = process.env.SHOPIFY_MOBILE_EXPO_START_ARGS?.trim();
    if (extra) {
        args.push(...extra.split(/\s+/).filter(Boolean));
    }

    return args;
}

function getPackageInstallEnv(): NodeJS.ProcessEnv {
    return {
        NODE_ENV: "development",
        NPM_CONFIG_PRODUCTION: "false",
        YARN_PRODUCTION: "false",
        PNPM_PROD: "false",
    };
}

async function ensureNgrokAvailable(session: DevSessionInternal): Promise<boolean> {
    try {
        await runExec(session, "npm", ["ls", "-g", "@expo/ngrok", "--depth=0"], {
            timeoutMs: 60000,
        });
        return true;
    } catch {
        appendLog(session, "@expo/ngrok not found globally. Attempting global install...");
    }

    try {
        await runExec(session, "npm", ["install", "-g", "@expo/ngrok@^4.1.0"], {
            timeoutMs: 240000,
        });
        appendLog(session, "Installed @expo/ngrok globally.");
        return true;
    } catch (error) {
        appendLog(
            session,
            `Could not install @expo/ngrok globally: ${error instanceof Error ? error.message : "unknown error"}`,
        );
        return false;
    }
}

async function bootstrapSession(session: DevSessionInternal, input: StartDevSessionInput) {
    const timeoutMs = Number(process.env.SHOPIFY_MOBILE_DEV_TIMEOUT_MS ?? "900000");

    await cleanupResidualExpoProcesses(session);
    await ensureRepoForDevSession(session, input, timeoutMs);

    if (isStopRequested(session)) {
        appendLog(session, "Stop requested during bootstrap. Aborting before Expo launch.");
        logSessionEvent(session, "bootstrap aborted after repo sync due to stop request");
        return;
    }

    const installCommand = await detectInstallCommand(session.repoPath);
    updateSession(session, {
        packageManager: installCommand.packageManager,
        installCommand: `${installCommand.command} ${installCommand.args.join(" ")}`,
    });

    if (input.install !== false) {
        await runExec(session, installCommand.command, installCommand.args, {
            cwd: session.repoPath,
            timeoutMs,
            env: getPackageInstallEnv(),
        });
    }

    if (isStopRequested(session)) {
        appendLog(session, "Stop requested during bootstrap. Aborting before Expo launch.");
        logSessionEvent(session, "bootstrap aborted after install due to stop request");
        return;
    }

    logSessionEvent(session, `dependencies installed with ${installCommand.command}`);

    let shouldUseTunnel = input.useTunnel !== false;
    if (shouldUseTunnel) {
        const ngrokAvailable = await ensureNgrokAvailable(session);
        if (!ngrokAvailable) {
            shouldUseTunnel = false;
            appendLog(session, "Falling back to Expo start without tunnel.");
        }
    }

    if (isStopRequested(session)) {
        appendLog(session, "Stop requested during bootstrap. Aborting before Expo launch.");
        logSessionEvent(session, "bootstrap aborted before Expo spawn due to stop request");
        return;
    }

    const expoArgs = getExpoStartArgs(shouldUseTunnel);
    appendLog(session, `$ npx ${expoArgs.join(" ")}`);

    const child = spawn("npx", expoArgs, {
        cwd: session.repoPath,
        env: {
            ...process.env,
            NODE_ENV: "development",
        },
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
    });

    session.expoProcess = child;
    if (child.stdout) {
        listenStream(session, child.stdout, "expo");
    }
    if (child.stderr) {
        listenStream(session, child.stderr, "expo-error");
    }

    child.on("exit", (code, signal) => {
        const active = sessions.get(session.id);
        if (!active) return;

        updateSession(active, {
            expoProcess: undefined,
        });

        if (active.status === "stopped") {
            appendLog(active, `Expo process exited after stop (code=${code}, signal=${signal}).`);
            return;
        }

        const message = `Expo process exited unexpectedly (code=${code}, signal=${signal}).`;
        appendLog(active, message);
        logSessionEvent(active, message);
        updateSession(active, {
            status: "failed",
            error: message,
        });
    });
}

function sanitizeRelativePath(filePath: string): string {
    const normalized = path.posix.normalize(filePath).replace(/^\/+/, "");
    if (!normalized || normalized === "." || normalized.startsWith("../") || normalized.includes("\0")) {
        throw new Error(`Invalid file path: ${filePath}`);
    }

    return normalized;
}

async function writeFilesToRepo(repoPath: string, files: Record<string, string>) {
    for (const [relativePath, content] of Object.entries(files)) {
        const safeRelativePath = sanitizeRelativePath(relativePath);
        const absolutePath = path.join(repoPath, safeRelativePath);

        if (!absolutePath.startsWith(repoPath)) {
            throw new Error(`Refusing to write outside repo: ${relativePath}`);
        }

        await mkdir(path.dirname(absolutePath), { recursive: true });
        if (content.startsWith(BINARY_BASE64_PREFIX)) {
            const encoded = content.slice(BINARY_BASE64_PREFIX.length);
            await writeFile(absolutePath, Buffer.from(encoded, "base64"));
            continue;
        }

        await writeFile(absolutePath, content, "utf8");
    }
}

async function stopExpoProcess(session: DevSessionInternal) {
    const processRef = session.expoProcess;
    if (!processRef) return;

    const killProcess = (signal: NodeJS.Signals) => {
        const pid = processRef.pid;

        if (process.platform !== "win32" && typeof pid === "number") {
            try {
                process.kill(-pid, signal);
                return;
            } catch {
                // Fall back to direct child kill below.
            }
        }

        try {
            processRef.kill(signal);
        } catch {
            // Ignore if process already exited.
        }
    };

    killProcess("SIGTERM");

    await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
            killProcess("SIGKILL");
            resolve();
        }, 5000);

        processRef.once("exit", () => {
            clearTimeout(timeout);
            resolve();
        });
    });
}

async function stopSessionInternal(session: DevSessionInternal, reason: string, source: "api" | "auto") {
    updateSession(session, {
        stopRequested: true,
    });

    await stopExpoProcess(session);
    updateSession(session, {
        status: "stopped",
        error: undefined,
        expoProcess: undefined,
        expoUrl: undefined,
        webUrl: undefined,
        expoUrlBackfillInFlight: false,
        expoUrlBackfillAttempts: 0,
    });

    appendLog(session, reason);
    logSessionEvent(session, source === "api" ? "stopped by API request" : `auto-stopped reason=${reason}`);
}

async function stopAllActiveSessions(reason: string) {
    const activeSessions = [...sessions.values()].filter((session) => isActiveSessionStatus(session.status));

    for (const session of activeSessions) {
        await stopSessionInternal(session, `Dev session stopped automatically: ${reason}`, "auto");
    }
}

function gitIdentityEnv(): NodeJS.ProcessEnv {
    return {
        GIT_AUTHOR_NAME: process.env.SHOPIFY_MOBILE_GIT_AUTHOR_NAME || "Shopify Mobile AI",
        GIT_AUTHOR_EMAIL: process.env.SHOPIFY_MOBILE_GIT_AUTHOR_EMAIL || "shopify-mobile-ai@local.dev",
        GIT_COMMITTER_NAME: process.env.SHOPIFY_MOBILE_GIT_COMMITTER_NAME || "Shopify Mobile AI",
        GIT_COMMITTER_EMAIL: process.env.SHOPIFY_MOBILE_GIT_COMMITTER_EMAIL || "shopify-mobile-ai@local.dev",
    };
}

function normalizeProxyTarget(rawUrl: string | undefined): string | null {
    if (!rawUrl) {
        return null;
    }

    try {
        const parsed = new URL(rawUrl);
        if (!parsed.port) {
            return null;
        }

        if (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "0.0.0.0") {
            return `${parsed.protocol}//127.0.0.1:${parsed.port}`;
        }

        return `${parsed.protocol}//${parsed.hostname}:${parsed.port}`;
    } catch {
        return null;
    }
}

export function getDevSession(sessionId: string, logLines = 200): DevSessionPublic | null {
    const session = sessions.get(sessionId);
    if (!session) return null;

    return toPublicSession(session, logLines);
}

export function listDevSessions(logLines = 100): DevSessionPublic[] {
    return [...sessions.values()].map((session) => toPublicSession(session, logLines));
}

export function getDevSessionProxyTarget(sessionId: string): string | null {
    const session = sessions.get(sessionId);
    if (!session) {
        return null;
    }

    return normalizeProxyTarget(session.webUrl);
}

export async function startDevSession(input: StartDevSessionInput): Promise<DevSessionPublic> {
    await stopAllActiveSessions("A new dev session was started.");

    const createdAt = nowIso();
    const id = randomUUID();
    const branch = input.branch?.trim() || "main";
    const workspacePath = path.join(SHARED_PROJECTS_ROOT, sanitizeProjectId(input.projectId));
    const repoPath = path.join(workspacePath, "repo");

    const session: DevSessionInternal = {
        id,
        projectId: input.projectId,
        repoUrl: input.repoUrl,
        branch,
        status: "starting",
        createdAt,
        updatedAt: createdAt,
        workspacePath,
        repoPath,
        packageManager: "unknown",
        installCommand: "pending",
        logs: [],
        stopRequested: false,
        expoUrlBackfillInFlight: false,
        expoUrlBackfillAttempts: 0,
    };

    sessions.set(id, session);
    appendLog(session, "Starting dev session bootstrap...");
    logSessionEvent(session, `created branch=${branch} install=${input.install !== false} useTunnel=${input.useTunnel !== false}`);

    void bootstrapSession(session, input)
        .then(() => {
            if (session.status === "starting") {
                appendLog(session, "Expo process launched. Waiting for connection URLs...");
                logSessionEvent(session, "expo process launched");
            }
        })
        .catch((error) => {
            const message = error instanceof Error ? error.message : "Unknown dev session startup error";
            appendLog(session, `Startup failed: ${message}`);
            logSessionEvent(session, `startup failed: ${message}`);
            updateSession(session, {
                status: "failed",
                error: message,
            });
        });

    return toPublicSession(session, 200);
}

export async function stopDevSession(sessionId: string): Promise<DevSessionPublic | null> {
    const session = sessions.get(sessionId);
    if (!session) return null;

    await stopSessionInternal(session, "Dev session stopped.", "api");

    return toPublicSession(session, 200);
}

export function listActiveDevSessionProjectIds(): string[] {
    const ids = new Set<string>();
    for (const session of sessions.values()) {
        if (isActiveSessionStatus(session.status)) {
            ids.add(session.projectId);
        }
    }

    return [...ids];
}

export async function stopDevSessionsForProjects(projectIds: string[], reason: string): Promise<number> {
    const targets = new Set(projectIds);
    let stopped = 0;

    for (const session of sessions.values()) {
        if (!targets.has(session.projectId) || !isActiveSessionStatus(session.status)) {
            continue;
        }

        await stopSessionInternal(session, `Dev session stopped automatically: ${reason}`, "auto");
        stopped += 1;
    }

    return stopped;
}

export async function applyAndPushDevSessionChanges(
    sessionId: string,
    input: ApplyAndPushInput,
): Promise<{
    session: DevSessionPublic;
    committed: boolean;
    commitSha?: string;
}> {
    const session = sessions.get(sessionId);
    if (!session) {
        throw new Error("Dev session not found.");
    }

    const fileCount = input.files ? Object.keys(input.files).length : 0;
    logSessionEvent(session, `commit started files=${fileCount}`);

    if (input.files && fileCount > 0) {
        await writeFilesToRepo(session.repoPath, input.files);
        appendLog(session, `Applied ${fileCount} file update(s) to local repo.`);
    } else {
        appendLog(session, "Preparing commit from existing AI workspace changes.");
    }

    if (input.runInstall) {
        const installCommand = await detectInstallCommand(session.repoPath);
        await runExec(session, installCommand.command, installCommand.args, {
            cwd: session.repoPath,
            env: getPackageInstallEnv(),
        });
    }

    await runExec(session, "git", ["add", "-A"], { cwd: session.repoPath });
    const gitStatus = await runExec(session, "git", ["status", "--porcelain"], { cwd: session.repoPath });

    if (!gitStatus.stdout.trim()) {
        appendLog(session, "No git changes detected to commit.");
        logSessionEvent(session, "commit detected no changes");
        return {
            session: toPublicSession(session, 200),
            committed: false,
        };
    }

    const commitMessage = input.commitMessage?.trim() || "chore: commit AI workspace updates";
    await runExec(session, "git", ["commit", "-m", commitMessage], {
        cwd: session.repoPath,
        env: gitIdentityEnv(),
    });

    await runExec(session, "git", ["push", "origin", session.branch], {
        cwd: session.repoPath,
    });

    const head = await runExec(session, "git", ["rev-parse", "HEAD"], {
        cwd: session.repoPath,
    });

    const commitSha = head.stdout.trim();
    appendLog(session, `Changes committed and pushed at ${commitSha}.`);
    logSessionEvent(session, `commit completed commit=${commitSha}`);

    return {
        session: toPublicSession(session, 200),
        committed: true,
        commitSha,
    };
}

export function getDevSessionStats() {
    const byStatus: Record<DevSessionStatus, number> = {
        starting: 0,
        ready: 0,
        failed: 0,
        stopped: 0,
    };

    for (const session of sessions.values()) {
        byStatus[session.status] += 1;
    }

    return {
        total: sessions.size,
        byStatus,
    };
}
