import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { clerkConfigured } from "./lib/auth";

const isProtected = createRouteMatcher(["/checks(.*)", "/runs(.*)", "/alerts(.*)", "/billing(.*)", "/settings(.*)", "/features(.*)"]);

export default clerkMiddleware(async (auth, req) => {
  if (clerkConfigured && isProtected(req)) {
    await auth.protect();
  }
});

export const config = {
  matcher: ["/((?!_next|api|sign-in|.*\\..*).*)"],
};
