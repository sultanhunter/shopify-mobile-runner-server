import { randomBytes } from "node:crypto";
import { Pool } from "pg";

const POSTGRES_IDENTIFIER_MAX_LENGTH = 63;

export interface RuntimeDatabaseProvisionResult {
    provider: string;
    databaseName: string;
    roleName: string;
    databaseUrl: string;
}

export interface RuntimeDatabaseAdminHealth {
    source: "RUNNER_RUNTIME_ADMIN_DATABASE_URL" | "RUNTIME_ADMIN_DATABASE_URL" | "NEON_ADMIN_DATABASE_URL";
    host: string;
    configuredDatabase: string;
    configuredUser: string;
    currentUser: string;
    currentDatabase: string;
    isPoolerHost: boolean;
    rolcreatedb: boolean;
    rolcreaterole: boolean;
}

export interface RuntimeDatabaseAdminTarget {
    source?: RuntimeDatabaseAdminHealth["source"];
    host?: string;
    configuredDatabase?: string;
    configuredUser?: string;
    isPoolerHost?: boolean;
    forceIpv4?: boolean;
    connectionTimeoutMs?: number;
    retryAttempts?: number;
    retryBaseDelayMs?: number;
    error?: string;
}

export interface RuntimeDatabaseExplorerColumn {
    name: string;
    type: string;
}

export interface RuntimeDatabaseExplorerResult {
    tables: string[];
    selectedTable: string | null;
    columns: RuntimeDatabaseExplorerColumn[];
    rows: Array<Record<string, unknown>>;
    rowCount: number;
}

interface PgLikeError {
    code?: string;
    detail?: string;
    hint?: string;
    message?: string;
}

interface AdminCapabilityRow {
    current_user?: string;
    rolcreatedb?: boolean;
    rolcreaterole?: boolean;
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function shouldForceIpv4(): boolean {
    return (process.env.RUNNER_RUNTIME_DB_FORCE_IPV4 ?? "true").toLowerCase() !== "false";
}

function getRuntimeDbConnectionTimeoutMs(): number {
    return parsePositiveInteger(process.env.RUNNER_RUNTIME_DB_CONNECT_TIMEOUT_MS, 12000);
}

function getRuntimeDbRetryAttempts(): number {
    return parsePositiveInteger(process.env.RUNNER_RUNTIME_DB_RETRY_ATTEMPTS, 3);
}

function getRuntimeDbRetryBaseDelayMs(): number {
    return parsePositiveInteger(process.env.RUNNER_RUNTIME_DB_RETRY_BASE_DELAY_MS, 800);
}

function wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientConnectionError(error: unknown): boolean {
    const pgError = error as PgLikeError;
    const code = typeof pgError?.code === "string" ? pgError.code.trim().toUpperCase() : "";
    if (!code) {
        return false;
    }

    return (
        code === "ETIMEDOUT" ||
        code === "ECONNRESET" ||
        code === "ECONNREFUSED" ||
        code === "EHOSTUNREACH" ||
        code === "ENETUNREACH" ||
        code === "EAI_AGAIN" ||
        code === "ENOTFOUND"
    );
}

async function withTransientRetry<T>(operation: () => Promise<T>): Promise<T> {
    const attempts = getRuntimeDbRetryAttempts();
    const baseDelayMs = getRuntimeDbRetryBaseDelayMs();

    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
            return await operation();
        } catch (error) {
            lastError = error;
            const canRetry = attempt < attempts && isTransientConnectionError(error);
            if (!canRetry) {
                throw error;
            }

            await wait(baseDelayMs * attempt);
        }
    }

    throw lastError instanceof Error ? lastError : new Error("Runtime DB operation failed.");
}

function getRuntimeAdminDatabaseConfig(): {
    source: RuntimeDatabaseAdminHealth["source"];
    connectionString: string;
} {
    const runnerValue = process.env.RUNNER_RUNTIME_ADMIN_DATABASE_URL?.trim();
    if (runnerValue) {
        return {
            source: "RUNNER_RUNTIME_ADMIN_DATABASE_URL",
            connectionString: runnerValue,
        };
    }

    const runtimeValue = process.env.RUNTIME_ADMIN_DATABASE_URL?.trim();
    if (runtimeValue) {
        return {
            source: "RUNTIME_ADMIN_DATABASE_URL",
            connectionString: runtimeValue,
        };
    }

    const neonValue = process.env.NEON_ADMIN_DATABASE_URL?.trim();
    if (neonValue) {
        return {
            source: "NEON_ADMIN_DATABASE_URL",
            connectionString: neonValue,
        };
    }

    throw new Error("RUNNER_RUNTIME_ADMIN_DATABASE_URL is required for runtime DB provisioning on runner.");
}

export function getRuntimeAdminDatabaseTarget(): RuntimeDatabaseAdminTarget {
    try {
        const adminConfig = getRuntimeAdminDatabaseConfig();
        const parsed = new URL(adminConfig.connectionString);

        return {
            source: adminConfig.source,
            host: parsed.hostname,
            configuredDatabase: parsed.pathname.replace(/^\//, "") || "(default)",
            configuredUser: parsed.username ? decodeURIComponent(parsed.username) : "(unset)",
            isPoolerHost: isLikelyPooledConnection(adminConfig.connectionString),
            forceIpv4: shouldForceIpv4(),
            connectionTimeoutMs: getRuntimeDbConnectionTimeoutMs(),
            retryAttempts: getRuntimeDbRetryAttempts(),
            retryBaseDelayMs: getRuntimeDbRetryBaseDelayMs(),
        };
    } catch (error) {
        return {
            error: error instanceof Error ? error.message : String(error),
        };
    }
}

function isLikelyPooledConnection(connectionString: string): boolean {
    try {
        const url = new URL(connectionString);
        return url.hostname.includes("-pooler.");
    } catch {
        return false;
    }
}

function getRuntimeDatabasePrefix(): string {
    return (
        process.env.RUNNER_RUNTIME_DATABASE_PREFIX?.trim() ||
        process.env.RUNTIME_DATABASE_PREFIX?.trim() ||
        process.env.NEON_RUNTIME_DATABASE_PREFIX?.trim() ||
        "shopify_runtime_"
    );
}

function getRuntimeRolePrefix(): string {
    return (
        process.env.RUNNER_RUNTIME_ROLE_PREFIX?.trim() ||
        process.env.RUNTIME_ROLE_PREFIX?.trim() ||
        process.env.NEON_RUNTIME_ROLE_PREFIX?.trim() ||
        "shopify_runtime_"
    );
}

function sanitizeIdentifier(input: string, fallbackPrefix: string): string {
    const normalized = input
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .replace(/__+/g, "_");

    const base = normalized || fallbackPrefix;
    const prefixed = /^[a-z_]/.test(base) ? base : `${fallbackPrefix}_${base}`;
    return prefixed.slice(0, POSTGRES_IDENTIFIER_MAX_LENGTH);
}

function buildProjectName(prefix: string, projectId: string, fallbackPrefix: string): string {
    const compactProjectId = projectId
        .replace(/[^a-zA-Z0-9]/g, "")
        .toLowerCase()
        .slice(0, 28);
    const raw = `${prefix}${compactProjectId}`;
    return sanitizeIdentifier(raw, fallbackPrefix);
}

function parseExplorerLimit(input: number | undefined): number {
    if (!Number.isFinite(input) || !input || input <= 0) {
        return 40;
    }

    return Math.min(Math.floor(input), 200);
}

function escapeIdentifier(value: string): string {
    return `"${value.replace(/"/g, '""')}"`;
}

function makeRuntimeDatabaseUrl(
    adminDatabaseUrl: string,
    params: { roleName: string; password: string; databaseName: string },
): string {
    const url = new URL(adminDatabaseUrl);
    url.username = params.roleName;
    url.password = params.password;
    url.pathname = `/${params.databaseName}`;

    if (!url.searchParams.has("sslmode")) {
        url.searchParams.set("sslmode", "require");
    }

    return url.toString();
}

function createAdminPool(connectionString: string): Pool {
    return new Pool({
        connectionString,
        max: 1,
        keepAlive: true,
        connectionTimeoutMillis: getRuntimeDbConnectionTimeoutMs(),
        ...(shouldForceIpv4() ? { family: 4 as const } : {}),
        ssl: connectionString.includes("localhost") ? undefined : { rejectUnauthorized: false },
    });
}

function isSetRoleRequiredError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return message.toLowerCase().includes("must be able to set role");
}

function formatProvisionError(error: unknown): string {
    const pgError = error as PgLikeError;
    const message =
        error instanceof Error
            ? error.message.trim()
            : typeof pgError?.message === "string"
              ? pgError.message.trim()
              : String(error).trim();

    const details: string[] = [];
    if (typeof pgError?.code === "string" && pgError.code.trim()) {
        details.push(`code=${pgError.code.trim()}`);
    }
    if (typeof pgError?.detail === "string" && pgError.detail.trim()) {
        details.push(`detail=${pgError.detail.trim()}`);
    }
    if (typeof pgError?.hint === "string" && pgError.hint.trim()) {
        details.push(`hint=${pgError.hint.trim()}`);
    }

    return details.length > 0 ? `${message || "unknown error"} (${details.join("; ")})` : message || "unknown error";
}

async function assertAdminCapabilities(pool: Pool): Promise<void> {
    const row = await readAdminCapabilityRow(pool);

    if (!row) {
        throw new Error("Unable to verify runtime DB admin capabilities.");
    }

    if (!row.rolcreatedb) {
        throw new Error(
            `Runtime DB admin user ${row.current_user ?? "(unknown)"} is missing CREATEDB. Use an owner/admin connection URL.`,
        );
    }

    if (!row.rolcreaterole) {
        throw new Error(
            `Runtime DB admin user ${row.current_user ?? "(unknown)"} is missing CREATEROLE. Use an owner/admin connection URL.`,
        );
    }
}

async function readAdminCapabilityRow(pool: Pool): Promise<AdminCapabilityRow | undefined> {
    const capabilities = await pool.query(
        "select current_user as current_user, rolcreatedb, rolcreaterole from pg_roles where rolname = current_user",
    );
    return capabilities.rows[0] as AdminCapabilityRow | undefined;
}

export async function checkRuntimeAdminDatabaseHealth(): Promise<RuntimeDatabaseAdminHealth> {
    const adminConfig = getRuntimeAdminDatabaseConfig();
    const adminDatabaseUrl = adminConfig.connectionString;
    const parsed = new URL(adminDatabaseUrl);
    const configuredDatabase = parsed.pathname.replace(/^\//, "") || "(default)";
    const configuredUser = parsed.username ? decodeURIComponent(parsed.username) : "(unset)";

    return withTransientRetry(async () => {
        const pool = createAdminPool(adminDatabaseUrl);
        let stage = "connect_admin";
        try {
            stage = "resolve_identity";
            const identityResult = await pool.query("select current_user as current_user, current_database() as current_database");
            const identity = identityResult.rows[0] as { current_user?: string; current_database?: string } | undefined;
            if (!identity?.current_user || !identity?.current_database) {
                throw new Error("Unable to resolve current_user/current_database from admin connection.");
            }

            stage = "check_admin_capabilities";
            const capabilities = await readAdminCapabilityRow(pool);
            if (!capabilities) {
                throw new Error("Unable to read admin role capabilities.");
            }

            return {
                source: adminConfig.source,
                host: parsed.hostname,
                configuredDatabase,
                configuredUser,
                currentUser: identity.current_user,
                currentDatabase: identity.current_database,
                isPoolerHost: isLikelyPooledConnection(adminDatabaseUrl),
                rolcreatedb: Boolean(capabilities.rolcreatedb),
                rolcreaterole: Boolean(capabilities.rolcreaterole),
            };
        } catch (error) {
            throw new Error(`Runtime DB admin health check failed at ${stage}: ${formatProvisionError(error)}`);
        } finally {
            await pool.end();
        }
    });
}

async function grantRuntimeSchemaPrivileges(adminDatabaseUrl: string, databaseName: string, roleName: string): Promise<void> {
    const databaseUrl = new URL(adminDatabaseUrl);
    databaseUrl.pathname = `/${databaseName}`;

    const databasePool = createAdminPool(databaseUrl.toString());
    try {
        await databasePool.query(`grant usage, create on schema public to ${roleName}`);
    } finally {
        await databasePool.end();
    }
}

export async function provisionRuntimeDatabase(projectId: string): Promise<RuntimeDatabaseProvisionResult> {
    const adminConfig = getRuntimeAdminDatabaseConfig();
    const adminDatabaseUrl = adminConfig.connectionString;
    if (isLikelyPooledConnection(adminDatabaseUrl)) {
        throw new Error("RUNNER_RUNTIME_ADMIN_DATABASE_URL must use a direct Postgres host (not Neon pooler).",);
    }

    const databaseName = buildProjectName(getRuntimeDatabasePrefix(), projectId, "runtime_db");
    const roleName = buildProjectName(getRuntimeRolePrefix(), projectId, "runtime_role");
    const rolePassword = randomBytes(24).toString("hex");
    let stage = "connect_admin";

    await withTransientRetry(async () => {
        const pool = createAdminPool(adminDatabaseUrl);

        try {
            stage = "check_admin_capabilities";
            await assertAdminCapabilities(pool);

            stage = "create_or_update_role";
            const roleExists = await pool.query("select 1 from pg_roles where rolname = $1 limit 1", [roleName]);
            if (roleExists.rowCount && roleExists.rowCount > 0) {
                await pool.query(`alter role ${roleName} with login password '${rolePassword}'`);
            } else {
                await pool.query(`create role ${roleName} with login password '${rolePassword}'`);
            }

            stage = "ensure_database";
            const databaseExists = await pool.query("select 1 from pg_database where datname = $1 limit 1", [databaseName]);
            if (!databaseExists.rowCount || databaseExists.rowCount === 0) {
                try {
                    await pool.query(`create database ${databaseName} owner ${roleName}`);
                } catch (error) {
                    if (!isSetRoleRequiredError(error)) {
                        throw error;
                    }

                    stage = "create_database_without_owner";
                    await pool.query(`create database ${databaseName}`);
                }
            }

            stage = "grant_database_privileges";
            await pool.query(`grant all privileges on database ${databaseName} to ${roleName}`);
        } catch (error) {
            throw new Error(`Runtime DB provisioning failed at ${stage}: ${formatProvisionError(error)}`);
        } finally {
            await pool.end();
        }
    });

    stage = "grant_schema_privileges";
    await withTransientRetry(async () => {
        try {
            await grantRuntimeSchemaPrivileges(adminDatabaseUrl, databaseName, roleName);
        } catch (error) {
            throw new Error(`Runtime DB provisioning failed at ${stage}: ${formatProvisionError(error)}`);
        }
    });

    return {
        provider: "postgres",
        databaseName,
        roleName,
        databaseUrl: makeRuntimeDatabaseUrl(adminDatabaseUrl, {
            roleName,
            password: rolePassword,
            databaseName,
        }),
    };
}

export async function exploreRuntimeDatabase(input: {
    databaseUrl: string;
    table?: string;
    limit?: number;
}): Promise<RuntimeDatabaseExplorerResult> {
    const databaseUrl = input.databaseUrl.trim();
    if (!databaseUrl) {
        throw new Error("databaseUrl is required.");
    }

    const requestedTable = input.table?.trim();
    const rowLimit = parseExplorerLimit(input.limit);

    return withTransientRetry(async () => {
        const pool = createAdminPool(databaseUrl);

        try {
            const tablesResult = await pool.query<{ table_name: string }>(
                `
                select table_name
                from information_schema.tables
                where table_schema = 'public'
                  and table_type = 'BASE TABLE'
                order by table_name asc
                `,
            );

            const tables = tablesResult.rows.map((row) => row.table_name);
            const selectedTable = requestedTable && tables.includes(requestedTable) ? requestedTable : tables[0] ?? null;
            if (!selectedTable) {
                return {
                    tables,
                    selectedTable: null,
                    columns: [],
                    rows: [],
                    rowCount: 0,
                };
            }

            const columnsResult = await pool.query<{ column_name: string; data_type: string }>(
                `
                select column_name, data_type
                from information_schema.columns
                where table_schema = 'public'
                  and table_name = $1
                order by ordinal_position asc
                `,
                [selectedTable],
            );

            const safeTable = escapeIdentifier(selectedTable);
            const rowsResult = await pool.query<Record<string, unknown>>(`select * from ${safeTable} limit $1`, [rowLimit]);

            return {
                tables,
                selectedTable,
                columns: columnsResult.rows.map((row) => ({
                    name: row.column_name,
                    type: row.data_type,
                })),
                rows: rowsResult.rows,
                rowCount: rowsResult.rowCount ?? rowsResult.rows.length,
            };
        } finally {
            await pool.end();
        }
    });
}
