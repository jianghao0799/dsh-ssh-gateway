import type { SidebarHttpRequest, SidebarHttpResponse } from './context-types.ts'

/** Host-only optional file transport, provided by the SSH workspace bundle. */
export interface SshWorkspaceFiles {
  api(method: string, payload: unknown, signal?: AbortSignal): Promise<{ handled: boolean; value?: unknown }>
  guard(sessionId: string | null): Promise<void>
  media(sessionId: string, path: string, res: SidebarHttpResponse, options: { html?: boolean; download?: boolean; mediaType?: string }): Promise<boolean>
  watch(ws: object, req: SidebarHttpRequest): Promise<boolean>
  subscribeBindings(listener: (sessionId: string | null) => void): () => void
}
declare module '@deepseek-ai/cordis' {
  interface Context { sshWorkspaceFiles: SshWorkspaceFiles }
}
