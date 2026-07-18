type CoverEntry = TProtyleApplicationSettingsPort["cover"]["entries"][number];

export interface CoverData {
    readonly categories: readonly string[];
    readonly coversByCategory: ReadonlyMap<string, readonly CoverEntry[]>;
    readonly allCovers: readonly CoverEntry[];
}

export const createCoverData = (settings: TProtyleApplicationSettingsPort): CoverData => {
    const categories: string[] = [];
    const coversByCategory = new Map<string, CoverEntry[]>();

    settings.cover.entries.forEach((cover) => {
        let categoryCovers = coversByCategory.get(cover.category);
        if (!categoryCovers) {
            categoryCovers = [];
            coversByCategory.set(cover.category, categoryCovers);
            categories.push(cover.category);
        }
        categoryCovers.push(cover);
    });

    return {
        categories,
        coversByCategory,
        allCovers: settings.cover.entries,
    };
};
