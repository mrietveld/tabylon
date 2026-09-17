export const TREE_STYLE_TAB_IDS = Object.freeze([
    'treestyletab@piro.sakura.ne.jp',
    '{8d808887-ed13-4931-9f5a-4c0bff979a5a}',
]);

export async function isTreeStyleTabEnabled(management = browser.management) {
    try {
        const extensions = await Promise.all(TREE_STYLE_TAB_IDS.map(id => management.get(id)));
        return extensions.some(extension => extension?.enabled === true);
    } catch {
        return false;
    }
}
