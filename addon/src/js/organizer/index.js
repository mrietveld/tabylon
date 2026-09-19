import {OrganizerClientError, generateGroupingPlan} from './client.js';
import {applyDraft} from './apply-plan.js';
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

function safeApplyFailure() {
    return {
        success: false,
        preflight: null,
        createdGroups: [],
        failure: {
            stage: 'workflow',
            message: 'The organizer plan could not be applied.',
        },
        rolledBack: false,
        rollbackFailures: [],
        retainedGroups: [],
    };
}

function applyInProgressResult() {
    return {
        success: false,
        preflight: null,
        createdGroups: [],
        failure: {
            stage: 'concurrency',
            code: 'apply-in-progress',
            message: 'This organizer draft is already being applied.',
        },
        rolledBack: false,
        rollbackFailures: [],
        retainedGroups: [],
    };
}

function applyRecoveryRequiredResult() {
    return {
        success: false,
        preflight: null,
        createdGroups: [],
        failure: {
            stage: 'concurrency',
            code: 'apply-recovery-required',
            message: 'A previous organizer apply was interrupted. Review the current tab groups before retrying.',
        },
        rolledBack: false,
        rollbackFailures: [],
        retainedGroups: [],
    };
}

function successfulState(result) {
    return {
        phase: 'apply',
        status: 'complete',
        applyResult: {
            success: true,
            createdGroups: result.createdGroups.map(group => ({
                groupId: group.groupId,
                tabCount: group.tabIds.length,
            })),
        },
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
    addGroup,
    moveTabs,
    restoreTabs,
    runOperation = (_name, operation) => operation(),
} = {}) {
    let operationSequence = 0;
    let serialization = Promise.resolve();
    const activeOperationTokens = new Set();

    function serialize(operation) {
        const result = serialization.then(operation, operation);
        serialization = result.catch(() => undefined);
        return result;
    }

    function createOperationToken(kind) {
        operationSequence += 1;
        return `${kind}-${Date.now()}-${operationSequence}`;
    }

    async function persist(state) {
        return setDraftState(state, storageArea);
    }

    async function loadState() {
        return (await getDraftState(storageArea)) ?? emptyState();
    }

    async function recoverInterruptedOperation(state) {
        const operation = state?.operation;
        if (!operation || activeOperationTokens.has(operation.token)) {
            return state;
        }

        if (operation.kind === 'apply') {
            const {operation: _operation, ...rest} = state;
            const applyResult = applyRecoveryRequiredResult();
            return persist({
                ...rest,
                phase: 'apply',
                status: 'error',
                error: {
                    code: 'apply-interrupted',
                    message: 'The organizer apply operation was interrupted. Review the current tab groups before retrying.',
                    status: null,
                },
                applyResult,
            });
        }

        const {operation: _operation, ...rest} = state;
        return persist({
            ...rest,
            phase: 'generate',
            status: 'error',
            plan: null,
            draft: null,
            error: {
                code: 'generation-interrupted',
                message: 'The organizer generation was interrupted. Try generating the plan again.',
                status: null,
            },
            applyResult: null,
        });
    }

    async function loadRecoverableState() {
        return recoverInterruptedOperation(await loadState());
    }

    async function getState() {
        return serialize(loadRecoverableState);
    }

    async function start(requestedParams = {}) {
        let params = null;
        let snapshot = null;
        const token = createOperationToken('generate');
        activeOperationTokens.add(token);

        try {
            const claimedState = await serialize(async () => {
                const state = await loadRecoverableState();
                if (state.operation?.kind === 'apply') {
                    return null;
                }
                return persist({
                    ...emptyState(),
                    phase: 'generate',
                    status: 'pending',
                    operation: {kind: 'generate', token},
                });
            });
            if (!claimedState) {
                return getState();
            }

            const configured = await getOptions();
            const serviceUrl = configured.organizerServiceUrl ?? ORGANIZER_DEFAULTS.serviceUrl;
            params = {
                scope: requestedParams.scope ?? configured.organizerDefaultScope ?? ORGANIZER_DEFAULTS.scope,
                minimumGroupSize: requestedParams.minimumGroupSize ?? configured.organizerMinimumGroupSize ?? ORGANIZER_DEFAULTS.minimumGroupSize,
                selectedTabIds: [...(requestedParams.selectedTabIds ?? [])],
            };

            const paramsPersisted = await serialize(async () => {
                const state = await loadState();
                if (state.operation?.token !== token) {
                    return null;
                }
                return persist({
                    ...state,
                    params,
                });
            });
            if (!paramsPersisted) {
                return getState();
            }

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

            return serialize(async () => {
                const state = await loadState();
                if (state.operation?.token !== token) {
                    return state;
                }
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
            });
        } catch (error) {
            return serialize(async () => {
                const state = await loadState();
                if (state.operation?.token !== token) {
                    return state;
                }
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
            });
        } finally {
            activeOperationTokens.delete(token);
        }
    }

    async function saveDraft(draft) {
        validateDraft(draft);
        return serialize(async () => {
            const state = await loadRecoverableState();
            if (state.operation?.kind === 'apply') {
                throw new Error('The organizer draft is currently being applied.');
            }

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

            return persist({
                ...state,
                phase: 'review',
                status: 'ready',
                draft: sanitizedDraft,
                error: null,
                applyResult: null,
            });
        });
    }

    async function refresh() {
        const state = await getState();
        return start(state.params ?? {});
    }

    async function clear() {
        return serialize(async () => {
            const state = await loadRecoverableState();
            if (state.operation?.kind === 'apply') {
                return state;
            }
            await clearDraftState(storageArea);
            return emptyState();
        });
    }

    async function apply(_submittedDraft) {
        const token = createOperationToken('apply');
        activeOperationTokens.add(token);
        try {
            const claim = await serialize(async () => {
                const storedState = await loadState();
                if (storedState.operation?.kind === 'apply') {
                    if (activeOperationTokens.has(storedState.operation.token)) {
                        return {blockedResult: applyInProgressResult()};
                    }
                    const recovered = await recoverInterruptedOperation(storedState);
                    return {blockedResult: recovered.applyResult};
                }
                const state = await recoverInterruptedOperation(storedState);
                if (!state.draft) {
                    throw new TypeError('There is no active organizer draft to apply');
                }
                await persist({
                    ...state,
                    phase: 'apply',
                    status: 'pending',
                    error: null,
                    applyResult: null,
                    operation: {kind: 'apply', token},
                });
                return {state, draft: state.draft};
            });
            if (claim.blockedResult) {
                return claim.blockedResult;
            }

            let result;
            let error = null;
            try {
                result = await runOperation('apply-grouping-plan', () => applyDraft(claim.draft, {
                    getTabs,
                    getTabGroup: getGroupId,
                    addGroup,
                    moveTabs,
                    restoreTabs,
                }));
            } catch (_applyError) {
                result = safeApplyFailure();
                error = {
                    code: 'apply-error',
                    message: result.failure.message,
                    status: null,
                };
            }

            await serialize(async () => {
                const state = await loadState();
                if (state.operation?.token !== token) {
                    return state;
                }
                return persist(result.success ? successfulState(result) : {
                    ...claim.state,
                    phase: 'apply',
                    status: 'error',
                    error,
                    applyResult: result,
                });
            });
            return result;
        } finally {
            activeOperationTokens.delete(token);
        }
    }

    return Object.freeze({
        getState,
        start,
        saveDraft,
        refresh,
        apply,
        clear,
    });
}
