/** Small valid PDFs exercise real Poppler without a browser or licensed assets. */
export function sourceFixturePdf(pages: Array<{ text?: string; image?: boolean }>): Buffer {
  const objects: string[] = ["<< /Type /Catalog /Pages 2 0 R >>", "", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", "<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length 3 >>\nstream\n\xff\xff\xff\nendstream"];
  const kids: string[] = [];
  for (const page of pages) {
    const id = objects.length + 1;
    kids.push(`${id} 0 R`);
    const text = page.text?.replace(/[()\\]/g, " ") ?? "";
    const content = `${text ? `BT /F1 10 Tf 40 700 Td (${text}) Tj ET\n` : ""}${page.image ? "q 100 0 0 100 20 100 cm /Im1 Do Q\n" : ""}`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 800 800] /Resources << /Font << /F1 3 0 R >> /XObject << /Im1 4 0 R >> >> /Contents ${id + 1} 0 R >>`);
    objects.push(`<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}endstream`);
  }
  objects[1] = `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${pages.length} >>`;
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(pdf, "latin1")); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf, "latin1");
}
