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

function groupTabsByOrigin(record, tabIds) {
    const tabsByOrigin = new Map;
    for (const tabId of tabIds) {
        const origin = record.originalGroupIds.get(tabId);
        const tabs = tabsByOrigin.get(origin) ?? [];
        tabs.push(tabId);
        tabsByOrigin.set(origin, tabs);
    }
    return tabsByOrigin;
}

async function compensate(records, {getTabs, getTabGroup, restoreTabs, removeGroup}) {
    const failures = [];

    for (const record of records.toReversed()) {
        const tabsInCreatedGroup = [];
        let canVerify = true;

        for (const tabId of record.tabIds) {
            try {
                const currentGroupId = normalizedGroupId(getTabGroup(tabId));
                const originalGroupId = record.originalGroupIds.get(tabId);
                if (currentGroupId === record.groupId) {
                    tabsInCreatedGroup.push(tabId);
                } else if (currentGroupId !== originalGroupId) {
                    failures.push({
                        stage: 'verify-tabs',
                        draftGroupId: record.draftGroupId,
                        groupId: record.groupId,
                        tabIds: [tabId],
                        message: 'Tab membership changed again during rollback.',
                    });
                }
            } catch (error) {
                canVerify = false;
                failures.push({
                    stage: 'verify-tabs',
                    draftGroupId: record.draftGroupId,
                    groupId: record.groupId,
                    tabIds: [tabId],
                    message: errorMessage(error),
                });
            }
        }

        for (const [originalGroupId, tabIds] of groupTabsByOrigin(record, tabsInCreatedGroup)) {
            try {
                await restoreTabs(tabIds, originalGroupId);
            } catch (error) {
                failures.push({
                    stage: 'restore-tabs',
                    draftGroupId: record.draftGroupId,
                    groupId: record.groupId,
                    originalGroupId,
                    tabIds: [...tabIds],
                    message: errorMessage(error),
                });
            }
        }

        const remainingTabIds = [];
        if (canVerify) {
            try {
                for (const tab of await getTabs()) {
                    const tabId = tab.id;
                    if (normalizedGroupId(getTabGroup(tabId)) === record.groupId) {
                        remainingTabIds.push(tabId);
                    }
                }
            } catch (error) {
                canVerify = false;
                failures.push({
                    stage: 'verify-tabs',
                    draftGroupId: record.draftGroupId,
                    groupId: record.groupId,
                    tabIds: [],
                    message: errorMessage(error),
                });
            }
        }

        if (!canVerify || remainingTabIds.length) {
            failures.push({
                stage: 'remove-group',
                draftGroupId: record.draftGroupId,
                groupId: record.groupId,
                remainingTabIds,
                message: canVerify
                    ? 'Created group still contains tabs after rollback; removal was skipped.'
                    : 'Created group contents could not be verified after rollback; removal was skipped.',
            });
            continue;
        }

        try {
            await removeGroup(record.groupId);
        } catch (error) {
            failures.push({
                stage: 'remove-group',
                draftGroupId: record.draftGroupId,
                groupId: record.groupId,
                remainingTabIds: [],
                message: errorMessage(error),
            });
        }
    }

    return failures;
}

export async function applyDraft(draft, {
    getTabs,
    getTabGroup,
    addGroup,
    moveTabs,
    restoreTabs,
    removeGroup,
} = {}) {
    for (const [name, operation] of Object.entries({getTabs, getTabGroup, addGroup, moveTabs, removeGroup})) {
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
        };
    }

    const originalGroupIds = new Map(draft.snapshot.tabs.map(tab => [
        tab.tabId,
        normalizedGroupId(tab.fingerprint.groupId),
    ]));
    const records = [];
    let activeGroup = null;
    let stage = 'add-group';

    try {
        for (const draftGroup of draft.groups) {
            activeGroup = draftGroup;
            stage = 'add-group';
            const createdGroup = await addGroup(null, [], draftGroup.name);
            if (!createdGroup?.id) {
                throw new Error('Creating the STG group did not return a group ID.');
            }

            const record = {
                draftGroupId: draftGroup.id,
                groupId: createdGroup.id,
                tabIds: [...draftGroup.tabIds],
                originalGroupIds,
            };
            records.push(record);

            stage = 'move-tabs';
            await moveTabs(record.tabIds, record.groupId);
        }

        return {
            success: true,
            preflight,
            createdGroups: records.map(({draftGroupId, groupId, tabIds}) => ({
                draftGroupId,
                groupId,
                tabIds: [...tabIds],
            })),
            failure: null,
            rolledBack: false,
            rollbackFailures: [],
        };
    } catch (error) {
        const activeRecord = records.at(-1);
        const failure = {
            stage,
            draftGroupId: activeGroup?.id ?? null,
            ...(activeRecord?.draftGroupId === activeGroup?.id ? {groupId: activeRecord.groupId} : {}),
            message: errorMessage(error),
        };
        const rollbackFailures = await compensate(records, {getTabs, getTabGroup, restoreTabs, removeGroup});

        return {
            success: false,
            preflight,
            createdGroups: records.map(({draftGroupId, groupId, tabIds}) => ({
                draftGroupId,
                groupId,
                tabIds: [...tabIds],
            })),
            failure,
            rolledBack: rollbackFailures.length === 0,
            rollbackFailures,
        };
    }
}
