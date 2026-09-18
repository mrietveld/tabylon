import {OrganizerClientError, generateGroupingPlan} from './client.js';
import {createDraft, validateDraft} from './draft.js';
import {clearDraftState, getDraftState, setDraftState} from './draft-store.js';
import {collectSnapshot} from './snapshot.js';

export const ORGANIZER_DEFAULTS = Object.freeze({
    serviceUrl: 'http://127.0.0.1:5050',
    minimumGroupSize: 5,
    scope: 'ungrouped-current-window',
});

function emptyState() {
    return {
        phase: 'choose',
        status: 'idle',
        params: null,
        snapshot: null,
        plan: null,
        draft: null,
        error: null,
        applyResult: null,
    };
}

function safeError(error) {
    if (error instanceof OrganizerClientError) {
        return error.toJSON();
    }

    return {
        code: 'workflow-error',
        message: 'The organizer workflow could not be completed.',
        status: null,
    };
}

function sameStoredValue(left, right) {
    if (Object.is(left, right)) {
        return true;
    }
    if (Array.isArray(left) || Array.isArray(right)) {
        return Array.isArray(left) && Array.isArray(right) &&
            left.length === right.length && left.every((value, index) => sameStoredValue(value, right[index]));
    }
    if (!left || !right || typeof left !== 'object' || typeof right !== 'object') {
        return false;
    }

    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return leftKeys.length === rightKeys.length && leftKeys.every(key =>
        Object.hasOwn(right, key) && sameStoredValue(left[key], right[key]));
}

export function createOrganizerWorkflow({
    getOptions = () => ({}),
    getTabs,
    getCurrentWindow = async () => null,
    getGroupId,
    isCanNotBeHidden,
    fetchImpl = globalThis.fetch,
    storageArea,
    createRequestId,
    now,
} = {}) {
    async function persist(state) {
        return setDraftState(state, storageArea);
    }

    async function getState() {
        return (await getDraftState(storageArea)) ?? emptyState();
    }

    async function start(requestedParams = {}) {
        let params = null;
        let snapshot = null;

        try {
            const configured = await getOptions();
            const serviceUrl = configured.organizerServiceUrl ?? ORGANIZER_DEFAULTS.serviceUrl;
            params = {
                scope: requestedParams.scope ?? configured.organizerDefaultScope ?? ORGANIZER_DEFAULTS.scope,
                minimumGroupSize: requestedParams.minimumGroupSize ?? configured.organizerMinimumGroupSize ?? ORGANIZER_DEFAULTS.minimumGroupSize,
                selectedTabIds: [...(requestedParams.selectedTabIds ?? [])],
            };

            await persist({
                ...emptyState(),
                phase: 'generate',
                status: 'pending',
                params,
            });

            const currentWindow = await getCurrentWindow();
            snapshot = await collectSnapshot({
                ...params,
                currentWindowId: currentWindow?.id ?? null,
                currentGroupId: currentWindow?.groupId ?? null,
            }, {
                getTabs,
                getGroupId,
                isCanNotBeHidden,
                createRequestId,
                now,
            });
            const plan = await generateGroupingPlan(serviceUrl, snapshot, {fetchImpl});
            const draft = createDraft(snapshot, plan);

            return persist({
                phase: 'review',
                status: 'ready',
                params,
                snapshot,
                plan,
                draft,
                error: null,
                applyResult: null,
            });
        } catch (error) {
            return persist({
                phase: 'generate',
                status: 'error',
                params,
                snapshot,
                plan: null,
                draft: null,
                error: safeError(error),
                applyResult: null,
            });
        }
    }

    async function saveDraft(draft) {
        validateDraft(draft);
        const state = await getState();

        if (!state.snapshot || !state.plan || draft.requestId !== state.snapshot.requestId) {
            throw new TypeError('draft.requestId does not match the active snapshot requestId');
        }

        if (draft.planId !== state.plan.planId) {
            throw new TypeError('draft.planId does not match the active planId');
        }

        if (!sameStoredValue(draft.snapshot, state.snapshot)) {
            throw new TypeError('draft.snapshot does not match the active snapshot');
        }

        const canonicalDraft = createDraft(state.snapshot, state.plan);
        const canonicalGroups = new Map(canonicalDraft.groups.map(group => [group.id, group]));
        const groups = draft.groups.map(group => {
            const canonicalGroup = canonicalGroups.get(group.id);
            if (!canonicalGroup) {
                throw new TypeError(`draft contains unknown group ${group.id}`);
            }
            return {
                ...canonicalGroup,
                name: group.name,
                tabIds: [...group.tabIds],
            };
        });
        const sanitizedDraft = validateDraft({
            ...canonicalDraft,
            groups,
            unassignedTabIds: [...draft.unassignedTabIds],
        });

        return persist({...state, draft: sanitizedDraft, error: null});
    }

    async function refresh() {
        const state = await getState();
        return start(state.params ?? {});
    }

    async function clear() {
        await clearDraftState(storageArea);
        return emptyState();
    }

    return Object.freeze({
        getState,
        start,
        saveDraft,
        refresh,
        clear,
    });
}
