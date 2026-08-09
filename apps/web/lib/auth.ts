import { auth } from "@clerk/nextjs/server";

export const clerkConfigured = Boolean(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY);

/**
 * Authorization header for the API worker.
 *
 * When Clerk is configured, server components use the signed-in user's
 * session token (the API worker verifies it against the Clerk JWKS and
 * resolves the org via webhook-provisioned mappings). Without Clerk, the
 * single env API key is used (self-hosted / local dev).
 */
export async function apiAuthHeaders(): Promise<Record<string, string>> {
  if (clerkConfigured) {
    try {
      const { getToken } = await auth();
      const token = await getToken();
      if (token) return { authorization: `Bearer ${token}` };
    } catch {
      // Clerk not fully configured (missing CLERK_SECRET_KEY etc.) — fall back.
    }
  }
  return { authorization: `Bearer ${process.env.AGENTSRE_API_KEY ?? ""}` };
}
