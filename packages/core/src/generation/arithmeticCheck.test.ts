import { describe, expect, it } from "vitest";
import { arithmeticFindings, checkStatement } from "./arithmeticCheck.js";

// The worked RSA example as the 100-page Balanced cryptography book (2026-09-19) printed it:
// the final residue is right, every intermediate one is wrong.
const printedRsa = [
  "The toy key uses \\(p=11\\), \\(q=17\\), \\(n=187\\), \\(e=7\\) and \\(d=23\\). Encrypting \\(m=2\\) gives",
  "\\[\nc\\equiv2^7\\pmod{187}.\n\\]",
  "Squaring and reducing: \\[\n128^2=16384\\equiv169\\pmod{187}.\n\\] Then \\[\n128^4\\equiv169^2\\equiv81\\pmod{187},\n\\] and \\[\n128^8\\equiv81^2\\equiv126\\pmod{187}.\n\\]",
  "\\[\n128^{16}\\equiv126^2\\equiv155\\pmod{187}.\n\\]",
  "\\[\n128^{23} \\equiv128^{16}128^4 128^2 128 \\equiv155\\cdot81\\cdot169\\cdot128 \\equiv2\\pmod{187}.\n\\]",
  "since \\(187=11\\cdot17.\\)"
].join("\n\n");

describe("arithmeticFindings", () => {
  it("rejects the audited bit-length description of an explicit numeric modulus", () => {
    const findings = arithmeticFindings("An attacker did not need to factor the 2048-bit modulus $n = 187$.");
    expect(findings).toHaveLength(1);
    expect(findings[0]?.reason).toContain("8 bits");
    expect(arithmeticFindings("The 8-bit modulus $n = 187$ is a toy example.")).toEqual([]);
    expect(arithmeticFindings("A 2048-bit modulus is usual. Our toy modulus is $n = 187$.")).toEqual([]);
    expect(arithmeticFindings("Store 187 in a 2048-bit integer buffer.")).toEqual([]);
  });
  it("checks numeric calculations after an assignment label", () => {
    for (const label of ["A", "B", "A_i", "A_{i}"]) {
      const statement = `${label}=5^6\\bmod23=9`;
      expect(arithmeticFindings(`\\(${statement}\\)`)).toEqual([
        { quote: statement, reason: "5^6 mod 23 = 8, which is ≡ 8 (mod 23), but the statement gives 9." }
      ]);
    }
    expect(checkStatement("n=187=11\\cdot18")).toBe("187 = 187, but the statement gives 11·18 = 198.");
  });

  it("checks the rest of a chain after a valid implicit congruence", () => {
    expect(arithmeticFindings("Modulo 23: \\(5^2\\equiv2=3\\).")).toEqual([
      { quote: "5^2\\equiv2=3", reason: "2 = 2, which is ≡ 2 (mod 23), but the statement gives 3." }
    ]);
    expect(arithmeticFindings("Modulo 23: \\(5^2\\equiv2\\equiv3\\).")).toHaveLength(1);
  });

  it("finds every wrong intermediate residue of the printed RSA chain and names the right one", () => {
    const findings = arithmeticFindings(printedRsa);
    expect(findings.map((finding) => finding.quote)).toEqual([
      "128^2=16384\\equiv169\\pmod{187}.",
      "128^4\\equiv169^2\\equiv81\\pmod{187},",
      "128^8\\equiv81^2\\equiv126\\pmod{187}.",
      "128^{16}\\equiv126^2\\equiv155\\pmod{187}.",
      "128^{23} \\equiv128^{16}128^4 128^2 128 \\equiv155\\cdot81\\cdot169\\cdot128 \\equiv2\\pmod{187}."
    ]);
    expect(findings[0]!.reason).toBe("16384 ≡ 115 (mod 187), but the statement gives 169.");
    expect(findings[1]!.reason).toBe("128^4 ≡ 135 (mod 187), but the statement gives 169^2 ≡ 137.");
    expect(findings[4]!.reason).toBe("128^16·128^4·128^2·128 ≡ 2 (mod 187), but the statement gives 155·81·169·128 ≡ 123.");
    // Each statement is quoted exactly as it stands, so a page carrying it can be matched later.
    for (const finding of findings) expect(printedRsa).toContain(finding.quote);
  });

  it("passes every correct statement of the same book", () => {
    const correct = [
      "15 \\equiv 3 \\pmod {12}", "3^5=243", "3^2\\equiv2\\pmod7", "3^4\\equiv4\\pmod7", "3^5\\equiv4\\cdot3\\equiv5\\pmod7",
      "A=5^6\\bmod23=8", "B=5^{15}\\bmod23=19", "\\varphi(187)=10\\cdot16=160.", "7\\cdot23=161", "187=11\\cdot17.",
      "n=187=11 \\times 17", "\\varphi(187)=10 \\times 16=160.", "3 \\times 5=15", "160=22 \\times 7+6", "7=1\\times6+1",
      "2^7=128", "128^{23}\\pmod {187}=2.", "ed=7 \\times 23=161", "161=1+160", "5^6\\bmod23=8.", "5^6\\equiv8\\pmod{23}",
      "\\gcd(3,15)=3", "\\gcd(5,15)=5", "3^4\\equiv13\\pmod {17}", "2^{10}=1024", "(2+3)(4-1)=15", "-3+5=2"
    ];
    for (const statement of correct) expect(checkStatement(statement), statement).toBeUndefined();
    expect(arithmeticFindings(correct.map((statement) => `\\(${statement}\\)`).join(" "))).toEqual([]);
  });

  it("skips symbolic, approximate and foreign statements rather than guessing at them", () => {
    const symbolic = [
      "\\varphi(n)=(p-1)(q-1).", "ed\\equiv1\\pmod{\\varphi(n)}.", "a^{\\varphi(n)}\\equiv1\\pmod n.", "ed=1+k\\varphi(n).",
      "m^{ed}=m^{1+160}=m(m^{160})\\equiv m\\cdot1\\equiv m\\pmod {187}.", "B=2^{8(k-2)}", "EM = 00 \\mathbin\\Vert 02 \\mathbin\\Vert PS",
      "x=0,1,2,\\ldots", "c\\equiv2^7\\pmod{187}.", "2^{256} = 1.16 \\times 10^{77}", "3^5 \\bmod 7", "p=23", "N = 15", "r = 4",
      "2^{10} \\approx 1000", "5 < 7", "50\\% = 1/2", "\\sqrt{16}=4", "\\frac{1}{2}=0.5"
    ];
    for (const statement of symbolic) expect(checkStatement(statement), statement).toBeUndefined();
  });

  it("checks exact equalities, mid-chain reductions and huge powers under a modulus", () => {
    expect(checkStatement("2^{10}=1000")).toBe("2^10 = 1024, but the statement gives 1000.");
    expect(checkStatement("5^6\\bmod23=9")).toBe("5^6 mod 23 = 8, but the statement gives 9.");
    expect(checkStatement("128^{23}\\pmod {187}=3.")).toBe("128^23 mod 187 = 2, but the statement gives 3.");
    expect(checkStatement("\\gcd(12,18)=4")).toBe("gcd(12,18) = 6, but the statement gives 4.");
    expect(checkStatement("\\varphi(15)=9")).toBe("φ(15) = 8, but the statement gives 9.");
    expect(checkStatement("2^{4002}\\equiv1\\pmod{7}")).toBeUndefined();
    expect(checkStatement("2^{4000}\\equiv1\\pmod{7}")).toBe("2^4000 ≡ 2 (mod 7), but the statement gives 1.");
    expect(checkStatement("(2+3)(4-1)=16")).toBe("(2+3)·(4-1) = 15, but the statement gives 16.");
    // A power too large to hold exactly is not evaluated, even under a modulus.
    expect(checkStatement("2^{100000}\\equiv1\\pmod{7}")).toBeUndefined();
    expect(checkStatement("2^{100000}=1")).toBeUndefined();
  });

  it("reads every delimiter once and ignores prose dollars", () => {
    const markdown = "Inline \\(2+2=5\\) and display $$3\\cdot3=10$$ and single $4+4=9$ and a price of $5 and $10 later. \\[2+2=5\\]";
    expect(arithmeticFindings(markdown).map((finding) => finding.quote)).toEqual(["2+2=5", "3\\cdot3=10", "4+4=9"]);
  });
});

// The sentence the second 100-page book (2026-09-19) printed in its Shor chapter, which the checker
// flagged three times and paid a repair round for: every equality holds modulo 23.
const shorSentence =
  "With \\(g=5\\), \\(h=4\\), and arithmetic modulo 23, one can calculate \\(5^1=5\\), \\(5^2=2\\), \\(5^3=10\\), \\(5^4=4\\), so \\(x=4\\).";

describe("arithmeticFindings under the section's modulus", () => {
  it("reads an equality under a modulus the prose states once, and does not call it wrong", () => {
    expect(arithmeticFindings(shorSentence)).toEqual([]);
    // The same statements with no modulus anywhere are wrong integer arithmetic.
    expect(arithmeticFindings("One can calculate \\(5^2=2\\), \\(5^3=10\\), \\(5^4=4\\).").map((finding) => finding.reason)).toEqual([
      "5^2 = 25, but the statement gives 2.",
      "5^3 = 125, but the statement gives 10.",
      "5^4 = 625, but the statement gives 4."
    ]);
  });

  it("still finds an equality that fails under every modulus in scope, and says what it is under each", () => {
    expect(arithmeticFindings("Working modulo 23, \\(5^3=11\\).").map((finding) => finding.reason)).toEqual([
      "5^3 = 125, which is ≡ 10 (mod 23), but the statement gives 11."
    ]);
    // The printed RSA chain fails plainly and under its own modulus alike.
    expect(arithmeticFindings("Reduce \\(\\pmod{187}\\): \\(128^2=169\\).").map((finding) => finding.reason)).toEqual([
      "128^2 = 16384, which is ≡ 115 (mod 187), but the statement gives 169."
    ]);
  });

  it("collects the modulus from every way a section names it", () => {
    for (const phrase of [
      "arithmetic modulo 23", "mod 23", "(mod 23)", "\\(\\pmod{23}\\)", "\\(x \\bmod 23\\)", "the modulus is 23", "the modulus 23",
      "a modulus of 23", "modulo the prime 23", "the modulus \\(p = 23\\)", "modulo \\(23\\)", "Modulo 23,"
    ]) {
      expect(arithmeticFindings(`${phrase}: \\(5^2=2\\).`), phrase).toEqual([]);
    }
  });

  it("skips a failing equality in a section that speaks of a modulus it never names", () => {
    expect(arithmeticFindings("Working modulo the prime \\(p\\), \\(5^2=2\\) and \\(5^3=10\\).")).toEqual([]);
    expect(arithmeticFindings("Every residue is taken modulo \\(n\\); \\(2^{10}=1000\\).")).toEqual([]);
  });

  it("reads a congruence with no \\pmod of its own under the section's modulus", () => {
    expect(arithmeticFindings("Modulo 23: \\(5^2\\equiv2\\), \\(5^3\\equiv10\\).")).toEqual([]);
    expect(arithmeticFindings("Modulo 23: \\(5^3\\equiv11\\).").map((finding) => finding.reason)).toEqual([
      "5^3 ≡ 10 (mod 23), but the statement gives 11."
    ]);
    // Without a modulus anywhere a bare congruence stays unreadable, as before.
    expect(arithmeticFindings("\\(5^3\\equiv11\\)")).toEqual([]);
    // Its own trailing \pmod wins over the section's.
    expect(arithmeticFindings("Modulo 23: \\(5^3\\equiv6\\pmod{7}\\).")).toEqual([]);
    expect(arithmeticFindings("Modulo 23: \\(5^3\\equiv10\\pmod{7}\\).").map((finding) => finding.reason)).toEqual([
      "5^3 ≡ 6 (mod 7), but the statement gives 10 ≡ 3."
    ]);
  });

  it("scopes the modulus to the section under one heading", () => {
    const markdown = "## Diffie–Hellman\n\nAll arithmetic here is modulo 23, so \\(5^2=2\\).\n\n## Plain counting\n\nHere \\(5^2=2\\) is simply wrong.";
    expect(arithmeticFindings(markdown).map((finding) => finding.reason)).toEqual(["5^2 = 25, but the statement gives 2."]);
    // A chapter with no headings is one section: a modulus stated later still governs an earlier line.
    expect(arithmeticFindings("First \\(5^2=2\\) and \\(5^3=10\\). All of this was modulo 23.")).toEqual([]);
  });

  it("excuses an equality only under a modulus its right-hand side is a residue of", () => {
    // 1000 is a residue of neither modulus, so neither is consulted and the plain reason stands.
    expect(arithmeticFindings("Modulo 23 and modulo 7, \\(2^{10}=1000\\).").map((finding) => finding.reason)).toEqual([
      "2^10 = 1024, but the statement gives 1000."
    ]);
    // A chapter on XOR speaks of addition modulo 2; matching parity does not make a wrong product right.
    expect(arithmeticFindings("Addition modulo 2 is XOR. Elsewhere, \\(7\\cdot23=163\\).").map((finding) => finding.reason)).toEqual([
      "7·23 = 161, but the statement gives 163."
    ]);
    // Under two named moduli a residue that fits both is reported under both.
    expect(arithmeticFindings("Modulo 23 and modulo 29, \\(5^3=11\\).").map((finding) => finding.reason)).toEqual([
      "5^3 = 125, which is ≡ 10 (mod 23) and 9 (mod 29), but the statement gives 11."
    ]);
  });
});
