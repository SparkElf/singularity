export const emojiCodepointsToString = (unicode: string) => unicode
    .split("-")
    .map((part) => String.fromCodePoint(parseInt(part, 16)))
    .join("");
