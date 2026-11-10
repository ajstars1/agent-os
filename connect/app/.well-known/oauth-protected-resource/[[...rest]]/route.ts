import { getPublicOrigin, metadataCorsOptionsRequestHandler, protectedResourceHandler } from 'mcp-handler'
import { authIssuer, env } from '../../../../lib/env'

// OAuth Protected Resource Metadata (RFC 9728): tells an MCP client that Supabase Auth is the authorization
// server for /api/mcp. Clients ask for it at the bare path or with the resource path appended; both get the same
// answer, and the resource is always the MCP endpoint itself.
export const GET = (req: Request): Response => {
  try {
    const origin = env().siteUrl ?? getPublicOrigin(req)
    return protectedResourceHandler({ authServerUrls: [authIssuer()], resourceUrl: `${origin}/api/mcp` })(req)
  } catch {
    return Response.json({ error: 'server_not_configured' }, { status: 503 })
  }
}

export const OPTIONS = metadataCorsOptionsRequestHandler()
