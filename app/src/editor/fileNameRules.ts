import {Constants} from "../constants";

const INVALID_FILE_NAME_CHARACTERS = /\r\n|\r|\n|\u2028|\u2029|\t/;
const INVALID_FILE_NAME_CHARACTERS_GLOBAL = /\r\n|\r|\n|\u2028|\u2029|\t/g;

export type FileNameViolation = "invalid-character" | "too-long";

export const truncateFileName = (name: string) => {
    let length = 0;
    let truncated = "";
    for (const character of name) {
        if (length === Constants.SIZE_TITLE) {
            break;
        }
        truncated += character;
        length++;
    }
    return truncated;
};

export const getFileNameViolation = (name: string): FileNameViolation | undefined => {
    if (INVALID_FILE_NAME_CHARACTERS.test(name)) {
        return "invalid-character";
    }
    let length = 0;
    for (const _character of name) {
        if (++length > Constants.SIZE_TITLE) {
            return "too-long";
        }
    }
};

export const normalizeFileName = (name: string) => {
    const normalized = name
        .replace(/\//g, "／")
        .replace(INVALID_FILE_NAME_CHARACTERS_GLOBAL, "");
    return {
        name: truncateFileName(normalized),
        replacedPathSeparator: name.includes("/"),
    };
};
