export interface ExpoSupportVersion {
    sdk: string;
    status: "active" | "maintenance";
    createExpoAppVersion: string;
    templateSpecifier: string;
    shopifyCommerceLayerVersion: string;
    minimumNodeMajor: number;
}

const SUPPORTED_EXPO_VERSIONS: ExpoSupportVersion[] = [
    {
        sdk: "55",
        status: "active",
        createExpoAppVersion: "latest",
        templateSpecifier: "default@sdk-55",
        shopifyCommerceLayerVersion: "planned",
        minimumNodeMajor: 20,
    },
    {
        sdk: "54",
        status: "maintenance",
        createExpoAppVersion: "latest",
        templateSpecifier: "default@sdk-54",
        shopifyCommerceLayerVersion: "planned",
        minimumNodeMajor: 20,
    },
];

const DEFAULT_EXPO_SDK = "55";

export function listSupportedExpoVersions(): ExpoSupportVersion[] {
    return SUPPORTED_EXPO_VERSIONS.map((version) => ({ ...version }));
}

export function getDefaultExpoSdk(): string {
    return DEFAULT_EXPO_SDK;
}

function normalizeSdk(value: string | undefined): string | null {
    if (!value) return null;

    const raw = value.trim().toLowerCase();
    if (!raw) return null;

    return raw
        .replace(/^sdk[-\s]?/i, "")
        .replace(/^v/i, "")
        .replace(/[^0-9]/g, "");
}

export function resolveExpoSupportVersion(requestedSdk: string | undefined): ExpoSupportVersion {
    const normalizedRequested = normalizeSdk(requestedSdk) ?? DEFAULT_EXPO_SDK;
    const matched = SUPPORTED_EXPO_VERSIONS.find((version) => version.sdk === normalizedRequested);
    if (matched) {
        return matched;
    }

    const supported = SUPPORTED_EXPO_VERSIONS.map((version) => `sdk-${version.sdk}`).join(", ");
    throw new Error(`Unsupported Expo SDK: ${requestedSdk}. Supported versions: ${supported}.`);
}
