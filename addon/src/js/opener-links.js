export function collectSavedOpenerLinks(savedTabs, aligned) {
    const links = [];

    for (const [index, saved] of savedTabs.entries()) {
        const tab = aligned[index];
        const opener = aligned[index + saved?.openerOffset];

        if (saved?.openerOffset && opener && opener.id !== tab?.id && opener.windowId === tab?.windowId) {
            links.push([tab.id, opener.id]);
        }
    }

    return links;
}
