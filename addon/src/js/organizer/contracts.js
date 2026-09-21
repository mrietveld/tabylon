export const ORGANIZER_SCOPES = Object.freeze([
    'ungrouped-current-window',
    'current-group',
    'selected',
    'all',
]);

export const MAX_TABS = 2024;
export const MAX_GROUPS = 100;
export const MAX_GROUP_NAME_LENGTH = 120;
export const MAX_TAB_TITLE_LENGTH = 512;
export const MAX_TAB_URL_LENGTH = 8_192;
export const MAX_PLAN_ID_LENGTH = 120;
export const MAX_SUMMARY_LENGTH = 2_000;
export const MAX_REASON_LENGTH = 1_000;
export const MAX_WARNINGS = 100;
export const MAX_WARNING_LENGTH = 500;
export const MINIMUM_GROUP_SIZE = 2;

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

function requireMinimumGroupSize(value) {
    if (!Number.isSafeInteger(value) || value < MINIMUM_GROUP_SIZE || value > MAX_TABS) {
        fail(`minimumGroupSize must be an integer between ${MINIMUM_GROUP_SIZE} and ${MAX_TABS}`);
    }
    return value;
}

function requireScope(value) {
    if (!ORGANIZER_SCOPES.includes(value)) {
        fail(`scope must be one of: ${ORGANIZER_SCOPES.join(', ')}`);
    }
    return value;
}

function validateRequestTab(tab, index) {
    requireObject(tab, `tabs[${index}]`);
    requireTabId(tab.tabId, `tabs[${index}].tabId`);
    requireString(tab.title, `tabs[${index}].title`, MAX_TAB_TITLE_LENGTH, {nonEmpty: true});
    requireString(tab.url, `tabs[${index}].url`, MAX_TAB_URL_LENGTH, {nonEmpty: true});
}

function snapshotMinimumGroupSize(snapshot) {
    const minimumGroupSize = snapshot.request?.minimumGroupSize ?? snapshot.minimumGroupSize;
    return requireMinimumGroupSize(minimumGroupSize);
}

function snapshotTabIds(snapshot) {
    requireObject(snapshot, 'snapshot');
    requireString(snapshot.requestId, 'snapshot.requestId', MAX_PLAN_ID_LENGTH, {nonEmpty: true});
    const tabs = requireArray(snapshot.tabs, 'snapshot.tabs', MAX_TABS);
    const tabIds = new Set();

    tabs.forEach((tab, index) => {
        requireObject(tab, `snapshot.tabs[${index}]`);
        const tabId = requireTabId(tab.tabId, `snapshot.tabs[${index}].tabId`);
        if (tabIds.has(tabId)) {
            fail(`snapshot contains duplicate tab ID ${tabId}`);
        }
        tabIds.add(tabId);
    });

    return tabIds;
}

export function createGroupingRequest(tabs, {minimumGroupSize, scope} = {}) {
    const requestedTabs = requireArray(tabs, 'tabs', MAX_TABS);
    requireMinimumGroupSize(minimumGroupSize);
    requireScope(scope);

    const tabIds = new Set();
    requestedTabs.forEach((tab, index) => {
        validateRequestTab(tab, index);
        if (tabIds.has(tab.tabId)) {
            fail(`tabs contains duplicate tab ID ${tab.tabId}`);
        }
        tabIds.add(tab.tabId);
    });

    return {
        tabs: requestedTabs.map(({tabId, title, url}) => ({tabId, title, url})),
        minimumGroupSize,
        scope,
    };
}

export function validateGroupingPlan(plan, snapshot) {
    requireObject(plan, 'plan');
    const snapshotIds = snapshotTabIds(snapshot);
    const minimumGroupSize = snapshotMinimumGroupSize(snapshot);

    requireString(plan.planId, 'plan.planId', MAX_PLAN_ID_LENGTH, {nonEmpty: true});
    requireString(plan.requestId, 'plan.requestId', MAX_PLAN_ID_LENGTH, {nonEmpty: true});
    if (plan.requestId !== snapshot.requestId) {
        fail('plan.requestId does not match snapshot.requestId');
    }
    requireString(plan.summary, 'plan.summary', MAX_SUMMARY_LENGTH);
    const groups = requireArray(plan.groups, 'plan.groups', MAX_GROUPS);
    const ungroupedTabIds = requireArray(plan.ungroupedTabIds, 'plan.ungroupedTabIds', MAX_TABS);
    const warnings = requireArray(plan.warnings, 'plan.warnings', MAX_WARNINGS);
    warnings.forEach((warning, index) => requireString(warning, `plan.warnings[${index}]`, MAX_WARNING_LENGTH));

    const assignedIds = new Set();
    const groupIds = new Set();
    groups.forEach((group, groupIndex) => {
        requireObject(group, `plan.groups[${groupIndex}]`);
        requireString(group.groupId, `plan.groups[${groupIndex}].groupId`, MAX_PLAN_ID_LENGTH, {nonEmpty: true});
        if (groupIds.has(group.groupId)) {
            fail(`plan contains duplicate group ID ${group.groupId}`);
        }
        groupIds.add(group.groupId);
        requireString(group.name, `plan.groups[${groupIndex}].name`, MAX_GROUP_NAME_LENGTH, {nonEmpty: true});
        requireString(group.reason, `plan.groups[${groupIndex}].reason`, MAX_REASON_LENGTH);
        const tabIds = requireArray(group.tabIds, `plan.groups[${groupIndex}].tabIds`, MAX_TABS);
        if (tabIds.length < minimumGroupSize) {
            fail(`plan.groups[${groupIndex}] does not meet the minimum group size`);
        }
        tabIds.forEach((tabId, tabIndex) => {
            requireTabId(tabId, `plan.groups[${groupIndex}].tabIds[${tabIndex}]`);
            if (!snapshotIds.has(tabId)) {
                fail(`plan references unknown tab ID ${tabId}`);
            }
            if (assignedIds.has(tabId)) {
                fail(`plan contains duplicate assignment for tab ID ${tabId}`);
            }
            assignedIds.add(tabId);
        });
    });

    ungroupedTabIds.forEach((tabId, index) => {
        requireTabId(tabId, `plan.ungroupedTabIds[${index}]`);
        if (!snapshotIds.has(tabId)) {
            fail(`plan references unknown tab ID ${tabId}`);
        }
        if (assignedIds.has(tabId)) {
            fail(`plan contains duplicate assignment for tab ID ${tabId}`);
        }
        assignedIds.add(tabId);
    });

    if (assignedIds.size !== snapshotIds.size) {
        fail('plan must assign every snapshot tab exactly once');
    }

    return plan;
}
