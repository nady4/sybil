interface Env {
  ASSETS: Fetcher;
}

/**
 * Agent-facing docs site. Static markdown + llms.txt served from the
 * assets binding. The whole point: every page is written for agents to
 * read, so Claude Code / Cursor can self-configure against the product
 * (the OSS distribution playbook).
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/") {
      return Response.redirect(`${url.origin}/llms.txt`, 302);
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
