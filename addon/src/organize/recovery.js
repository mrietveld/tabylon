import {moveDraftTabToUnassigned} from '../js/organizer/draft.js';

function validTabIds(value) {
    return Array.isArray(value)
        ? value.filter(tabId => Number.isSafeInteger(tabId) && tabId >= 0)
        : [];
}

export function createdGroupDetails(result) {
    return (result?.createdGroups ?? []).map(group => ({
        groupId: group.groupId,
        name: typeof group.name === 'string' && group.name ? group.name : group.groupId,
        tabCount: Number.isSafeInteger(group.tabCount)
            ? group.tabCount
            : validTabIds(group.tabIds).length,
    }));
}

export function retainedGroupDetails(result) {
    const details = [];
    const seen = new Set();
    for (const group of result?.retainedGroups ?? []) {
        if (typeof group?.groupId !== 'string' || !group.groupId || seen.has(group.groupId)) {
            continue;
        }
        seen.add(group.groupId);
        const remainingTabIds = group.remainingTabIds === null
            ? null
            : validTabIds(group.remainingTabIds);
        details.push({
            draftGroupId: typeof group.draftGroupId === 'string' ? group.draftGroupId : null,
            groupId: group.groupId,
            remainingTabIds,
            remainingTabCount: remainingTabIds?.length ?? null,
        });
    }
    for (const groupId of result?.failure?.retainedGroupIds ?? []) {
        if (typeof groupId !== 'string' || !groupId || seen.has(groupId)) {
            continue;
        }
        seen.add(groupId);
        details.push({
            draftGroupId: null,
            groupId,
            remainingTabIds: null,
            remainingTabCount: null,
        });
    }
    return details;
}

export function rollbackFailureDetails(result) {
    return (result?.rollbackFailures ?? []).map(failure => ({
        stage: failure.stage,
        groupId: failure.groupId ?? null,
        tabIds: validTabIds(failure.tabIds),
        message: failure.message,
    }));
}

export function staleAssignedTabIds(preflight) {
    return [...new Set([
        ...validTabIds(preflight?.missingTabIds),
        ...validTabIds(preflight?.urlChangedTabIds),
        ...validTabIds(preflight?.windowChangedTabIds),
        ...validTabIds(preflight?.groupChangedTabIds),
    ])];
}

export function preflightChangeDetails(preflight) {
    return [
        {label: 'Missing', tabIds: validTabIds(preflight?.missingTabIds)},
        {label: 'URL changed', tabIds: validTabIds(preflight?.urlChangedTabIds)},
        {label: 'Window changed', tabIds: validTabIds(preflight?.windowChangedTabIds)},
        {label: 'Group changed', tabIds: validTabIds(preflight?.groupChangedTabIds)},
    ].filter(detail => detail.tabIds.length);
}

export function removeStaleAssignedTabs(draft, preflight) {
    return staleAssignedTabIds(preflight).reduce((updated, tabId) => {
        const isAssigned = updated.groups.some(group => group.tabIds.includes(tabId));
        return isAssigned ? moveDraftTabToUnassigned(updated, tabId) : updated;
    }, draft);
}
