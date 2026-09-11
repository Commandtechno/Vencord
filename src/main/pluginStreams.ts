/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/**
 * Lets a plugin's native (main process) code handle requests of its own under
 * vencord:///plugin-stream/<PluginName>/... — the vencord: scheme is already allowed for
 * connect-src/media-src/img-src by our CSP patcher (see @main/csp), so this is the only way for a
 * plugin to serve a renderer-loadable resource (e.g. a <video src>) that's actually computed/streamed
 * from the main process, without needing its own scheme + CSP entry.
 *
 * Register a handler by importing this map from a plugin's native.ts and calling
 * `pluginStreamHandlers.set("YourPluginName", request => ...)` at module scope.
 */
export const pluginStreamHandlers = new Map<string, (request: Request) => Promise<Response> | Response>();
