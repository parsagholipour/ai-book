import { describe, expect, it, vi } from "vitest";
import type { IncomingHttpHeaders } from "node:http";
import { fetchSourceDocument, isPublicSourceAddress, sourcePdfText } from "./sourceDocumentFetch.js";

function dependencies() {
  return {
    resolve: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]),
    request: vi.fn(async (): Promise<{ status: number; headers: IncomingHttpHeaders; body: Buffer }> => ({ status: 200, headers: { "content-type": "text/plain" }, body: Buffer.from("Actual document text") })),
    pdfText: vi.fn(async () => "Extracted PDF passage")
  };
}

describe("public source document reader", () => {
  it("reads public bytes through the validated address", async () => {
    const deps = dependencies();
    expect(await fetchSourceDocument("https://example.edu/record", deps)).toEqual({ status: 200, text: "Actual document text", contentType: "text/plain" });
    expect(deps.request).toHaveBeenCalledWith(new URL("https://example.edu/record"), { address: "93.184.216.34", family: 4 });
  });

  it("contains its download deadline without turning it into a book cancellation", async () => {
    const deps = dependencies();
    const timeout = new Error("The operation was aborted", { cause: new DOMException("The operation timed out", "TimeoutError") });
    timeout.name = "AbortError";
    deps.request.mockRejectedValueOnce(timeout);
    expect(await fetchSourceDocument("https://example.edu/slow", deps)).toEqual({ status: 504, text: "" });
    const stopped = new DOMException("Canceled by caller", "AbortError");
    deps.request.mockRejectedValueOnce(stopped);
    await expect(fetchSourceDocument("https://example.edu/stopped", deps)).rejects.toBe(stopped);
  });

  it("refuses private DNS results and redirects before opening their socket", async () => {
    const deps = dependencies();
    deps.resolve.mockResolvedValueOnce([{ address: "10.0.0.1", family: 4 }]);
    expect((await fetchSourceDocument("https://example.edu/record", deps)).status).toBe(403);
    expect(deps.request).not.toHaveBeenCalled();
    deps.request.mockResolvedValueOnce({ status: 302, headers: { location: "http://127.0.0.1/secrets" }, body: Buffer.alloc(0) });
    expect((await fetchSourceDocument("https://example.edu/record", deps)).status).toBe(403);
    expect(deps.request).toHaveBeenCalledOnce();
  });

  it("converts PDFs from the response bytes and never accepts an error body as evidence", async () => {
    const deps = dependencies();
    const pdf = Buffer.from("%PDF-1.4 fixture");
    deps.request.mockResolvedValueOnce({ status: 200, headers: { "content-type": "application/pdf" }, body: pdf });
    expect(await fetchSourceDocument("https://example.edu/report.pdf", deps)).toEqual({ status: 200, text: "Extracted PDF passage", contentType: "text/plain" });
    expect(deps.pdfText).toHaveBeenCalledWith(pdf);
    deps.request.mockResolvedValueOnce({ status: 403, headers: { "content-type": "text/html" }, body: Buffer.from("Access denied") });
    expect((await fetchSourceDocument("https://example.edu/report", deps)).text).toBe("");
  });

  it.each(["127.0.0.1", "169.254.169.254", "192.168.1.2", "100.64.0.1", "172.31.0.1", "::1", "::ffff:127.0.0.1", "fc00::1", "fe80::1"])("rejects non-public address %s", (address) => {
    expect(isPublicSourceAddress(address)).toBe(false);
  });

  it("extracts a real PDF text stream", async () => {
    const stream = "BT /F1 12 Tf 20 80 Td (The commission heard testimony.) Tj ET";
    const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 100] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
    let pdf = "%PDF-1.4\n";
    const offsets = objects.map((body, index) => { const offset = pdf.length; pdf += `${index + 1} 0 obj\n${body}\nendobj\n`; return offset; });
    const xref = pdf.length;
    pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
    expect(await sourcePdfText(Buffer.from(pdf))).toBe("The commission heard testimony.");
  });
});
