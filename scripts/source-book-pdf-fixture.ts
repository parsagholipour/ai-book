/** Native text fixture: 80 readable pages, unique page sentinels, distant facts. */
export function eightyPageSourcePdf(): { pdf: Buffer; pages: string[] } {
  const pages = Array.from({ length: 80 }, (_, index) => {
    const page = index + 1;
    const facts = page === 1
      ? "Mina Farahani is the Qeshm Observatory archive custodian. The observatory closed in 2088. This is a fictional story bible."
      : page === 40
        ? "The archive passcode is CYAN-482. The inventory contains exactly 742 glass plates. Mina must move the plates into sealed transport crates before the last ferry leaves."
        : page === 80
          ? "FINAL RECORD: The northern lens is sealed in Vault Seven and stays there. Mina checks all 742 glass plates, seals the crates, and boards the ferry. The archive record is preserved. No exact calendar date or departure time is recorded for the ferry."
          : `Inspection register ${page}: cabinet ${String.fromCharCode(65 + index % 26)} has its own numbered ledger. This page describes preservation procedure, not a change to the master inventory or access credentials.`;
    const paragraphs = Array.from({ length: 9 }, (_, entry) => {
      const materials = ["paper sleeves", "wooden trays", "transport crates", "shelf brackets", "linen wraps", "catalog cards", "storage drawers", "humidity logs", "packing sheets"];
      return `Record ${page}.${entry + 1}: The ${materials[(entry + index) % materials.length]} were inspected in sequence. Staff checked the labels against the local register, recorded the condition of each container, and kept the inspection notes with the matching cabinet. Any loose packing was replaced before the container was returned to its designated shelf.`;
    });
    return [`QESHM OBSERVATORY - ARCHIVE REGISTER - PAGE ${page}`, `PAGE SENTINEL QESHM-P${String(page).padStart(3, "0")}-RECORD`, facts, ...paragraphs].join("\n\n");
  });
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  const children: string[] = [];
  for (const text of pages) {
    const lines = text.split("\n").flatMap((paragraph) => {
      const wrapped: string[] = [];
      let line = "";
      for (const word of paragraph.split(/\s+/)) {
        if (line.length + word.length > 99) { wrapped.push(line); line = ""; }
        line += `${line ? " " : ""}${word}`;
      }
      wrapped.push(line);
      return wrapped;
    });
    if (lines.length > 66) throw new Error("Fixture text would overflow its page");
    const stream = `BT /F1 9 Tf 10.5 TL 40 800 Td\n${lines.map((line, i) => `${i ? "T* " : ""}(${line.replace(/[\\()]/g, "\\$&")}) Tj`).join("\n")}\nET\n`;
    const id = objects.length + 1;
    children.push(`${id} 0 R`);
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${id + 1} 0 R >>`);
    objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`);
  }
  objects[1] = `<< /Type /Pages /Kids [${children.join(" ")}] /Count 80 >>`;
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return { pdf: Buffer.from(pdf), pages };
}
