import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

export interface DynamicTokenClaims {
  subject: string;
  email?: string;
  emailVerified: boolean;
  displayName?: string;
}

export type DynamicTokenVerifier = (token: string) => Promise<DynamicTokenClaims>;

const parseBoolean = (value: string | undefined, fallback = false) => {
  if (value === undefined) return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
};

const toStringClaim = (payload: JWTPayload, key: string) => {
  const value = payload[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
};

export interface DynamicAuthConfig {
  enabled: boolean;
  issuer: string;
  audience: string;
  jwksUrl: string;
}

export const readDynamicAuthConfigFromEnv = (): DynamicAuthConfig => {
  const enabled = parseBoolean(process.env.DAY1_DYNAMIC_AUTH_ENABLED, false);
  return {
    enabled,
    issuer: (process.env.DAY1_DYNAMIC_JWT_ISSUER ?? "").trim(),
    audience: (process.env.DAY1_DYNAMIC_JWT_AUDIENCE ?? "").trim(),
    jwksUrl: (process.env.DAY1_DYNAMIC_JWKS_URL ?? "").trim(),
  };
};

export const createDynamicTokenVerifierFromEnv = (): DynamicTokenVerifier | null => {
  const config = readDynamicAuthConfigFromEnv();
  if (!config.enabled) return null;
  if (!config.issuer || !config.audience || !config.jwksUrl) {
    throw new Error(
      "Dynamic auth is enabled but DAY1_DYNAMIC_JWT_ISSUER, DAY1_DYNAMIC_JWT_AUDIENCE, or DAY1_DYNAMIC_JWKS_URL is missing."
    );
  }
  const jwks = createRemoteJWKSet(new URL(config.jwksUrl));

  return async (token: string) => {
    const { payload } = await jwtVerify(token, jwks, {
      issuer: config.issuer,
      audience: config.audience,
      clockTolerance: 10,
    });
    if (!payload.sub || typeof payload.sub !== "string") {
      throw new Error("Dynamic auth token missing subject.");
    }
    return {
      subject: payload.sub,
      email: toStringClaim(payload, "email"),
      emailVerified: payload.email_verified === true,
      displayName: toStringClaim(payload, "name") ?? toStringClaim(payload, "preferred_username"),
    };
  };
};
