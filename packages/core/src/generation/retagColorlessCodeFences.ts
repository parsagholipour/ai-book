/**
 * highlight.js colours a fence only when the info string is a language it
 * knows. `text` and an empty tag are plaintext the lock may rewrite. An
 * explicit `pseudocode` or `pseudo` tag stays plaintext. A listing that is
 * code keeps its bytes; only a colourless tag is rewritten.
 */
const COLORLESS_FENCE_TAG = /^(?:text)?$/i;

export function retagColorlessCodeFences(markdown: string): string {
  const lines = markdown.split("\n");
  const out: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const open = line.match(/^([ \t]{0,3})(```|~~~)(\S*)(.*)$/);
    if (!open) {
      out.push(line);
      continue;
    }
    const indent = open[1]!;
    const marker = open[2]!;
    const tag = open[3]!;
    const rest = open[4]!;
    const closer = new RegExp(`^[ \\t]{0,3}${marker}[ \\t]*$`);
    let end = index + 1;
    while (end < lines.length && !closer.test(lines[end]!)) {
      end += 1;
    }
    const body = lines.slice(index + 1, end).join("\n");
    const language = COLORLESS_FENCE_TAG.test(tag) && !/^figure$/i.test(tag) ? inferCodeFenceLanguage(body) : undefined;
    out.push(language ? `${indent}${marker}${language}${rest}` : line);
    if (end < lines.length) {
      out.push(...lines.slice(index + 1, end + 1));
      index = end;
    } else {
      out.push(...lines.slice(index + 1));
      break;
    }
  }
  return out.join("\n");
}

function inferCodeFenceLanguage(code: string): string | undefined {
  if (!looksLikeCode(code)) return undefined;
  if (/\b(?:elif\b|lambda\b|None\b|True\b|False\b|self\.|def\s+\w+\s*\()/.test(code)) return "python";
  if (/^\s*fn\s|\blet mut\b|\bimpl\b|\bpub\s+(?:fn|struct|enum)\b/.test(code)) return "rust";
  if (/\bfunc\s+\w+|\bfmt\.|:=/.test(code)) return "go";
  if (/\b(?:interface |type |enum )\w+|:\s*(?:string|number|boolean)\b/.test(code) && /[{;]/.test(code)) return "typescript";
  if (/\b(?:const |let |function |=>|===|console\.)/.test(code)) return "javascript";
  if (/\b(?:public |private |class |void |System\.)/.test(code)) return "java";
  if (/#include\b|std::/.test(code)) return "cpp";
  if (/\b(?:SELECT|FROM|WHERE|INSERT|UPDATE)\b/.test(code)) return "sql";
  if (/^#!|\becho\b|\bexport\s+\w+=/.test(code)) return "bash";
  if (/^\s*(?:if|for|while|else|elif)\b.*:\s*$/m.test(code) || /^\s*\w+\s*\(.*\)\s*:\s*$/m.test(code)) return "python";
  return undefined;
}

function looksLikeCode(code: string): boolean {
  const lines = code.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return false;
  const codey = lines.filter((line) => lineLooksLikeCode(line));
  return codey.length >= 1 && codey.length * 4 >= lines.length;
}

function lineLooksLikeCode(line: string): boolean {
  if (/[=<>]=|=>|:=|\/\/|[{;]$/.test(line)) return true;
  if (/^\w+\s*\([^)]*\)\s*:?\s*$/.test(line)) return true;
  if (/^(?:elif|def|const|let|var|fn|func)\b/i.test(line) || /^else:/i.test(line)) return true;
  const keyword = /^(?:if|for|while|return|function|class|pub|select)\b/i.exec(line);
  return keyword !== null && /[:({=]/.test(line.slice(keyword[0].length));
}
