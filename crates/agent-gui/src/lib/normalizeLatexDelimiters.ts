type LatexDelimiter = "(" | ")" | "[" | "]";

type LatexDelimiterToken = {
  delimiter: LatexDelimiter;
  index: number;
};

function isEscaped(value: string, index: number) {
  let backslashCount = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === "\\"; cursor -= 1) {
    backslashCount += 1;
  }
  return backslashCount % 2 === 1;
}

function collectLatexDelimiterTokens(value: string) {
  const tokens: LatexDelimiterToken[] = [];
  for (let index = 0; index < value.length - 1; index += 1) {
    if (value[index] !== "\\" || isEscaped(value, index)) continue;
    const delimiter = value[index + 1];
    if (delimiter !== "(" && delimiter !== ")" && delimiter !== "[" && delimiter !== "]") {
      continue;
    }
    tokens.push({ delimiter, index });
    index += 1;
  }
  return tokens;
}

function nextClosingTokenIndexes(tokens: LatexDelimiterToken[]) {
  const closingIndexes = new Array<number>(tokens.length).fill(-1);
  let nextInlineClose = -1;
  let nextDisplayClose = -1;

  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    const delimiter = tokens[index].delimiter;
    if (delimiter === ")") {
      nextInlineClose = index;
    } else if (delimiter === "]") {
      nextDisplayClose = index;
    } else if (delimiter === "(") {
      closingIndexes[index] = nextInlineClose;
    } else {
      closingIndexes[index] = nextDisplayClose;
    }
  }

  return closingIndexes;
}

function normalizeLatexText(value: string, allowIncomplete: boolean) {
  const tokens = collectLatexDelimiterTokens(value);
  if (tokens.length === 0) return value;

  const closingIndexes = nextClosingTokenIndexes(tokens);
  let normalized = "";
  let sourceCursor = 0;

  for (let tokenIndex = 0; tokenIndex < tokens.length; tokenIndex += 1) {
    const token = tokens[tokenIndex];
    if (token.index < sourceCursor || (token.delimiter !== "(" && token.delimiter !== "[")) {
      continue;
    }

    const closingTokenIndex = closingIndexes[tokenIndex];
    if (closingTokenIndex < 0) {
      if (allowIncomplete) {
        normalized += `${value.slice(sourceCursor, token.index)}$$${value.slice(token.index + 2)}`;
        return normalized;
      }
      continue;
    }

    const closingToken = tokens[closingTokenIndex];
    normalized += `${value.slice(sourceCursor, token.index)}$$${value.slice(
      token.index + 2,
      closingToken.index,
    )}$$`;
    sourceCursor = closingToken.index + 2;
    tokenIndex = closingTokenIndex;
  }

  return normalized + value.slice(sourceCursor);
}

function lineEndAfter(value: string, index: number) {
  const newlineIndex = value.indexOf("\n", index);
  return newlineIndex < 0 ? value.length : newlineIndex + 1;
}

function fencedCodeEnd(value: string, lineStart: number) {
  const openingLineEnd = lineEndAfter(value, lineStart);
  const openingLine = value.slice(lineStart, openingLineEnd).replace(/\r?\n$/, "");
  const openingMatch =
    /^(?: {0,3}>[ \t]?)*(?: {0,3}(?:[-+*]|\d{1,9}[.)])[ \t]+)?[ \t]*(`{3,}|~{3,})(.*)$/.exec(
      openingLine,
    );
  if (!openingMatch) return -1;

  const marker = openingMatch[1][0];
  const markerLength = openingMatch[1].length;
  if (marker === "`" && openingMatch[2].includes("`")) return -1;

  let cursor = openingLineEnd;
  while (cursor < value.length) {
    const closingLineEnd = lineEndAfter(value, cursor);
    const closingLine = value.slice(cursor, closingLineEnd).replace(/\r?\n$/, "");
    const closingMatch = /^(?: {0,3}>[ \t]?)*[ \t]*(`+|~+)[ \t]*$/.exec(closingLine);
    if (closingMatch && closingMatch[1][0] === marker && closingMatch[1].length >= markerLength) {
      return closingLineEnd;
    }
    cursor = closingLineEnd;
  }

  return value.length;
}

function inlineCodeEnd(value: string, openingIndex: number) {
  let markerLength = 1;
  while (value[openingIndex + markerLength] === "`") markerLength += 1;
  const marker = "`".repeat(markerLength);
  let searchFrom = openingIndex + markerLength;

  while (searchFrom < value.length) {
    const closingIndex = value.indexOf(marker, searchFrom);
    if (closingIndex < 0) return -1;
    if (value[closingIndex - 1] !== "`" && value[closingIndex + markerLength] !== "`") {
      return closingIndex + markerLength;
    }
    searchFrom = closingIndex + markerLength;
  }

  return -1;
}

function htmlCodeEnd(value: string, lowerValue: string, openingIndex: number) {
  if (value.startsWith("<!--", openingIndex)) {
    const commentEnd = value.indexOf("-->", openingIndex + 4);
    return commentEnd < 0 ? value.length : commentEnd + 3;
  }

  const tagNameStart = value[openingIndex + 1] === "/" ? openingIndex + 2 : openingIndex + 1;
  const firstTagNameCharacter = value[tagNameStart];
  if (!firstTagNameCharacter || !/[a-z]/i.test(firstTagNameCharacter)) return -1;

  const openingTagEnd = value.indexOf(">", tagNameStart + 1);
  if (openingTagEnd < 0) return -1;
  const openingTag = lowerValue.slice(openingIndex, openingTagEnd + 1);
  const openingMatch = /^<(code|pre)(?:\s|\/?>)/.exec(openingTag);
  if (openingMatch) {
    const closingTag = `</${openingMatch[1]}>`;
    const closingTagIndex = lowerValue.indexOf(closingTag, openingTagEnd + 1);
    return closingTagIndex < 0 ? value.length : closingTagIndex + closingTag.length;
  }

  return openingTagEnd + 1;
}

export function normalizeLatexDelimiters(content: string, allowIncomplete = false) {
  if (!content.includes("\\")) return content;

  let lowerContent: string | null = null;
  let normalized = "";
  let plainStart = 0;
  let index = 0;

  while (index < content.length) {
    let protectedEnd = -1;
    if (index === 0 || content[index - 1] === "\n") {
      protectedEnd = fencedCodeEnd(content, index);
    }
    if (protectedEnd < 0 && content[index] === "`" && !isEscaped(content, index)) {
      protectedEnd = inlineCodeEnd(content, index);
    }
    if (protectedEnd < 0 && content[index] === "<") {
      lowerContent ??= content.toLowerCase();
      protectedEnd = htmlCodeEnd(content, lowerContent, index);
    }

    if (protectedEnd > index) {
      normalized += normalizeLatexText(content.slice(plainStart, index), allowIncomplete);
      normalized += content.slice(index, protectedEnd);
      plainStart = protectedEnd;
      index = protectedEnd;
      continue;
    }

    index += 1;
  }

  return normalized + normalizeLatexText(content.slice(plainStart), allowIncomplete);
}
