export interface HintSearchReferenceResponse {
    data: {
        blocks: Array<IBlock & {box: string; id: string}>;
    };
}

export interface HintSearchTagResponse {
    data: {
        k: string;
        tags: string[];
    };
}

export interface HintTemplateResponse {
    data: {
        content: string;
    };
}

export interface HintDocumentSavePathResponse {
    data: {
        box: string;
        path: string;
    };
}

export interface HintDocumentHPathResponse {
    data: string;
}
