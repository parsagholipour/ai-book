import { lookup } from "node:dns/promises";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { spawn } from "node:child_process";
import { publicSourceUrl, PRIMARY_TEXT_MAX_CHARS, type PrimarySourceFetch } from "@book-maker/core";

const MAX_SOURCE_BYTES = 12 * 1024 * 1024;
const SOURCE_TIMEOUT_MS = 15_000;
const USER_AGENT = "ai-book-maker/1.0 (https://ravanix.app; source research; contact: 12parsaaa@gmail.com)";
type Address = { address: string; family: number };
type SourceResponse = { status: number; headers: IncomingHttpHeaders; body: Buffer };
type SourceFetchDeps = {
  resolve: (hostname: string) => Promise<Address[]>;
  request: (url: URL, address: Address) => Promise<SourceResponse>;
  pdfText: (body: Buffer) => Promise<string>;
};

export function isPublicSourceAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number);
    return a !== 0 && a !== 10 && a !== 127 && a! < 224 && !(a === 169 && b === 254) &&
      !(a === 172 && b! >= 16 && b! <= 31) && !(a === 192 && b === 168) &&
      !(a === 100 && b! >= 64 && b! <= 127) && !(a === 198 && (b === 18 || b === 19));
  }
  return isIP(address) === 6 && /^[23][\da-f]{3}:/i.test(address) && !/^2001:db8:/i.test(address);
}

/** Connect to the validated address itself, retaining the original Host and TLS identity. */
function requestSource(url: URL, address: Address): Promise<SourceResponse> {
  return new Promise((resolve, reject) => {
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)({
      protocol: url.protocol, hostname: address.address, family: address.family,
      port: url.port || (url.protocol === "https:" ? 443 : 80), servername: url.hostname,
      path: url.pathname + url.search,
      headers: { host: url.host, "user-agent": USER_AGENT, accept: "text/html,application/pdf,text/plain,application/json;q=0.9,*/*;q=0.1" },
      signal: AbortSignal.timeout(SOURCE_TIMEOUT_MS)
    }, (response) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on("error", reject);
      response.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > MAX_SOURCE_BYTES) response.destroy(new Error("Source document exceeds the download budget"));
        else chunks.push(chunk);
      });
      response.on("end", () => resolve({ status: response.statusCode ?? 502, headers: response.headers, body: Buffer.concat(chunks) }));
    });
    request.on("error", reject);
    request.end();
  });
}

/** PDF text comes from the actual bytes, never a model's visual summary. No temporary file is needed. */
export function sourcePdfText(body: Buffer): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("pdftotext", ["-enc", "UTF-8", "-", "-"], { stdio: ["pipe", "pipe", "pipe"], timeout: SOURCE_TIMEOUT_MS });
    let text = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { text = (text + chunk).slice(0, PRIMARY_TEXT_MAX_CHARS); });
    child.stderr.resume();
    child.on("error", reject);
    child.stdin.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(text.trim()) : reject(new Error("Source PDF has no extractable text")));
    child.stdin.end(body);
  });
}

/** Bounded public document reader. Every redirect is revalidated; private DNS results never reach a socket. */
export async function fetchSourceDocument(value: string, deps: SourceFetchDeps = {
  resolve: (hostname) => lookup(hostname, { all: true }), request: requestSource, pdfText: sourcePdfText
}): ReturnType<PrimarySourceFetch> {
  let next = value;
  for (let redirect = 0; redirect <= 3; redirect += 1) {
    const safe = publicSourceUrl(next);
    if (!safe) return { status: 403, text: "" };
    const url = new URL(safe);
    const addresses = await deps.resolve(url.hostname);
    if (!addresses.length || addresses.some((entry) => !isPublicSourceAddress(entry.address))) return { status: 403, text: "" };
    const address = addresses.find((entry) => entry.family === 4) ?? addresses[0]!;
    let response: SourceResponse;
    try {
      response = await deps.request(url, address);
    } catch (error) {
      // Node wraps our own AbortSignal.timeout in AbortError. This is a
      // missing source, not the caller's cancellation of book generation.
      if (error instanceof Error && (error.name === "TimeoutError" ||
        (error.name === "AbortError" && error.cause instanceof Error && error.cause.name === "TimeoutError"))) {
        return { status: 504, text: "" };
      }
      throw error;
    }
    if ([301, 302, 303, 307, 308].includes(response.status) && response.headers.location) {
      next = new URL(response.headers.location, url).href;
      continue;
    }
    if (response.status !== 200) return { status: response.status, text: "" };
    const contentType = response.headers["content-type"] ?? "";
    if (contentType.includes("pdf") || response.body.subarray(0, 5).toString() === "%PDF-") {
      return { status: 200, text: await deps.pdfText(response.body), contentType: "text/plain" };
    }
    if (contentType && !/text\/|json|xml|html/i.test(contentType)) return { status: 415, text: "" };
    return { status: 200, text: response.body.toString("utf8"), contentType };
  }
  return { status: 508, text: "" };
}
