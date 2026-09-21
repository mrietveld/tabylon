import {OrganizerClientError, generateGroupingPlan} from './client.js';
import {applyDraft} from './apply-plan.js';
import {createDraft, validateDraft} from './draft.js';
import {clearDraftState, getDraftState, setDraftState} from './draft-store.js';
import {collectSnapshot, OrganizerSnapshotError} from './snapshot.js';

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

function stringifyValue(value, fallback) {
    try {
        return String(value);
    } catch (_error) {
        return fallback;
    }
}

function stringProperty(value, property, fallback) {
    try {
        const propertyValue = value[property];
        return propertyValue == null ? fallback : stringifyValue(propertyValue, fallback);
    } catch (_error) {
        return fallback;
    }
}

function stackProperty(value) {
    try {
        const stack = value.stack;
        return typeof stack === 'string' ? stack : null;
    } catch (_error) {
        return null;
    }
}

function causeProperty(value) {
    try {
        return value.cause;
    } catch (_error) {
        return undefined;
    }
}

function isInstanceOf(value, constructor) {
    try {
        return value instanceof constructor;
    } catch (_error) {
        return false;
    }
}

function technicalCause(cause) {
    if (cause == null) {
        return null;
    }
    if (!isInstanceOf(cause, Error)) {
        return {
            name: 'NonError',
            message: stringifyValue(cause, 'Unable to stringify error cause.'),
            stack: null,
        };
    }
    return {
        name: stringProperty(cause, 'name', 'Error'),
        message: stringProperty(cause, 'message', ''),
        stack: stackProperty(cause),
    };
}

function technicalException(error) {
    if (!isInstanceOf(error, Error)) {
        return {
            name: 'NonError',
            message: stringifyValue(error, 'Unable to stringify thrown value.'),
            stack: null,
            cause: null,
        };
    }
    return {
        name: stringProperty(error, 'name', 'Error'),
        message: stringProperty(error, 'message', ''),
        stack: stackProperty(error),
        cause: technicalCause(causeProperty(error)),
    };
}

function clientDiagnostic(error) {
    try {
        const toJSON = error.toJSON;
        if (typeof toJSON !== 'function') {
            return null;
        }
        const diagnostic = toJSON.call(error);
        const code = diagnostic?.code;
        const message = diagnostic?.message;
        const status = diagnostic?.status;
        if (!diagnostic || typeof diagnostic !== 'object' ||
            typeof code !== 'string' || typeof message !== 'string' ||
            (status !== null && !Number.isFinite(status))) {
            return null;
        }
        return {code, message, status};
    } catch (_error) {
        return null;
    }
}

function snapshotErrorCode(error) {
    try {
        const code = error.code;
        return typeof code === 'string' ? code : null;
    } catch (_error) {
        return null;
    }
}

function safeGenerationDiagnostic(error, stage) {
    const technical = technicalException(error);
    if (isInstanceOf(error, OrganizerClientError)) {
        const diagnostic = clientDiagnostic(error);
        if (diagnostic) {
            return {...diagnostic, stage, technicalException: technical};
        }
    }

    if (stage === 'snapshot' && isInstanceOf(error, OrganizerSnapshotError) &&
        snapshotErrorCode(error) === 'too-many-eligible-tabs') {
        return {
            code: 'too-many-eligible-tabs',
            message: 'The organizer can organize at most 500 eligible tabs at once. Choose a smaller scope and try again.',
            status: null,
            stage,
            technicalException: technical,
        };
    }

    const diagnosticsByStage = {
        settings: {
            code: 'settings-load-failed',
            message: 'The organizer settings could not be loaded.',
        },
        tabs: {
            code: 'tab-read-failed',
            message: 'The organizer could not read the tabs to organize.',
        },
        snapshot: {
            code: 'snapshot-preparation-failed',
            message: 'The organizer could not prepare the selected tabs.',
        },
        plan: {
            code: 'plan-generation-failed',
            message: 'The organizer could not generate a grouping plan.',
        },
        draft: {
            code: 'draft-creation-failed',
            message: 'The organizer could not create an editable draft.',
        },
    };
    return {...diagnosticsByStage[stage], status: null, stage, technicalException: technical};
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
    reportGenerationFailure = () => undefined,
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
            snapshot: null,
            plan: null,
            draft: null,
                error: {
                    code: 'generation-interrupted',
                    message: 'The organizer generation was interrupted. Try generating the plan again.',
                    status: null,
                    stage: 'generation',
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
        let generationStage = 'settings';
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

            generationStage = 'tabs';
            const currentWindow = await getCurrentWindow();
            const tabs = await getTabs();
            generationStage = 'snapshot';
            snapshot = await collectSnapshot({
                ...params,
                currentWindowId: currentWindow?.id ?? null,
                currentGroupId: currentWindow?.groupId ?? null,
            }, {
                getTabs: async () => tabs,
                getGroupId,
                isCanNotBeHidden,
                createRequestId,
                now,
            });
            generationStage = 'plan';
            const plan = await generateGroupingPlan(serviceUrl, snapshot, {fetchImpl});
            generationStage = 'draft';
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
            const diagnostic = safeGenerationDiagnostic(error, generationStage);
            try {
                Promise.resolve(reportGenerationFailure(diagnostic)).catch(() => undefined);
            } catch (_reportError) {
                // Reporting must not alter organizer behavior.
            }
            return serialize(async () => {
                const state = await loadState();
                if (state.operation?.token !== token) {
                    return state;
                }
                return persist({
                    phase: 'generate',
                    status: 'error',
                    params,
                    snapshot: null,
                    plan: null,
                    draft: null,
                    error: diagnostic,
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
