export interface ProtyleReadOnlyState {
    host: boolean;
    document: boolean;
    documentUpdatePending: boolean;
}

export const createProtyleReadOnlyState = (host: boolean): ProtyleReadOnlyState => ({
    host,
    document: false,
    documentUpdatePending: false,
});

export const isProtyleReadOnly = (state: ProtyleReadOnlyState) => state.host || state.document;

export const canWriteProtyleContent = (state: ProtyleReadOnlyState) => !isProtyleReadOnly(state);

export const setHostReadOnly = (state: ProtyleReadOnlyState, readOnly: boolean) => {
    state.host = readOnly;
};

export const setDocumentReadOnlyFromResponse = (state: ProtyleReadOnlyState, readOnly: boolean) => {
    state.document = readOnly;
};

export const canChangeDocumentReadOnly = (state: ProtyleReadOnlyState) =>
    !state.host && !state.documentUpdatePending;

export const setDocumentReadOnlyAttribute = async (
    state: ProtyleReadOnlyState,
    readOnly: boolean,
    request: (readOnly: boolean) => Promise<boolean>,
) => {
    if (!canChangeDocumentReadOnly(state)) {
        return false;
    }

    const previousDocumentReadOnly = state.document;
    state.documentUpdatePending = true;
    try {
        state.document = await request(readOnly);
        return true;
    } catch (error) {
        state.document = previousDocumentReadOnly;
        throw error;
    } finally {
        state.documentUpdatePending = false;
    }
};
