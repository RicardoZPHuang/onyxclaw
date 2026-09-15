'use strict'

const http = require('http')
const httpProxy = require('http-proxy')

const target = String(process.env.AGENT_GATEWAY_URL || '').replace(/\/$/u, '')
const listenPort = Number(process.env.BROWSER_PROXY_PORT || 13080)
const routeHeaders = {
  'E2B-Traffic-Access-Token': process.env.E2B_TRAFFIC_ACCESS_TOKEN,
  'E2b-Sandbox-Id': process.env.E2B_SANDBOX_ID,
  'E2b-Sandbox-Port': process.env.E2B_SANDBOX_PORT || '3080'
}

if (!/^https:\/\//u.test(target)) throw new Error('AGENT_GATEWAY_URL must use https://')
if (!Number.isInteger(listenPort) || listenPort < 1 || listenPort > 65535) {
  throw new Error('BROWSER_PROXY_PORT must be between 1 and 65535')
}
for (const [name, value] of Object.entries(routeHeaders)) {
  if (!value) throw new Error(`missing ${name}`)
}

const proxy = httpProxy.createProxyServer({
  target,
  changeOrigin: true,
  ws: true,
  secure: true
})

function addRouteHeaders(proxyRequest) {
  for (const [name, value] of Object.entries(routeHeaders)) {
    proxyRequest.setHeader(name, value)
  }
}

proxy.on('proxyReq', addRouteHeaders)
proxy.on('proxyReqWs', addRouteHeaders)
proxy.on('error', (error, _request, response) => {
  console.error(`[bridge] ${error.message}`)
  if (response && typeof response.writeHead === 'function' && !response.headersSent) {
    response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
    response.end('AgentSphere Gateway bridge failure')
  } else if (response && typeof response.destroy === 'function') {
    response.destroy()
  }
})

const server = http.createServer((request, response) => proxy.web(request, response))
server.on('upgrade', (request, socket, head) => proxy.ws(request, socket, head))
server.listen(listenPort, '127.0.0.1', () => {
  console.log(`[bridge] listening on http://127.0.0.1:${listenPort}`)
  console.log(`[bridge] forwarding HTTP and WebSocket traffic to ${target}`)
})
