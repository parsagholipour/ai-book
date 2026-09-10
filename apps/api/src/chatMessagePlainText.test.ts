import { describe, expect, it } from "vitest";
import { chatMessagePlainText, chatMessagePreviewSource, chatRoleIsUser } from "./chatMessagePlainText.js";

/** Shared with `apps/mobile/test/projects/chat_markdown_test.dart`. Expected strings from Dart. */
const fixtures: [input: string, expected: string][] = [
  [
    "### Verified\nThe **Paraguayan War** was *the deadliest* [see](https://example.org/x) `1864` [source:src_a:2:93000].",
    "Verified\nThe Paraguayan War was the deadliest see `1864` ."
  ],
  [
    "Here's what I found:\n1. **Chaco War**, 1932–1935\n- Bolivia vs Paraguay\n  * nested",
    "Here's what I found:\n1. Chaco War, 1932–1935\n• Bolivia vs Paraguay\n• nested"
  ],
  [
    "Peru-Bolivia, 1780-1782, file_name_here, 5 * 3 and **oops",
    "Peru-Bolivia, 1780-1782, file_name_here, 5 * 3 and **oops"
  ],
  ["Use this:\n```js\nconst x = 1;\n```\nDone.", "Use this:\nconst x = 1;\nDone."],
  ["```\n**bold**\n1. a", "```\nbold\n1. a"],
  ["---", "---"],
  [
    "Found:\n1. **Chaco War**, 1932\n- Bolivia [source:src_a:2:1]\n## Head\n`code`",
    "Found:\n1. Chaco War, 1932\n• Bolivia\nHead\n`code`"
  ],
  ["۱. سلام\n۲. خداحافظ", "۱. سلام\n۲. خداحافظ"]
];

describe("chatMessagePlainText", () => {
  it("agrees with the Dart twin on the shared fixtures", () => {
    for (const [input, expected] of fixtures) {
      expect(chatMessagePlainText(input)).toBe(expected);
    }
  });
});

describe("chatRoleIsUser", () => {
  it("is true only for the user role", () => {
    expect(chatRoleIsUser("user")).toBe(true);
    expect(chatRoleIsUser("USER")).toBe(true);
    expect(chatRoleIsUser("assistant")).toBe(false);
  });
});

describe("chatMessagePreviewSource", () => {
  it("keeps a user's **note** marked up and strips an assistant one", () => {
    expect(chatMessagePreviewSource("user", "**note**")).toBe("**note**");
    expect(chatMessagePreviewSource("assistant", "**note**")).toBe("note");
  });
});
