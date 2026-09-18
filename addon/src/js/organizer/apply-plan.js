import {validateDraft} from './draft.js';

function assignedTabIds(draft) {
    return draft.groups.flatMap(group => group.tabIds);
}

function normalizedGroupId(groupId) {
    return groupId ?? null;
}

function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}

function groupIds(groups) {
    if (!Array.isArray(groups)) {
        throw new TypeError('getGroups must return an array');
    }
    return groups.map(group => group?.id).filter(id => typeof id === 'string' && id);
}

export function createTrackedAddGroupOperation({getGroups, addGroup} = {}) {
    if (typeof getGroups !== 'function') {
        throw new TypeError('getGroups must be a function');
    }
    if (typeof addGroup !== 'function') {
        throw new TypeError('addGroup must be a function');
    }

    return async (...args) => {
        const beforeIds = new Set(groupIds(await getGroups()));

        try {
            return await addGroup(...args);
        } catch (_error) {
            let createdGroupIds = [];
            let groupCreationUncertain = true;
            try {
                createdGroupIds = groupIds(await getGroups()).filter(id => !beforeIds.has(id));
                groupCreationUncertain = false;
            } catch (_detectionError) {
                // A failed post-check cannot prove whether Groups.add persisted a group.
            }

            throw Object.assign(
                new Error('Group creation failed after it may have been persisted.'),
                {createdGroupIds, groupCreationUncertain},
            );
        }
    };
}

export function preflightDraft(draft, liveTabs, getTabGroup) {
    validateDraft(draft);
    if (!Array.isArray(liveTabs)) {
        throw new TypeError('liveTabs must be an array');
    }
    if (typeof getTabGroup !== 'function') {
        throw new TypeError('getTabGroup must be a function');
    }

    const liveById = new Map(liveTabs.map(tab => [tab.id, tab]));
    const snapshotById = new Map(draft.snapshot.tabs.map(tab => [tab.tabId, tab]));
    const result = {
        ok: true,
        missingTabIds: [],
        urlChangedTabIds: [],
        windowChangedTabIds: [],
        groupChangedTabIds: [],
    };

    for (const tabId of assignedTabIds(draft)) {
        const liveTab = liveById.get(tabId);
        if (!liveTab) {
            result.missingTabIds.push(tabId);
            continue;
        }

        const fingerprint = snapshotById.get(tabId)?.fingerprint;
        if (!fingerprint) {
            throw new TypeError(`draft snapshot tab ${tabId} has no apply fingerprint`);
        }
        if (liveTab.url !== fingerprint.url) {
            result.urlChangedTabIds.push(tabId);
        }
        if (liveTab.windowId !== fingerprint.windowId) {
            result.windowChangedTabIds.push(tabId);
        }
        if (normalizedGroupId(getTabGroup(tabId)) !== normalizedGroupId(fingerprint.groupId)) {
            result.groupChangedTabIds.push(tabId);
        }
    }

    result.ok = result.missingTabIds.length === 0 &&
        result.urlChangedTabIds.length === 0 &&
        result.windowChangedTabIds.length === 0 &&
        result.groupChangedTabIds.length === 0;
    return result;
}

function moveResultError(sourceTabId, result) {
    const returnedTabIds = Array.isArray(result)
        ? result.map(tab => tab?.id).filter(id => Number.isSafeInteger(id) && id >= 0)
        : [];
    let reason = 'malformed-result';
    if (Array.isArray(result) && result.length === 0) {
        reason = 'empty-result';
    } else if (Array.isArray(result) && result.length > 1) {
        reason = 'multiple-results';
    }

    return Object.assign(
        new Error(`Moving tab ${sourceTabId} did not return exactly one live tab.`),
        {reason, returnedTabIds, sourceTabId},
    );
}

function requireMovedTab(sourceTabId, result) {
    if (!Array.isArray(result) || result.length !== 1 ||
        !Number.isSafeInteger(result[0]?.id) || result[0].id < 0) {
        throw moveResultError(sourceTabId, result);
    }
    return result[0];
}

function summarizeCreatedGroup({draftGroupId, groupId, sourceTabIds, moves}) {
    return {
        draftGroupId,
        groupId,
        sourceTabIds: [...sourceTabIds],
        tabIds: moves.map(move => move.actualTabId),
    };
}

async function retainedGroup(record, getTabs, getTabGroup, failures) {
    try {
        const remainingTabIds = [];
        for (const tab of await getTabs()) {
            if (normalizedGroupId(getTabGroup(tab.id)) === record.groupId) {
                remainingTabIds.push(tab.id);
            }
        }
        return {
            draftGroupId: record.draftGroupId,
            groupId: record.groupId,
            remainingTabIds,
        };
    } catch (error) {
        failures.push({
            stage: 'verify-tabs',
            draftGroupId: record.draftGroupId,
            groupId: record.groupId,
            tabIds: [],
            message: errorMessage(error),
        });
        return {
            draftGroupId: record.draftGroupId,
            groupId: record.groupId,
            remainingTabIds: null,
        };
    }
}

async function compensate(records, {getTabs, getTabGroup, restoreTabs}) {
    const failures = [];
    const retainedGroups = [];

    for (const record of records.toReversed()) {
        for (const move of record.moves.toReversed()) {
            let currentGroupId;
            try {
                currentGroupId = normalizedGroupId(getTabGroup(move.actualTabId));
            } catch (error) {
                failures.push({
                    stage: 'verify-tabs',
                    draftGroupId: record.draftGroupId,
                    groupId: record.groupId,
                    tabIds: [move.actualTabId],
                    message: errorMessage(error),
                });
                continue;
            }

            if (currentGroupId === move.originalGroupId) {
                continue;
            }
            if (currentGroupId !== record.groupId) {
                failures.push({
                    stage: 'verify-tabs',
                    draftGroupId: record.draftGroupId,
                    groupId: record.groupId,
                    tabIds: [move.actualTabId],
                    message: 'Tab membership changed again during rollback.',
                });
                continue;
            }

            try {
                await restoreTabs([move.actualTabId], move.originalGroupId);
            } catch (error) {
                failures.push({
                    stage: 'restore-tabs',
                    draftGroupId: record.draftGroupId,
                    groupId: record.groupId,
                    originalGroupId: move.originalGroupId,
                    tabIds: [move.actualTabId],
                    message: errorMessage(error),
                });
            }
        }

        retainedGroups.push(await retainedGroup(record, getTabs, getTabGroup, failures));
    }

    return {failures, retainedGroups};
}

function createRecord(draftGroup, groupId, originalGroupIds) {
    return {
        draftGroupId: draftGroup.id,
        groupId,
        sourceTabIds: [...draftGroup.tabIds],
        moves: [],
        originalGroupIds,
    };
}

function addFailureDetails(error) {
    const retainedGroupIds = Array.isArray(error?.createdGroupIds)
        ? error.createdGroupIds.filter(id => typeof id === 'string' && id)
        : [];
    return {
        retainedGroupIds,
        groupCreationUncertain: error?.groupCreationUncertain ?? true,
    };
}

export async function applyDraft(draft, {
    getTabs,
    getTabGroup,
    addGroup,
    moveTabs,
    restoreTabs,
} = {}) {
    for (const [name, operation] of Object.entries({getTabs, getTabGroup, addGroup, moveTabs})) {
        if (typeof operation !== 'function') {
            throw new TypeError(`${name} must be a function`);
        }
    }

    restoreTabs ??= async (tabIds, groupId) => {
        if (groupId === null) {
            throw new Error('Tabs that were originally ungrouped cannot be restored safely.');
        }
        return moveTabs(tabIds, groupId);
    };
    if (typeof restoreTabs !== 'function') {
        throw new TypeError('restoreTabs must be a function');
    }

    const preflight = preflightDraft(draft, await getTabs(), getTabGroup);
    if (!preflight.ok) {
        return {
            success: false,
            preflight,
            createdGroups: [],
            failure: {
                stage: 'preflight',
                message: 'Assigned tabs changed after the organizer snapshot was captured.',
            },
            rolledBack: false,
            rollbackFailures: [],
            retainedGroups: [],
        };
    }

    const originalGroupIds = new Map(draft.snapshot.tabs.map(tab => [
        tab.tabId,
        normalizedGroupId(tab.fingerprint.groupId),
    ]));
    const records = [];
    let activeGroup = null;
    let activeSourceTabId = null;
    let stage = 'add-group';

    try {
        for (const draftGroup of draft.groups) {
            activeGroup = draftGroup;
            activeSourceTabId = null;
            stage = 'add-group';
            const createdGroup = await addGroup(null, [], draftGroup.name);
            if (!createdGroup?.id) {
                throw new Error('Creating the STG group did not return a group ID.');
            }

            const record = createRecord(draftGroup, createdGroup.id, originalGroupIds);
            records.push(record);

            stage = 'move-tabs';
            for (const sourceTabId of draftGroup.tabIds) {
                activeSourceTabId = sourceTabId;
                const movedTab = requireMovedTab(
                    sourceTabId,
                    await moveTabs([sourceTabId], record.groupId),
                );
                record.moves.push({
                    sourceTabId,
                    actualTabId: movedTab.id,
                    originalGroupId: originalGroupIds.get(sourceTabId),
                });
            }
        }

        return {
            success: true,
            preflight,
            createdGroups: records.map(summarizeCreatedGroup),
            failure: null,
            rolledBack: false,
            rollbackFailures: [],
            retainedGroups: [],
        };
    } catch (error) {
        if (stage === 'add-group') {
            const {retainedGroupIds} = addFailureDetails(error);
            for (const groupId of retainedGroupIds) {
                records.push(createRecord(activeGroup, groupId, originalGroupIds));
            }
        }

        const activeRecord = records.findLast(record => record.draftGroupId === activeGroup?.id);
        const failure = {
            stage,
            draftGroupId: activeGroup?.id ?? null,
            ...(activeRecord ? {groupId: activeRecord.groupId} : {}),
            ...(stage === 'move-tabs' ? {
                sourceTabId: activeSourceTabId,
                reason: error?.reason ?? 'operation-rejected',
                returnedTabIds: error?.returnedTabIds ?? [],
            } : addFailureDetails(error)),
            message: errorMessage(error),
        };
        const rollback = await compensate(records, {getTabs, getTabGroup, restoreTabs});

        return {
            success: false,
            preflight,
            createdGroups: records.map(summarizeCreatedGroup),
            failure,
            rolledBack: false,
            rollbackFailures: rollback.failures,
            retainedGroups: rollback.retainedGroups,
        };
    }
}
