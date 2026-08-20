import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const fuzzySearch = loader.loadModule("@liveagent/ui/lib/shared/fuzzySearch.ts");
const uiRoot = new URL("../../../agent-ui/src/", import.meta.url);

function readUiSource(path) {
  return readFileSync(new URL(path, uiRoot), "utf8");
}

test("fuzzy search handles multiple terms, separators, full-width text, and small typos", () => {
  assert.notEqual(
    fuzzySearch.fuzzySearchScore("code review", ["liveagent-code-review", "Review pull requests"]),
    null,
  );
  assert.notEqual(fuzzySearch.fuzzySearchScore("githb", ["GitHub integration"]), null);
  assert.notEqual(fuzzySearch.fuzzySearchScore("skillcreator", ["skill-creator"]), null);
  assert.equal(fuzzySearch.normalizeSearchText("ＧｉｔＨｕｂ"), "github");
  assert.equal(fuzzySearch.fuzzySearchScore("calendar", ["GitHub integration"]), null);
});

test("local fuzzy results are filtered and ranked without disturbing equal-score order", () => {
  const items = [
    { name: "review-notes", description: "Document review feedback" },
    { name: "liveagent-code-review", description: "Review a pull request" },
    { name: "calendar", description: "Manage events" },
  ];
  const ranked = fuzzySearch.rankFuzzySearchResults(
    items,
    "code revie",
    (item) => [item.name, item.description],
  );

  assert.deepEqual(
    ranked.map((item) => item.name),
    ["liveagent-code-review"],
  );
});

test("remote fuzzy ranking keeps unmatched server results after relevant matches", () => {
  const items = [{ name: "calendar" }, { name: "github" }, { name: "database" }];
  const ranked = fuzzySearch.rankFuzzySearchResults(items, "githb", (item) => [item.name], {
    includeUnmatched: true,
  });

  assert.equal(ranked[0].name, "github");
  assert.deepEqual(
    ranked.slice(1).map((item) => item.name),
    ["calendar", "database"],
  );
});

test("search highlighting marks exact terms and the closest fuzzy word", () => {
  assert.deepEqual(fuzzySearch.getSearchHighlightRanges("GitHub integration", "git hub"), [
    { start: 0, end: 6 },
  ]);
  assert.deepEqual(fuzzySearch.getSearchHighlightRanges("Connect GitHub safely", "githb"), [
    { start: 8, end: 14 },
  ]);
});

test("Skills and MCP result cards share fuzzy ranking and keyword highlighting", () => {
  const installedSkills = readUiSource("pages/skills-hub/InstalledSkillCard.tsx");
  const importedSkills = readUiSource("pages/skills-hub/SkillsImportView.tsx");
  const storeSkills = readUiSource("pages/skills-hub/SkillsStoreView.tsx");
  const installedMcp = readUiSource("pages/mcp-hub/McpServersForm.tsx");
  const storeMcp = readUiSource("pages/mcp-hub/McpRegistryBrowser.tsx");

  assert.match(installedSkills, /<SearchHighlight[\s\S]*text=\{skill\.name\}/);
  assert.match(importedSkills, /rankFuzzySearchResults\(scan\.skills/);
  assert.match(storeSkills, /includeUnmatched: true/);
  assert.match(installedMcp, /rankFuzzySearchResults\(/);
  assert.match(storeMcp, /submittedQuery[\s\S]*includeUnmatched: true/);
  assert.match(storeMcp, /<RegistryCard[\s\S]*searchQuery=\{submittedQuery\}/);
});
