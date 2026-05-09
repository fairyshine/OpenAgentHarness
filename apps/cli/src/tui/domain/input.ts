export function isReturnInput(input: string, key: { return?: boolean }) {
  return key.return === true || /[\r\n]/u.test(input);
}

export function cleanSingleLineInput(input: string) {
  return input.replace(/[\r\n]/gu, "");
}

export function cleanControlInput(input: string) {
  return cleanSingleLineInput(input).replace(/[\u0000-\u001f\u007f]/gu, "");
}

export function hasRawControl(input: string, code: string) {
  return input.includes(code);
}
