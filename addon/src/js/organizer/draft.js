import {
    MAX_GROUP_NAME_LENGTH,
    MAX_GROUPS,
    MAX_PLAN_ID_LENGTH,
    MAX_REASON_LENGTH,
    MAX_SUMMARY_LENGTH,
    MAX_TABS,
    MAX_WARNING_LENGTH,
    MAX_WARNINGS,
    validateGroupingPlan,
} from './contracts.js';

function fail(message) {
    throw new TypeError(message);
}

function requireObject(value, name) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        fail(`${name} must be an object`);
    }
    return value;
}

function requireArray(value, name, maximum) {
    if (!Array.isArray(value)) {
        fail(`${name} must be an array`);
    }
    if (value.length > maximum) {
        fail(`${name} exceeds the maximum of ${maximum} entries`);
    }
    return value;
}

function requireString(value, name, maximum, {nonEmpty = false} = {}) {
    if (typeof value !== 'string') {
        fail(`${name} must be a string`);
    }
    if (value.length > maximum) {
        fail(`${name} exceeds the maximum length of ${maximum}`);
    }
    if (nonEmpty && !value.trim()) {
        fail(`${name} must not be blank`);
    }
    return value;
}

function requireTabId(value, name) {
    if (!Number.isSafeInteger(value) || value < 0) {
        fail(`${name} must be a non-negative integer`);
    }
    return value;
}

function cloneValue(value) {
    if (Array.isArray(value)) {
        return value.map(cloneValue);
    }
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneValue(item)]));
    }
    return value;
}

function draftTabIds(draft) {
    requireObject(draft.snapshot, 'draft.snapshot');
    requireString(draft.snapshot.requestId, 'draft.snapshot.requestId', MAX_PLAN_ID_LENGTH, {nonEmpty: true});
    if (draft.snapshot.requestId !== draft.requestId) {
        fail('draft.snapshot.requestId does not match draft.requestId');
    }
    const tabs = requireArray(draft.snapshot.tabs, 'draft.snapshot.tabs', MAX_TABS);
    const tabIds = new Set();
    tabs.forEach((tab, index) => {
        requireObject(tab, `draft.snapshot.tabs[${index}]`);
        const tabId = requireTabId(tab.tabId, `draft.snapshot.tabs[${index}].tabId`);
        if (tabIds.has(tabId)) {
            fail(`draft.snapshot contains duplicate tab ID ${tabId}`);
        }
        tabIds.add(tabId);
    });
    return tabIds;
}

function findGroup(draft, groupId) {
    requireString(groupId, 'groupId', MAX_PLAN_ID_LENGTH, {nonEmpty: true});
    const group = draft.groups.find(candidate => candidate.id === groupId);
    if (!group) {
        fail(`draft does not contain group ${groupId}`);
    }
    return group;
}

function findTabLocation(draft, tabId) {
    requireTabId(tabId, 'tabId');
    const group = draft.groups.find(candidate => candidate.tabIds.includes(tabId));
    if (group) {
        return {groupId: group.id};
    }
    if (draft.unassignedTabIds.includes(tabId)) {
        return {groupId: null};
    }
    fail(`draft does not contain tab ID ${tabId}`);
}

function withGroups(draft, groups, unassignedTabIds = draft.unassignedTabIds) {
    return validateDraft({
        ...draft,
        groups,
        unassignedTabIds,
    });
}

export function validateDraft(draft) {
    requireObject(draft, 'draft');
    requireString(draft.requestId, 'draft.requestId', MAX_PLAN_ID_LENGTH, {nonEmpty: true});
    requireString(draft.planId, 'draft.planId', MAX_PLAN_ID_LENGTH, {nonEmpty: true});
    requireString(draft.summary, 'draft.summary', MAX_SUMMARY_LENGTH);
    const warnings = requireArray(draft.warnings, 'draft.warnings', MAX_WARNINGS);
    warnings.forEach((warning, index) => requireString(warning, `draft.warnings[${index}]`, MAX_WARNING_LENGTH));

    const snapshotIds = draftTabIds(draft);
    const groups = requireArray(draft.groups, 'draft.groups', MAX_GROUPS);
    const unassignedTabIds = requireArray(draft.unassignedTabIds, 'draft.unassignedTabIds', MAX_TABS);
    const groupIds = new Set();
    const assignedIds = new Set();

    groups.forEach((group, groupIndex) => {
        requireObject(group, `draft.groups[${groupIndex}]`);
        requireString(group.id, `draft.groups[${groupIndex}].id`, MAX_PLAN_ID_LENGTH, {nonEmpty: true});
        if (groupIds.has(group.id)) {
            fail(`draft contains duplicate group ID ${group.id}`);
        }
        groupIds.add(group.id);
        requireString(group.name, `draft.groups[${groupIndex}].name`, MAX_GROUP_NAME_LENGTH, {nonEmpty: true});
        requireString(group.reason, `draft.groups[${groupIndex}].reason`, MAX_REASON_LENGTH);
        const tabIds = requireArray(group.tabIds, `draft.groups[${groupIndex}].tabIds`, MAX_TABS);
        if (!tabIds.length) {
            fail(`draft.groups[${groupIndex}] must not be empty`);
        }
        tabIds.forEach((tabId, tabIndex) => {
            requireTabId(tabId, `draft.groups[${groupIndex}].tabIds[${tabIndex}]`);
            if (!snapshotIds.has(tabId)) {
                fail(`draft references unknown tab ID ${tabId}`);
            }
            if (assignedIds.has(tabId)) {
                fail(`draft contains duplicate assignment for tab ID ${tabId}`);
            }
            assignedIds.add(tabId);
        });
    });

    unassignedTabIds.forEach((tabId, index) => {
        requireTabId(tabId, `draft.unassignedTabIds[${index}]`);
        if (!snapshotIds.has(tabId)) {
            fail(`draft references unknown tab ID ${tabId}`);
        }
        if (assignedIds.has(tabId)) {
            fail(`draft contains duplicate assignment for tab ID ${tabId}`);
        }
        assignedIds.add(tabId);
    });

    if (assignedIds.size !== snapshotIds.size) {
        fail('draft must assign every snapshot tab exactly once');
    }

    return draft;
}

export function createDraft(snapshot, plan) {
    validateGroupingPlan(plan, snapshot);

    return validateDraft({
        requestId: plan.requestId,
        planId: plan.planId,
        scope: snapshot.scope,
        summary: plan.summary,
        warnings: [...plan.warnings],
        snapshot: cloneValue(snapshot),
        groups: plan.groups.map(group => ({
            id: group.groupId,
            name: group.name,
            reason: group.reason,
            tabIds: [...group.tabIds],
        })),
        unassignedTabIds: [...plan.ungroupedTabIds],
    });
}

export function renameDraftGroup(draft, groupId, name) {
    validateDraft(draft);
    requireString(name, 'name', MAX_GROUP_NAME_LENGTH, {nonEmpty: true});
    findGroup(draft, groupId);

    return withGroups(draft, draft.groups.map(group => group.id === groupId
        ? {...group, name}
        : {...group, tabIds: [...group.tabIds]}));
}

export function moveDraftTabToGroup(draft, tabId, targetGroupId) {
    validateDraft(draft);
    findGroup(draft, targetGroupId);
    const location = findTabLocation(draft, tabId);

    if (location.groupId === targetGroupId) {
        return withGroups(draft, draft.groups.map(group => ({...group, tabIds: [...group.tabIds]})), [...draft.unassignedTabIds]);
    }

    const groups = draft.groups
        .map(group => {
            const tabIds = group.id === location.groupId
                ? group.tabIds.filter(id => id !== tabId)
                : [...group.tabIds];
            return group.id === targetGroupId
                ? {...group, tabIds: [...tabIds, tabId]}
                : {...group, tabIds};
        })
        .filter(group => group.tabIds.length);
    const unassignedTabIds = location.groupId === null
        ? draft.unassignedTabIds.filter(id => id !== tabId)
        : [...draft.unassignedTabIds];

    return withGroups(draft, groups, unassignedTabIds);
}

export function moveDraftTabToUnassigned(draft, tabId) {
    validateDraft(draft);
    const location = findTabLocation(draft, tabId);
    if (location.groupId === null) {
        return withGroups(draft, draft.groups.map(group => ({...group, tabIds: [...group.tabIds]})), [...draft.unassignedTabIds]);
    }

    const groups = draft.groups
        .map(group => group.id === location.groupId
            ? {...group, tabIds: group.tabIds.filter(id => id !== tabId)}
            : {...group, tabIds: [...group.tabIds]})
        .filter(group => group.tabIds.length);

    return withGroups(draft, groups, [...draft.unassignedTabIds, tabId]);
}

export function removeDraftGroup(draft, groupId) {
    validateDraft(draft);
    const group = findGroup(draft, groupId);

    return withGroups(
        draft,
        draft.groups
            .filter(candidate => candidate.id !== groupId)
            .map(candidate => ({...candidate, tabIds: [...candidate.tabIds]})),
        [...draft.unassignedTabIds, ...group.tabIds],
    );
}
