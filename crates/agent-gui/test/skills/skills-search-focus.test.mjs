import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
  new URL("../../../agent-ui/src/pages/skills-hub/SkillsHubPage.tsx", import.meta.url),
  "utf8",
);

test("Skills search uses the standard Input focus border without an extra focus ring", () => {
  const searchInput = source.match(
    /<Input\s+[\s\S]*?placeholder=\{[\s\S]*?className="([^"]*h-11 rounded-full[^"]*)"/,
  );

  assert.ok(searchInput, "Skills Hub search input should keep its rounded search styling");
  assert.doesNotMatch(searchInput[1], /focus-visible:ring-[12]/);
  assert.doesNotMatch(searchInput[1], /focus-visible:border-ring/);
});
