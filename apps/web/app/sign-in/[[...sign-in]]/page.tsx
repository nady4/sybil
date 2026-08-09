import { SignIn } from "@clerk/nextjs";
import { clerkConfigured } from "@/lib/auth";

export default function SignInPage() {
  if (!clerkConfigured) {
    return (
      <div>
        <h1>Sign in</h1>
        <div className="empty">
          Clerk is not configured — set <code className="mono">NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY</code> (and
          the matching <code className="mono">CLERK_SECRET_KEY</code>, <code className="mono">CLERK_JWKS_URL</code>,
          and the <code className="mono">/v1/auth/clerk-webhook</code> webhook on the API worker) to enable
          org-scoped web sessions.
        </div>
      </div>
    );
  }
  return (
    <div style={{ display: "flex", justifyContent: "center", paddingTop: 40 }}>
      <SignIn />
    </div>
  );
}
