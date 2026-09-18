export const DRAFT_STATE_STORAGE_KEY = 'smart-organizer-draft';

function defaultStorageArea() {
    return browser.storage.session;
}

export async function getDraftState(storageArea = defaultStorageArea()) {
    const stored = await storageArea.get(DRAFT_STATE_STORAGE_KEY);
    return stored[DRAFT_STATE_STORAGE_KEY] ?? null;
}

export async function setDraftState(state, storageArea = defaultStorageArea()) {
    await storageArea.set({[DRAFT_STATE_STORAGE_KEY]: state});
    return state;
}

export async function clearDraftState(storageArea = defaultStorageArea()) {
    await storageArea.remove(DRAFT_STATE_STORAGE_KEY);
}
