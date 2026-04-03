import { randomBytes } from "node:crypto";
import { Pool } from "pg";

const POSTGRES_IDENTIFIER_MAX_LENGTH = 63;

export interface RuntimeDatabaseProvisionResult {
    provider: string;
    databaseName: string;
    roleName: string;
    databaseUrl: string;
}

interface PgLikeError {
    code?: string;
    detail?: string;
    hint?: string;
    message?: string;
}

function getRuntimeAdminDatabaseUrl(): string {
    const value =
        process.env.RUNNER_RUNTIME_ADMIN_DATABASE_URL?.trim() ||
        process.env.RUNTIME_ADMIN_DATABASE_URL?.trim() ||
        process.env.NEON_ADMIN_DATABASE_URL?.trim();

    if (!value) {
        throw new Error(
            "RUNNER_RUNTIME_ADMIN_DATABASE_URL is required for runtime DB provisioning on runner.",
        );
    }

    return value;
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
    const capabilities = await pool.query(
        "select current_user as current_user, rolcreatedb, rolcreaterole from pg_roles where rolname = current_user",
    );
    const row = capabilities.rows[0] as
        | {
              current_user?: string;
              rolcreatedb?: boolean;
              rolcreaterole?: boolean;
          }
        | undefined;

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
    const adminDatabaseUrl = getRuntimeAdminDatabaseUrl();
    if (isLikelyPooledConnection(adminDatabaseUrl)) {
        throw new Error("RUNNER_RUNTIME_ADMIN_DATABASE_URL must use a direct Postgres host (not Neon pooler).",);
    }

    const databaseName = buildProjectName(getRuntimeDatabasePrefix(), projectId, "runtime_db");
    const roleName = buildProjectName(getRuntimeRolePrefix(), projectId, "runtime_role");
    const rolePassword = randomBytes(24).toString("hex");
    let stage = "connect_admin";

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

    stage = "grant_schema_privileges";
    try {
        await grantRuntimeSchemaPrivileges(adminDatabaseUrl, databaseName, roleName);
    } catch (error) {
        throw new Error(`Runtime DB provisioning failed at ${stage}: ${formatProvisionError(error)}`);
    }

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
