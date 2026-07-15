export interface AgentBlockMention {
    id: string;
    label: string;
}

interface AgentReferenceTextResponse {
    code: number;
    msg: string;
    data?: unknown;
}

export const resolveAgentBlockMentions = async (
    blockIds: readonly string[],
    loadReferenceText: (blockId: string) => Promise<AgentReferenceTextResponse>,
): Promise<AgentBlockMention[]> => {
    const ids = blockIds.filter((id) => id.length > 0);
    const responses = await Promise.all(ids.map((id) => loadReferenceText(id)));
    const failedResponse = responses.find((response) => response.code !== 0);
    if (failedResponse) {
        throw new Error(failedResponse.msg);
    }
    return responses.map((response, index) => {
        if (typeof response.data !== "string" || response.data.length === 0) {
            throw new Error(response.msg);
        }
        return {
            id: ids[index],
            label: response.data,
        };
    });
};
