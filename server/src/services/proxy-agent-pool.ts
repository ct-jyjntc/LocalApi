import http from "http";
import https from "https";
import { HttpProxyAgent } from "http-proxy-agent";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";

const httpProxyAgents = new Map<string, HttpProxyAgent<string>>();
const httpsProxyAgents = new Map<string, HttpsProxyAgent<string>>();
const socksProxyAgents = new Map<string, SocksProxyAgent>();

/**
 * When the upstream is https, http-proxy-agent v9 mis-detects the endpoint
 * (secureEndpoint is missing) and sends a plain absolute-URL request to the
 * target's 443 — upstreams like Cloudflare answer 400 "plain HTTP request was
 * sent to HTTPS port". HttpsProxyAgent always issues CONNECT (then upgrades to
 * TLS itself for https upstreams), so route every https upstream through it.
 */
const httpsUpstreamAgents = new Map<string, HttpsProxyAgent<string>>();

const PROXY_AGENT_OPTS = {
  keepAlive: true,
  keepAliveMsecs: 30_000,
  maxSockets: 64,
  maxFreeSockets: 16,
  scheduling: "lifo",
} as const;

/**
 * Agent pool keyed by proxy URL. Protocol decides the agent class:
 * http:// → HttpProxyAgent, https:// → HttpsProxyAgent, socks4/5 → SocksProxyAgent.
 *
 * NOTE: https-proxy-agent v9 crashes the process on dead https proxies
 * (uncaughtException from a pre-attach TLS socket error). See
 * scripts/patch-https-proxy-agent.mjs (wired as postinstall) which fixes it.
 */
export function proxyAgentFor(
  url: string,
  opts?: { httpsUpstream?: boolean },
): http.Agent | https.Agent {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url.startsWith("https:") ? new https.Agent() : new http.Agent();
  }
  const scheme = parsed.protocol.replace(/:$/, "");
  // https upstream → always CONNECT (HttpsProxyAgent handles the TLS upgrade).
  if (opts?.httpsUpstream && (scheme === "http" || scheme === "https")) {
    let agent = httpsUpstreamAgents.get(url);
    if (!agent) {
      agent = new HttpsProxyAgent(url, PROXY_AGENT_OPTS);
      httpsUpstreamAgents.set(url, agent);
    }
    return agent;
  }
  if (scheme === "http") {
    let agent = httpProxyAgents.get(url);
    if (!agent) {
      agent = new HttpProxyAgent(url, PROXY_AGENT_OPTS);
      httpProxyAgents.set(url, agent);
    }
    return agent;
  }
  if (scheme === "https") {
    let agent = httpsProxyAgents.get(url);
    if (!agent) {
      agent = new HttpsProxyAgent(url, PROXY_AGENT_OPTS);
      httpsProxyAgents.set(url, agent);
    }
    return agent;
  }
  // socks4 / socks5 / socks5h / socks
  // Normalize socks5 -> socks5h (proxy-side DNS): with client-side lookup the
  // local resolver (e.g. a fake-ip / transparent-proxy setup) hands the proxy
  // an unroutable address and every request times out. socks5h lets the proxy
  // resolve the hostname itself, which is what users expect from an imported
  // socks5 proxy line.
  const agentUrl =
    scheme === "socks5" || scheme === "socks"
      ? url.replace(/^socks5:/, "socks5h:").replace(/^socks:/, "socks5h:")
      : url;
  let agent = socksProxyAgents.get(agentUrl);
  if (!agent) {
    agent = new SocksProxyAgent(agentUrl, PROXY_AGENT_OPTS);
    socksProxyAgents.set(agentUrl, agent);
  }
  return agent;
}