// Extracted from official_claude_code tools logic for high-fidelity file edits

export const LEFT_SINGLE_CURLY_QUOTE = '‘';
export const RIGHT_SINGLE_CURLY_QUOTE = '’';
export const LEFT_DOUBLE_CURLY_QUOTE = '“';
export const RIGHT_DOUBLE_CURLY_QUOTE = '”';

/**
 * Normalizes quotes in a string by converting curly quotes to straight quotes
 */
export function normalizeQuotes(str: string): string {
  return str
    .replaceAll(LEFT_SINGLE_CURLY_QUOTE, "'")
    .replaceAll(RIGHT_SINGLE_CURLY_QUOTE, "'")
    .replaceAll(LEFT_DOUBLE_CURLY_QUOTE, '"')
    .replaceAll(RIGHT_DOUBLE_CURLY_QUOTE, '"');
}

/**
 * Strips trailing whitespace from each line in a string while preserving line endings
 */
export function stripTrailingWhitespace(str: string): string {
  const lines = str.split(/(\r\n|\n|\r)/);
  let result = '';
  for (let i = 0; i < lines.length; i++) {
    const part = lines[i];
    if (part !== undefined) {
      if (i % 2 === 0) {
        result += part.replace(/\s+$/, '');
      } else {
        result += part;
      }
    }
  }
  return result;
}

/**
 * Finds the actual string in the file content that matches the search string,
 * accounting for quote normalization
 */
export function findActualString(fileContent: string, searchString: string): string | null {
  if (fileContent.includes(searchString)) {
    return searchString;
  }
  const normalizedSearch = normalizeQuotes(searchString);
  const normalizedFile = normalizeQuotes(fileContent);

  const searchIndex = normalizedFile.indexOf(normalizedSearch);
  if (searchIndex !== -1) {
    return fileContent.substring(searchIndex, searchIndex + searchString.length);
  }
  return null;
}

/**
 * Preserves curly quote formatting from the original file when writing the replacement string
 */
export function preserveQuoteStyle(oldString: string, actualOldString: string, newString: string): string {
  if (oldString === actualOldString) return newString;

  const hasDoubleQuotes = actualOldString.includes(LEFT_DOUBLE_CURLY_QUOTE) || actualOldString.includes(RIGHT_DOUBLE_CURLY_QUOTE);
  const hasSingleQuotes = actualOldString.includes(LEFT_SINGLE_CURLY_QUOTE) || actualOldString.includes(RIGHT_SINGLE_CURLY_QUOTE);

  if (!hasDoubleQuotes && !hasSingleQuotes) return newString;

  let result = newString;
  if (hasDoubleQuotes) result = applyCurlyDoubleQuotes(result);
  if (hasSingleQuotes) result = applyCurlySingleQuotes(result);

  return result;
}

function isOpeningContext(chars: string[], index: number): boolean {
  if (index === 0) return true;
  const prev = chars[index - 1];
  return (
    prev === ' ' || prev === '\t' || prev === '\n' || prev === '\r' ||
    prev === '(' || prev === '[' || prev === '{' ||
    prev === '\u2014' || prev === '\u2013'
  );
}

function applyCurlyDoubleQuotes(str: string): string {
  const chars = [...str];
  const result: string[] = [];
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] === '"') {
      result.push(isOpeningContext(chars, i) ? LEFT_DOUBLE_CURLY_QUOTE : RIGHT_DOUBLE_CURLY_QUOTE);
    } else {
      result.push(chars[i]!);
    }
  }
  return result.join('');
}

function applyCurlySingleQuotes(str: string): string {
  const chars = [...str];
  const result: string[] = [];
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] === "'") {
      const prev = i > 0 ? chars[i - 1] : undefined;
      const next = i < chars.length - 1 ? chars[i + 1] : undefined;
      const prevIsLetter = prev !== undefined && /\p{L}/u.test(prev);
      const nextIsLetter = next !== undefined && /\p{L}/u.test(next);
      if (prevIsLetter && nextIsLetter) {
        result.push(RIGHT_SINGLE_CURLY_QUOTE);
      } else {
        result.push(isOpeningContext(chars, i) ? LEFT_SINGLE_CURLY_QUOTE : RIGHT_SINGLE_CURLY_QUOTE);
      }
    } else {
      result.push(chars[i]!);
    }
  }
  return result.join('');
}

/**
 * Applies an edit conditionally replacing either all matches or the first match
 */
export function applyEditToFile(originalContent: string, oldString: string, newString: string, replaceAll: boolean = false): string {
  const f = replaceAll
    ? (content: string, search: string, replace: string) => content.replaceAll(search, () => replace)
    : (content: string, search: string, replace: string) => content.replace(search, () => replace);

  if (newString !== '') {
    return f(originalContent, oldString, newString);
  }

  const stripTrailingNewline = !oldString.endsWith('\n') && originalContent.includes(oldString + '\n');
  return stripTrailingNewline
    ? f(originalContent, oldString + '\n', newString)
    : f(originalContent, oldString, newString);
}
