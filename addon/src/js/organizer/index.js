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

        if (!state.snapshot || draft.requestId !== state.snapshot.requestId) {
            throw new TypeError('draft.requestId does not match the active snapshot requestId');
        }

        return persist({...state, draft, error: null});
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
