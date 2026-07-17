import assert from "node:assert/strict";
import test from "node:test";

import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const { normalizeLatexDelimiters } = loader.loadModule(
  "src/lib/normalizeLatexDelimiters.ts",
);

test("normalizes LaTeX display and inline delimiters for Streamdown math", () => {
  const content = String.raw`2. 拉普拉斯形式

\[
H = 18400(1 + \frac{t}{273})\log_{10}\frac{p_0}{p}
\]

其中 \(p_0\) 是海平面气压。`;

  assert.equal(
    normalizeLatexDelimiters(content),
    String.raw`2. 拉普拉斯形式

$$
H = 18400(1 + \frac{t}{273})\log_{10}\frac{p_0}{p}
$$

其中 $$p_0$$ 是海平面气压。`,
  );
});

test("preserves existing dollar math and escaped LaTeX delimiters", () => {
  const content = String.raw`已有 $$x^2$$，字面量 \\(x\\) 和 \\[x\\]。`;
  assert.equal(normalizeLatexDelimiters(content), content);
});

test("does not normalize delimiters inside Markdown or HTML code", () => {
  const content = [
    "正文 \\(x\\)。",
    "",
    "`inline \\(x\\)`",
    "",
    "```latex",
    "\\[",
    "x",
    "\\]",
    "```",
    "",
    "~~~text",
    "\\(x\\)",
    "~~~",
    "",
    "<code>\\(x\\)</code>",
    "<pre>\\[",
    "x",
    "\\]</pre>",
  ].join("\n");

  const expected = [
    "正文 $$x$$。",
    "",
    "`inline \\(x\\)`",
    "",
    "```latex",
    "\\[",
    "x",
    "\\]",
    "```",
    "",
    "~~~text",
    "\\(x\\)",
    "~~~",
    "",
    "<code>\\(x\\)</code>",
    "<pre>\\[",
    "x",
    "\\]</pre>",
  ].join("\n");

  assert.equal(normalizeLatexDelimiters(content), expected);
});

test("preserves fenced code nested in blockquotes and lists", () => {
  const content = [
    "> ```latex",
    "> \\[",
    "> x",
    "> \\]",
    "> ```",
    "",
    "- ```latex",
    "  \\(",
    "  x",
    "  \\)",
    "  ```",
  ].join("\n");

  assert.equal(normalizeLatexDelimiters(content, true), content);
});

test("keeps incomplete delimiters static and enables streaming completion", () => {
  const content = String.raw`推导中：\[
H = 18400`;
  assert.equal(normalizeLatexDelimiters(content), content);
  assert.equal(normalizeLatexDelimiters(content, true), String.raw`推导中：$$
H = 18400`);
});
