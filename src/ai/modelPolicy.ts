export const isLoopbackHostname = (hostname: string): boolean =>
    hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";

export const defaultBeliefManifestUrl = (_hostname: string): string => "models/belief/manifest.json";
