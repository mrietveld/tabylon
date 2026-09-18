
import Listeners, {getExtensionStartTime} from '/js/listeners.js\
?extension.onStart\
&webRequest.onBeforeRequest=[{"urls":["<all_urls>"],"types":["main_frame"]},["blocking"]]\
&windows.onCreated\
&windows.onFocusChanged\
&windows.onRemoved\
&runtime.onConnect\
&runtime.onMessage\
&runtime.onInstalled\
&browserAction.onClicked\
&commands.onCommand\
&alarms.onAlarm\
';
import '/js/prefixed-storage.js';
import * as Constants from '/js/constants.js';
import * as Browser from '/js/browser.js';
import * as Messages from '/js/messages.js';
import Logger, {
    catchFunc,
    addLog,
    showLog,
    getLogs,
    clearLogs,
    getErrors,
    clearErrors,
    errorEventHandler,
    objectToNativeError,
} from '/js/logger.js';
import * as Utils from '/js/utils.js';
import Notification from '/js/notification.js?add-listeners';
import JSON from '/js/json.js';
import BatchProcessor from '/js/batch-processor.js';
import Lang from '/js/lang.js';
import {initLocalData, stampVersion} from '/js/migration.js';
// import * as Broadcast from '/js/broadcast.js';
import * as Containers from '/js/containers.js?add-listeners';
import * as Storage from '/js/storage.js';
import * as Cache from '/js/cache.js';
import * as File from '/js/file.js';
import * as Menus from '/js/menus.js';
import * as MenusMain from '/js/menus-main.js';
// import * as MenusBookmark from '/js/menus-bookmark.js';
import * as Groups from '/js/groups.js';
import * as GroupsNative from '/js/groups-native.js';
import * as Operations from '/js/operations.js';
import * as Tabs from '/js/tabs.js';
import * as Windows from '/js/windows.js';
import * as Bookmarks from '/js/bookmarks.js';
import * as Permissions from '/js/permissions.js';
import * as BrowserSettings from '/js/browser-settings.js';
import {normalizeStandaloneOptions} from '/js/standalone-normalization.js';
import {createTrackedAddGroupOperation} from '/js/organizer/apply-plan.js';
import {createOrganizerWorkflow} from '/js/organizer/index.js';

const storage = localStorage.create(Constants.MODULES.BACKGROUND);

delete storage.inited;
storage.IS_TEMPORARY = false;

if (storage.enableDebug === Constants.DEBUG.AUTO) { // if debug was auto-enabled - disable on next start addon/browser
    delete storage.enableDebug;
}

const logger = self.logger = new Logger(Constants.MODULES.BACKGROUND);

function startupDebug(step, details = undefined) {
    console.info('[STG startup]', step, details ?? '');
}

self.loggerFuncs = {
    getLogs,
    clearLogs,
    getErrors,
    clearErrors,
};

const options = self.options = {};

const Organizer = createOrganizerWorkflow({
    getOptions: () => options,
    getTabs: () => browser.tabs.query({}),
    getCurrentWindow: () => Windows.getLastFocusedNormalWindow(false),
    getGroupId: tabId => Cache.getTabGroup(tabId),
    isCanNotBeHidden: Tabs.isCanNotBeHidden,
    addGroup: createTrackedAddGroupOperation({
        getGroups: () => Groups.load().then(({groups}) => groups),
        addGroup: (windowId, tabIds, name) => Groups.add(windowId, tabIds, name),
    }),
    moveTabs: (tabIds, groupId) => Tabs.move(tabIds, groupId),
    restoreTabs: (tabIds, groupId) => {
        if (groupId === null) {
            throw new Error('Tabs that were originally ungrouped cannot be restored safely.');
        }
        return Tabs.move(tabIds, groupId);
    },
    runOperation: (name, operation) => Operations.run(name, operation),
});

function mapGroupsForPage(groups) {
    return groups.map(group => ({
        id: group.id,
        title: Groups.getTitle(group),
        isArchive: group.isArchive,
        isSticky: group.isSticky,
        iconUrl: Groups.getIconUrl(group),
    }));
}

// TODO temp
self.CacheTabs = Cache.tabs;
self.CacheLastTabsState = Cache.lastTabsState;
self.CacheWindows = Cache.windows;

const moveTabsBatch = new BatchProcessor(async (tabIds, groupId) => {
    tabIds = Array.from(tabIds);
    const log = logger.start('moveTabsBatch', {tabIds, groupId});
    await Tabs.move(tabIds, groupId, {auto: true}).catch(log.onCatch('Tabs.move'));
    log.stop();
});

const reopenTabsBatch = new BatchProcessor(async (paramsByTabId, groupId) => {
    const tabIds = Array.from(paramsByTabId.keys());
    const log = logger.start('reopenTabsBatch', {tabIds, groupId});
    await Operations.run('reopen-tab-container', () => {
            return Tabs.recreate(tabIds, tab => paramsByTabId.get(tab.id));
        })
        .catch(log.onCatch('Tabs.recreate'));
    log.stop();
}, {useMap: true});

// https://bugzilla.mozilla.org/show_bug.cgi?id=1683646
// only onBeforeNavigate can detect view-source, but it's need new permission "webNavigation" in manifest
const canceledRequests = new Map;

async function getRequestedTab(tabId, requestedUrl) {
    const tab = await Tabs.get(tabId);

    if (!tab) {
        return null;
    }

    tab.url = requestedUrl;

    if (Utils.isUrlEmpty(tab.url)) {
        delete tab.title;
    }

    return tab;
}

const onBeforeTabRequest = catchFunc(async function onBeforeTabRequest({
    tabId,
    url: requestedUrl,
    cookieStoreId,
    originUrl = '',
    requestId,
    frameId,
    method,
}) {
    const log = logger.start(onBeforeTabRequest, {
        tabId,
        requestedUrl,
        cookieStoreId,
        originUrl,
        requestId,
        frameId,
        method,
    });

    if (frameId !== 0 || tabId === browser.tabs.TAB_ID_NONE) {
        log.stop('exclude');
        return {};
    }

    Cache.mirrorTabUrl(tabId, requestedUrl);

    if (Containers.isTemporary(cookieStoreId)) {
        log.stop('exclude temporary container');
        return {};
    }

    if (canceledRequests.has(requestId)) {
        log.stop('stop by requestId', requestId);
        return {cancel: true};
    }

    if (originUrl.startsWith(Constants.STG_BASE_URL)) {
        originUrl = 'stg://';
    }

    log.log('final originUrl', originUrl);

    if (Tabs.isSkippedTracking(tabId)) {
        log.stop('🛑 tab was skiped from tracking');
        return {};
    }

    await Tabs.waitOnCreated(tabId);

    let tab = await getRequestedTab(tabId, requestedUrl);

    if (!tab) {
        log.stopWarn('tab not found', tabId);
        return {};
    }

    if (Tabs.isPinned(tab)) {
        log.stop('tab is pinned');
        return {};
    }

    if (!tab.groupId) {
        log.stop('tab does not have group id');
        return {};
    }

    log.log(tab);

    const canRecreateTab = method === 'GET';
    const {group: tabGroup, notArchivedGroups} = await Groups.load(tab.groupId);
    const destGroup = Groups.getCatchedForTab(notArchivedGroups, tabGroup, tab);

    if (destGroup) {
        if (!canRecreateTab && Tabs.getNewTabContainer(tab, destGroup) !== tab.cookieStoreId) {
            log.stop('skip move: only GET request can be reopened in another container', {method, destGroupId: destGroup.id});
            return {};
        }

        // past the cache: the origin check wants the url the tab really shows, not the cache's
        // one for a blank tab (fillEmptyUrl), and the object only goes to Cache.setTab
        tab = await Tabs.get(tabId, {withSession: false});

        if (!tab) {
            log.stopWarn('tab not found', tabId);
            return {};
        }

        if (new URL(tab.url).origin !== new URL(requestedUrl).origin) {
            tab.favIconUrl = null;
            Cache.removeTabThumbnail(tab.id);
        }

        tab.url = requestedUrl;
        tab.status = browser.tabs.TabStatus.COMPLETE;
        Cache.setTab(tab);

        moveTabsBatch.add(tab.id, destGroup.id);
        log.stop('move tab from groupId:', tabGroup.id, 'to groupId:', destGroup.id);
        return {};
    }

    const newTabContainer = Tabs.getNewTabContainer(tab, tabGroup);

    if (tab.cookieStoreId === newTabContainer) {
        log.stop('cookieStoreId is equal');
        return {};
    }

    if (!canRecreateTab) {
        log.stop('only GET request can be reopened in another container', method);
        return {};
    }

    function rememberFor(map, key, ms) {
        clearTimeout(map.get(key));
        map.set(key, setTimeout(() => map.delete(key), ms));
    }

    // the copy is built from this object: the whole session of the original goes with it
    tab = await getRequestedTab(tabId, requestedUrl);

    if (!tab) {
        log.stop('tab not found, maybe reopened by another extension', tabId);
        return {};
    }

    rememberFor(canceledRequests, requestId, 2000);

    const newTabParams = {
        ...tab,
        cookieStoreId: newTabContainer,
        ...Groups.getNewTabParams(tabGroup),
    };

    reopenTabsBatch.add([tab.id, newTabParams], tabGroup.id);

    log.stop('reopen tab');
    return {cancel: true};
}, logger);

const onPermissionsAdded = catchFunc(async function onPermissionsAdded(permissions) {
    const log = logger.start('onPermissionsAdded', permissions);

    if (Permissions.hasAny(permissions, Permissions.BROWSER_SETTINGS)) {
        await BrowserSettings.set(options.browserSettings);
    }

    log.stop();
}, logger);

const onPermissionsRemoved = catchFunc(async function onPermissionsRemoved(permissions) {
    const log = logger.start('onPermissionsRemoved', permissions);

    // if (Permissions.hasAny(permissions, Permissions.BOOKMARKS)) {
    //     await MenusMain.permissionChanged();
    // }

    log.stop();
}, logger);

async function onAlarm({name}) {
    const log = logger.start('onAlarm', {name});

    if (name === LOCAL_BACKUP_ALARM_NAME) {
        await createBackup({
            includeFavIconUrl: options.autoBackupIncludeTabFavIcons,
            includeThumbnail: options.autoBackupIncludeTabThumbnails,
        }, true)
            .catch(log.onCatch(["can't createBackup()", {
                autoBackupIncludeTabFavIcons: options.autoBackupIncludeTabFavIcons,
                autoBackupIncludeTabThumbnails: options.autoBackupIncludeTabThumbnails,
            }]));
    }

    log.stop();
}

// wait for reload addon if found update
// Listeners.runtime.onUpdateAvailable.add(() => Utils.safeReloadAddon());

function addListenerOnBeforeRequest() {
    logger.log('addListenerOnBeforeRequest');
    Listeners.webRequest.onBeforeRequest.add(onBeforeTabRequest);
}

function removeListenerOnBeforeRequest() {
    logger.log('removeListenerOnBeforeRequest');
    Listeners.webRequest.onBeforeRequest.clear();
}

function addEvents() {
    logger.info('addEvents');

    Tabs.addListeners();
    Windows.addListeners();
    GroupsNative.addListeners();

    Permissions.onAdded.add(onPermissionsAdded);
    Permissions.onRemoved.add(onPermissionsRemoved);

    Listeners.alarms.onAlarm.add(onAlarm);

    Menus.addListeners();
    MenusMain.addListeners();
}

function removeEvents() {
    logger.info('removeEvents');

    Tabs.removeListeners();
    Windows.removeListeners();
    GroupsNative.removeListeners();

    Permissions.onAdded.clear();
    Permissions.onRemoved.clear();

    Listeners.alarms.onAlarm.clear();

    Notification.removeListeners();
    Menus.removeListeners();
    MenusMain.removeListeners();


    removeListenerOnBeforeRequest();
}

const sendMessageFromBackground = self.sendMessageFromBackground = Messages.sendMessageFromBackground;

Listeners.runtime.onConnect.add(Messages.createListenerOnConnectedBackground(onBackgroundMessage));
Listeners.runtime.onMessage.add(onBackgroundMessage);
Listeners.commands.onCommand.add(name => onBackgroundMessage(name, self));

self.saveOptions = saveOptions;

const INTERNAL_MODULES = {
    BG: {
        saveOptions,
        restoreBackup,
        clearAddon,
    },
    Tabs,
    Groups,
    Windows,
    Organizer,
};

function isStgSender(sender) {
    return sender === self ||
        sender.id === browser.runtime.id ||
        sender.sender?.id === browser.runtime.id;
}

self.onBackgroundMessage = onBackgroundMessage;

async function onBackgroundMessage(message, sender) {
    const isSTGMessage = isStgSender(sender);
    const senderToLogs = isSTGMessage ? browser.runtime.id : sender;

    let result = {
        ok: false,
    };

    const data = typeof message === 'string' ? { action: message } : message;

    if (!data?.action) {
        result.error = '[STG] invalid "action"';
        logger.error('onBackgroundMessage', result.error, data, senderToLogs);
        return result;
    }

    // simple messages
    switch (data.action) {
        case 'are-you-here':
            result.ok = storage.inited === true;
            return result;

        case 'save-log':
            addLog(data.log);
            showLog.call(data.logger, data.log, data.options);
            result.ok = true;
            return result;

        case 'show-error-notification':
            sendMessageFromBackground('show-error-notification');

            Notification('whatsWrongMessage', {
                iconUrl: '/icons/exclamation-triangle-yellow.svg',
                module: ['windows', 'createPopup', {
                    url: Constants.PAGES.HELP.DEBUG,
                }],
                expires: Notification.MAX_EXPIRES,
            });

            result.ok = true;
            return result;

        case 'safe-reload-addon':
            Utils.safeReloadAddon();
            result.ok = true;
            return result;

        default: break;
    }

    if (isSTGMessage) {
        const moduleMethod = data.action.split('.').reduce((obj, key) => obj?.[key], INTERNAL_MODULES);

        if (moduleMethod) {
            logger.info('onBackgroundMessage internal module', `ACTION#${data.action}`);

            try {
                return await moduleMethod(...data.args);
            } catch (e) {
                const loggedArgs = data.action.startsWith('Organizer.') ? '[redacted]' : data.args;
                logger.throwError([
                    'onBackgroundMessage call internal module:', `ACTION#${data.action}`,
                    'args:', loggedArgs,
                    // 'sender:', senderToLogs,
                    objectToNativeError(data.breadcrumbs),
                ], e);
            }
        }
    }

    const log = logger.start(
        ['info', 'onBackgroundMessage'],
        ...(isSTGMessage ? [`ACTION#${data.action}`] : ['REJECTED-FOREIGN-ACTION', data])
    );

    try {
        const currentWindow = await Windows.getLastFocusedNormalWindow(false);

        if (!currentWindow) {
            throw new Error('no windows found');
        }

        const {
            group: currentGroup,
            groups,
            notArchivedGroups,
        } = await Groups.load(currentWindow.groupId);

        if (data.windowId === browser.windows.WINDOW_ID_CURRENT) {
            data.windowId = currentWindow.id;
        }

        log.log('check action, data:', data);

        switch (data.action) {
            case 'load-next-group':
                result.ok = await Groups.applyByPosition('next', currentWindow.id, notArchivedGroups, currentGroup?.id);
                break;
            case 'load-prev-group':
                result.ok = await Groups.applyByPosition('prev', currentWindow.id, notArchivedGroups, currentGroup?.id);
                break;
            case 'load-next-unloaded-group':
                {
                    const unloadedGroups = notArchivedGroups.filter(group => !Cache.getWindowId(group.id) || group.id === currentGroup?.id);
                    result.ok = await Groups.applyByPosition('next', currentWindow.id, unloadedGroups, currentGroup?.id);
                }
                break;
            case 'load-prev-unloaded-group':
                {
                    const unloadedGroups = notArchivedGroups.filter(group => !Cache.getWindowId(group.id) || group.id === currentGroup?.id);
                    result.ok = await Groups.applyByPosition('prev', currentWindow.id, unloadedGroups, currentGroup?.id);
                }
                break;
            case 'load-next-non-empty-group':
                {
                    const {notArchivedGroups} = await Groups.load(null, true);
                    result.ok = await Groups.applyByPosition('next', currentWindow.id, notArchivedGroups.filter(group => group.tabs.length), currentGroup?.id);
                }
                break;
            case 'load-prev-non-empty-group':
                {
                    const {notArchivedGroups} = await Groups.load(null, true);
                    result.ok = await Groups.applyByPosition('prev', currentWindow.id, notArchivedGroups.filter(group => group.tabs.length), currentGroup?.id);
                }
                break;
            case 'load-history-next-group':
                result.ok = await Groups.applyByHistory('next', currentWindow.id, notArchivedGroups);
                break;
            case 'load-history-prev-group':
                result.ok = await Groups.applyByHistory('prev', currentWindow.id, notArchivedGroups);
                break;
            case 'load-first-group':
                if (notArchivedGroups.length) {
                    result.ok = await Groups.apply(currentWindow.id, notArchivedGroups.shift().id);
                }
                break;
            case 'load-last-group':
                if (notArchivedGroups.length) {
                    result.ok = await Groups.apply(currentWindow.id, notArchivedGroups.pop().id);
                }
                break;
            case 'load-custom-group':
                if (data.groupId === 'new') {
                    let {ok, group} = await onBackgroundMessage({
                        action: 'add-new-group',
                        proposalTitle: data.title,
                    }, sender);

                    if (ok) {
                        result.ok = await Groups.apply(currentWindow.id, group.id);
                    }
                } else if (data.groupId) {
                    let groupToLoad = groups.find(group => group.id === data.groupId);

                    if (groupToLoad) {
                        if (groupToLoad.isArchive) {
                            result.error = Lang('groupIsArchived', groupToLoad.title);
                            Notification(result.error);
                        } else {
                            if (data.windowId) {
                                if (data.windowId === 'new') {
                                    await Windows.create(data.groupId, data.tabId);
                                    result.ok = true;
                                } else if (Number.isSafeInteger(data.windowId) && data.windowId > 0) {
                                    result.ok = await Groups.apply(data.windowId, data.groupId, data.tabId);
                                } else {
                                    result.error = 'Invalid window id';
                                }
                            } else {
                                result.ok = await Groups.apply(currentWindow.id, data.groupId, data.tabId);
                            }
                        }
                    } else {
                        delete data.groupId;
                        result = await onBackgroundMessage(data, sender);
                    }
                } else {
                    let activeTab = await Tabs.getActive();

                    if (Tabs.isCanSendMessage(activeTab)) {
                        Tabs.sendMessage(activeTab.id, {
                            action: 'show-groups-popup',
                            popupAction: 'load-custom-group',
                            popupTitle: Lang('hotkeyActionTitleLoadCustomGroup'),
                            groups: mapGroupsForPage(notArchivedGroups),
                            disableGroupIds: [currentGroup?.id].filter(Boolean),
                        });

                        result.ok = true;
                    } else {
                        result.error = Lang('impossibleToAskUserAboutAction', [
                            activeTab.title,
                            Lang('hotkeyActionTitleLoadCustomGroup'),
                        ]);
                        Notification(result.error, {
                            module: ['tabs', 'createUrlOnce', Constants.PAGES.DOC.UNSUPPORTED_URL],
                        });
                    }
                }
                break;
            case 'unload-group':
                if (currentGroup) {
                    result.ok = await Groups.unload(currentGroup.id);
                }
                break;
            case 'add-new-group':
                if (!options.alwaysAskNewGroupName || data.title) {
                    const newGroup = await Groups.add(data.windowId, data.tabIds, data.title);

                    result.ok = true;
                    result.group = newGroup;
                } else {
                    const activeTab = await Tabs.getActive();
                    const {defaultGroupProps} = await Groups.getDefaults();
                    data.proposalTitle = Groups.createTitle(data.proposalTitle, null, defaultGroupProps);

                    if (Tabs.isCanSendMessage(activeTab)) {
                        const title = await Tabs.sendMessage(activeTab.id, {
                            action: 'show-prompt',
                            promptTitle: Lang('createNewGroup'),
                            value: data.proposalTitle,
                        });

                        if (title) {
                            result = await onBackgroundMessage({
                                action: 'add-new-group',
                                title: title,
                                tabIds: data.tabIds,
                                windowId: data.windowId,
                            }, sender);
                        } else {
                            result.error = 'title is empty - skip create group';
                        }
                    } else {
                        result = await onBackgroundMessage({
                            action: 'add-new-group',
                            title: data.proposalTitle,
                            tabIds: data.tabIds,
                            windowId: data.windowId,
                        }, sender);

                        if (options.alwaysAskNewGroupName) {
                            result.error = Lang('impossibleToAskUserAboutAction', [
                                activeTab.title,
                                Lang('createNewGroup'),
                            ]);
                            Notification(result.error, {
                                module: ['tabs', 'createUrlOnce', Constants.PAGES.DOC.UNSUPPORTED_URL],
                            });
                        }
                    }
                }
                break;
            case 'rename-group':
                if (!groups.length) {
                    result.error = Lang('noGroupsAvailable');
                    Notification(result.error);
                } else if (!data.groupId) {
                    let activeTab = await Tabs.getActive();

                    if (Tabs.isCanSendMessage(activeTab)) {
                        Tabs.sendMessage(activeTab.id, {
                            action: 'show-groups-popup',
                            popupAction: 'rename-group',
                            popupTitle: Lang('hotkeyActionTitleRenameGroup'),
                            groups: mapGroupsForPage(groups),
                            focusedGroupId: currentGroup?.id,
                            disableNewGroupItem: true,
                        });

                        result.ok = true;
                    } else {
                        result.error = Lang('impossibleToAskUserAboutAction', [
                            activeTab.title,
                            Lang('hotkeyActionTitleRenameGroup'),
                        ]);
                        Notification(result.error, {
                            module: ['tabs', 'createUrlOnce', Constants.PAGES.DOC.UNSUPPORTED_URL],
                        });
                    }
                } else if (data.groupId && !data.title) {
                    let groupToRename = groups.find(group => group.id === data.groupId);

                    if (groupToRename) {
                        let activeTab = await Tabs.getActive();

                        if (Tabs.isCanSendMessage(activeTab)) {
                            let title = await Tabs.sendMessage(activeTab.id, {
                                action: 'show-prompt',
                                promptTitle: Lang('hotkeyActionTitleRenameGroup'),
                                value: groupToRename.title,
                            });

                            if (title) {
                                data.title = title;
                                result = await onBackgroundMessage(data, sender);
                            } else {
                                result.error = 'title in empty - skip rename group';
                            }
                        } else {
                            result.error = Lang('impossibleToAskUserAboutAction', [
                                activeTab.title,
                                Lang('hotkeyActionTitleRenameGroup'),
                            ]);
                            Notification(result.error, {
                                module: ['tabs', 'createUrlOnce', Constants.PAGES.DOC.UNSUPPORTED_URL],
                            });
                        }
                    } else {
                        result = await onBackgroundMessage('rename-group', sender);
                    }
                } else if (data.groupId && data.title && typeof data.title === 'string') {
                    let groupToRename = groups.find(group => group.id === data.groupId);

                    if (groupToRename) {
                        Groups.update(groupToRename.id, {
                            title: data.title,
                        });
                        result.ok = true;
                    } else {
                        result = await onBackgroundMessage('rename-group', sender);
                    }
                } else {
                    result = await onBackgroundMessage('rename-group', sender);
                }
                break;
            case 'export-group-to-bookmarks':
                if (!await Bookmarks.hasPermission()) {
                    result.error = Lang('noAccessToBookmarks');
                    break;
                }

                if (data.groupId) {
                    const {
                        group: groupToExport,
                        groupIndex,
                    } = await Groups.load(data.groupId, true);

                    if (groupToExport) {
                        await Browser.actionLoading();
                        result.ok = await Bookmarks.exportGroup(groupToExport, groupIndex);
                        await Browser.actionLoading(false);

                        if (data.showMessages) {
                            Notification(['groupExportedToBookmarks', groupToExport.title]);
                        }
                    } else {
                        // delete data.groupId;
                        result.error = Lang('groupNotFound');
                    }
                }

                if (!data.groupId) {
                    let activeTab = await Tabs.getActive();

                    if (Tabs.isCanSendMessage(activeTab)) {
                        Tabs.sendMessage(activeTab.id, {
                            action: 'show-groups-popup',
                            popupAction: 'export-group-to-bookmarks',
                            popupTitle: Lang('exportGroupToBookmarks'),
                            groups: mapGroupsForPage(groups),
                            focusedGroupId: currentGroup?.id,
                            disableNewGroupItem: true,
                        });

                        result.ok = true;
                    } else {
                        result.error = Lang('impossibleToAskUserAboutAction', [
                            activeTab.title,
                            Lang('hotkeyActionTitleRenameGroup'),
                        ]);
                        Notification(result.error, {
                            module: ['tabs', 'createUrlOnce', Constants.PAGES.DOC.UNSUPPORTED_URL],
                        });
                    }
                }
                break;
            case 'remove-group-from-bookmarks':
                if (!await Bookmarks.hasPermission()) {
                    result.error = Lang('noAccessToBookmarks');
                    break;
                }

                if (data.groupId) {
                    const {group} = await Groups.load(data.groupId);

                    if (group) {
                        await Browser.actionLoading();
                        result.ok = await Bookmarks.removeGroup(group);
                        await Browser.actionLoading(false);
                    } else {
                        result.error = Lang('groupNotFound');
                    }
                } else {
                    result.error = Lang('groupNotFound');
                }
                break;
            case 'delete-current-group':
                if (currentGroup) {
                    await Groups.remove(currentGroup.id);

                    if (!isSTGMessage && sender?.id) {
                        Notification([
                            'groupRemovedByExtension',
                            currentGroup.title,
                            Utils.getSupportedExternalExtensionName(sender.id),
                        ]);
                    }

                    result.ok = true;
                } else {
                    result.error = Lang('windowNotHaveGroup');
                }

                break;
            case 'open-manage-groups':
                if (options.openManageGroupsInTab) {
                    await Tabs.createUrlOnce(Constants.PAGES.MANAGE);
                } else {
                    const manageStorage = localStorage.create(Constants.MODULES.MANAGE);

                    await Windows.createPopup({
                        url: Constants.PAGES.MANAGE,
                        width: manageStorage.windowWidth ?? 1000,
                        height: manageStorage.windowHeight ?? 700,
                    });
                }
                result.ok = true;
                break;
            case 'open-options-page':
                const settingsUrl = Constants.PAGES.SETTINGS + (data.section ? `#${data.section}` : '');
                await Tabs.createUrlOnce(settingsUrl);
                result.ok = true;
                break;
            case 'open-debug-page':
                await Windows.createPopup({
                    url: Constants.PAGES.HELP.DEBUG,
                });
                result.ok = true;
                break;
            case 'move-selected-tabs-to-custom-group':
                let activeTab = await Tabs.getActive(),
                    tabIds = await Tabs.getHighlightedIds(activeTab.windowId, undefined, null);

                if (data.groupId === 'new') {
                    let {ok} = await onBackgroundMessage({
                        action: 'add-new-group',
                        title: data.title,
                        proposalTitle: activeTab.title,
                        tabIds: tabIds,
                    }, sender);

                    result.ok = ok;
                } else if (data.groupId) {
                    let groupMoveTo = groups.find(group => group.id === data.groupId);

                    if (groupMoveTo) {
                        if (groupMoveTo.isArchive) {
                            result.error = Lang('groupIsArchived', groupMoveTo.title);
                            Notification(result.error);
                        } else {
                            await Tabs.move(tabIds, data.groupId);
                            result.ok = true;
                        }
                    } else {
                        delete data.groupId;
                        result = await onBackgroundMessage(data, sender);
                    }
                } else {
                    if (Tabs.isCanSendMessage(activeTab)) {
                        Tabs.sendMessage(activeTab.id, {
                            action: 'show-groups-popup',
                            popupAction: data.action,
                            popupTitle: Lang('hotkeyActionTitleMoveSelectedTabsToCustomGroup'),
                            groups: mapGroupsForPage(notArchivedGroups),
                            focusedGroupId: activeTab.groupId,
                        });

                        result.ok = true;
                    } else {
                        result.error = Lang('impossibleToAskUserAboutAction', [
                            activeTab.title,
                            Lang('hotkeyActionTitleMoveSelectedTabsToCustomGroup'),
                        ]);
                        Notification(result.error, {
                            module: ['tabs', 'createUrlOnce', Constants.PAGES.DOC.UNSUPPORTED_URL],
                        });
                    }
                }
                break;
            case 'discard-group':
                {
                    const { groups, notArchivedGroups } = await Groups.load(null, true);

                    let groupToDiscard = groups.find(group => group.id === data.groupId);

                    if (groupToDiscard) {
                        if (groupToDiscard.isArchive) {
                            result.error = Lang('groupIsArchived', groupToDiscard.title);
                            Notification(result.error);
                        } else {
                            await Tabs.discard(groupToDiscard.tabs);
                            result.ok = true;
                        }
                    } else {
                        let activeTab = await Tabs.getActive();

                        if (Tabs.isCanSendMessage(activeTab)) {
                            Tabs.sendMessage(activeTab.id, {
                                action: 'show-groups-popup',
                                popupAction: 'discard-group',
                                popupTitle: Lang('hotkeyActionTitleDiscardGroup'),
                                groups: mapGroupsForPage(notArchivedGroups),
                                focusedGroupId: currentGroup?.id,
                                disableNewGroupItem: true,
                            });

                            result.ok = true;
                        } else {
                            result.error = Lang('impossibleToAskUserAboutAction', [
                                activeTab.title,
                                Lang('hotkeyActionTitleDiscardGroup'),
                            ]);
                            Notification(result.error, {
                                module: ['tabs', 'createUrlOnce', Constants.PAGES.DOC.UNSUPPORTED_URL],
                            });
                        }
                    }
                }
                break;
            case 'discard-other-groups':
                {
                    let { notArchivedGroups } = await Groups.load(null, true);

                    let tabs = notArchivedGroups.reduce(function (acc, gr) {
                        if (gr.id !== currentGroup?.id && !Cache.getWindowId(gr.id)) {
                            acc.push(...gr.tabs);
                        }
                        return acc;
                    }, []);

                    await Tabs.discard(tabs);

                    result.ok = true;
                }
                break;
            case 'reload-all-tabs-in-current-group':
                if (currentGroup) {
                    let { group } = await Groups.load(currentGroup.id, true);
                    await Tabs.reload(group.tabs);
                    result.ok = true;
                }

                break;
            case 'create-temp-tab':
                await Tabs.create({
                    active: data.active,
                    cookieStoreId: Constants.TEMPORARY_CONTAINER,
                }, {skipTrackingCreated: false});

                result.ok = true;

                break;
            case 'exclude-container-for-group':
                let group = groups.find(group => group.id === data.groupId);

                if (!group || !data.cookieStoreId || Containers.get(data.cookieStoreId).cookieStoreId !== data.cookieStoreId) {
                    throw new Error('invalid groupId or cookieStoreId');
                }

                await Groups.update(data.groupId, group => {
                    if (group.excludeContainersForReOpen.includes(data.cookieStoreId)) {
                        return {};
                    }

                    return {
                        excludeContainersForReOpen: [...group.excludeContainersForReOpen, data.cookieStoreId],
                    };
                });

                result.ok = true;

                break;
            case 'create-backup':
                result.ok = await createBackup({
                    includeFavIconUrl: data.includeFavIconUrl === true,
                    includeThumbnail: data.includeThumbnail === true,
                });
                break;
            case 'get-startup-data':
                {
                    const includeThumbnail = data.isManage === true;

                    [
                        result.windows,
                        {groups: result.groups},
                    ] = await Promise.all([
                        Windows.load(true, {includeFavIconUrl: true, includeThumbnail}),
                        Groups.load(null, true, {includeFavIconUrl: true, includeThumbnail}),
                    ]);

                    result.ok = true;
                }

                break;
            default:
                throw new Error(`Action '${data.action}' is wrong`);
        }

    } catch (e) {
        result.error = '[STG] ' + String(e);
        log.logError(e.message || e, e);
    }

    result.error ? log.stopError(result.error) : log.stop();

    return result;
}

async function saveOptions(_options) {
    const log = logger.start('saveOptions');

    if (!storage.inited) {
        log.stopError('background not yet inited');
        return;
    }

    const optionsToSave = {};

    for (const [key, value] of Object.entries(_options)) {
        if (Constants.ALL_OPTION_KEYS.includes(key)) {
            optionsToSave[key] = Utils.isPrimitive(value) ? value : JSON.clone(value);
        } else if (!Constants.NON_OPTION_KEYS.includes(key)) {
            log.throwError(`option key "${key}" is unknown`);
        }
    }

    const optionsKeys = Object.keys(optionsToSave);

    if (!optionsKeys.length) {
        log.stop('options not found');
        return;
    }

    await Storage.set(optionsToSave);

    Object.assign(options, optionsToSave);

    if (optionsKeys.includes('hotkeys')) {
        const tabs = await Tabs.query({discarded: false}),
            actionData = JSON.clone({
                action: 'update-hotkeys',
                hotkeys: options.hotkeys,
            });

        tabs.forEach(tab => Tabs.sendMessage(tab.id, actionData));
    }

    if (optionsKeys.some(key => ['autoBackupEnable', 'autoBackupIntervalKey', 'autoBackupIntervalValue'].includes(key))) {
        await resetLocalBackupAlarm();
    }

    if (optionsKeys.includes('temporaryContainerTitle')) {
        await Containers.updateTemporaryContainerTitle(options.temporaryContainerTitle);
    }

    sendMessageFromBackground('options-updated', {
        keys: optionsKeys,
    });

    log.stop();
}

const LOCAL_BACKUP_ALARM_NAME = 'local-backup';

async function resetLocalBackupAlarm() {
    await resetAlarm(
        LOCAL_BACKUP_ALARM_NAME,
        options.autoBackupEnable,
        options.autoBackupIntervalKey,
        options.autoBackupIntervalValue,
        storage.autoBackupLastTimeStamp
    );
}

async function resetAlarm(
        name,
        isEnable,
        intervalKey,
        intervalValue,
        lastAlarmRunUnixTime = Utils.unixNow(),
        minDelayMinutes = 0.5
    ) {
    const log = logger.start('resetAlarm', {name, isEnable, intervalKey, intervalValue, lastAlarmRunUnixTime, minDelayMinutes});

    await browser.alarms.clear(name);

    if (!isEnable) {
        log.stop(name, 'is disabled');
        return;
    }

    let periodInMinutes;

    if (Constants.INTERVAL_KEY.minutes === intervalKey) {
        periodInMinutes = intervalValue;
    } else if (Constants.INTERVAL_KEY.hours === intervalKey) {
        periodInMinutes = intervalValue * 60;
    } else if (Constants.INTERVAL_KEY.days === intervalKey) {
        periodInMinutes = intervalValue * 60 * 24;
    }

    const minutesNow = Math.floor(Utils.unixNow() / 60);
    const minutesWhenBackup = periodInMinutes + Math.floor(lastAlarmRunUnixTime / 60);

    const delayInMinutes = minutesWhenBackup > minutesNow
        ? minutesWhenBackup - minutesNow
        : minDelayMinutes;

    await browser.alarms.create(name, {
        delayInMinutes,
        periodInMinutes,
    });

    log.stop();
}

async function createBackup(params = {}, isAutoBackup = false) {
    const log = logger.start('createBackup', {params, isAutoBackup});

    const data = stampVersion(await Storage.get());
    const {groups} = await Groups.load(null, true, params);

    if (isAutoBackup && (!groups.length || groups.filter(gr => !gr.isArchive).every(gr => !gr.tabs.length))) {
        log.stopWarn('skip create auto backup, groups are empty');
        return false;
    }

    const pinnedTabs = await Tabs.query({pinned: true}, {withSession: false});

    if (pinnedTabs.length) {
        data.pinnedTabs = Tabs.prepareForSave(pinnedTabs, {includeOpener: false});
    }

    data.groups = groups.map(group => {
        if (!group.isArchive) {
            group.groupsNative = GroupsNative.referencedGroupsNative(group);
        }

        group.tabs = Tabs.prepareForSave(group.tabs, params);

        return group;
    });

    data.containers = Containers.getToExport(data);

    if (isAutoBackup) {
        await File.saveBackup(data, true);

        await Bookmarks.exportGroups(data.groups).catch(log.onCatch('cant create bookmarks', false));

        storage.autoBackupLastTimeStamp = Utils.unixNow();
    } else {
        await File.saveBackup(data, false);
    }

    log.stop();

    return true;
}

// data may not be a full backup, but a partial of it
async function restoreBackup(data, clearAddonDataBeforeRestore = false) {
    normalizeStandaloneOptions(data);

    data.groups = data.groups?.filter(group => {
        if (!group.tabs) {
            throw new Error(`group "${group.id}" has no tabs`);
        }

        return true;
    });

    removeEvents();

    sendMessageFromBackground('lock-addon');

    await Browser.actionLoading();

    const currentData = {};

    if (clearAddonDataBeforeRestore) {
        await clearAddon(false);

        // await Utils.wait(1000);
    }

    Containers.mapDefaultContainer(data, Constants.DEFAULT_COOKIE_STORE_ID);

    if (data.temporaryContainerTitle) {
        await Containers.updateTemporaryContainerTitle(data.temporaryContainerTitle);
    }

    // the backup's thumbnails option applies to the restore itself, ahead of the storage write
    if (clearAddonDataBeforeRestore) {
        options.showTabsWithThumbnailsInManageGroups = Constants.DEFAULT_OPTIONS.showTabsWithThumbnailsInManageGroups;
    }

    if (data.hasOwnProperty('showTabsWithThumbnailsInManageGroups')) {
        options.showTabsWithThumbnailsInManageGroups = data.showTabsWithThumbnailsInManageGroups;
    }

    Cache.setUseThumbnails(options.showTabsWithThumbnailsInManageGroups);

    if (clearAddonDataBeforeRestore) {
        currentData.groups = [];
        currentData.hotkeys = [];
    } else {
        [
            {hotkeys: currentData.hotkeys},
            {groups: currentData.groups},
        ] = await Promise.all([
            Storage.get('hotkeys'),
            Groups.load(null, true, {includeFavIconUrl: true, includeThumbnail: true}),
        ]);
    }

    data.groups ??= [];
    data.hotkeys ??= [];

    const existGroupIds = new Set(currentData.groups.map(({id}) => id));
    const restoreGroupIds = new Set(data.groups.map(({id}) => id));

    for (const groupToRestore of data.groups) {
        if (
            groupToRestore.moveToGroupIfNoneCatchTabRules &&
            !existGroupIds.has(groupToRestore.moveToGroupIfNoneCatchTabRules) &&
            !restoreGroupIds.has(groupToRestore.moveToGroupIfNoneCatchTabRules)
        ) {
            groupToRestore.moveToGroupIfNoneCatchTabRules = null;
        }
    }

    const neededContainers = new Set;
    const defaultGroupProps = clearAddonDataBeforeRestore ? data.defaultGroupProps : options.defaultGroupProps;

    data.groups = data.groups.map(group => {
        const newGroupId = existGroupIds.has(group.id)
            ? Groups.createId()
            : (group.id || Groups.createId());

        const newGroup = Groups.create(newGroupId, group.title, defaultGroupProps);

        for (const key in group) {
            if (key === 'id') {
                continue;
            }

            if (newGroup.hasOwnProperty(key)) {
                newGroup[key] = group[key];
            }
        }

        if (newGroupId !== group.id) {
            // restoring a copy next to the original - the copy's sub-groups get their own identity
            const newSubIdByOldId = new Map(newGroup.groupsNative.map(entry => [entry.id, GroupsNative.createSubGroupId()]));

            newGroup.groupsNative = newGroup.groupsNative.map(entry => ({...entry, id: newSubIdByOldId.get(entry.id)}));

            for (const tab of newGroup.tabs) {
                const newSubId = newSubIdByOldId.get(tab.groupNativeId);
                newSubId ? tab.groupNativeId = newSubId : delete tab.groupNativeId;
            }
        }

        for (const tab of newGroup.tabs) {
            if (Containers.isDefault(tab.cookieStoreId) || Containers.isTemporary(tab.cookieStoreId)) {
                continue;
            }

            neededContainers.add(tab.cookieStoreId);
        }

        return newGroup;
    });

    data.groups = [...currentData.groups, ...data.groups];
    data.hotkeys = [...currentData.hotkeys, ...data.hotkeys];

    data.hotkeys = data.hotkeys.filter((hotkey, index, self) => {
        return self.findIndex(h => h.value === hotkey.value) === index;
    });

    if (data.containers) {
        const containersStorageMap = new Map;

        for (const [cookieStoreId, value] of Object.entries(data.containers)) {
            if (!neededContainers.has(cookieStoreId)) {
                continue;
            }

            const newCookieStoreId = await Containers.findExistOrCreateSimilar(cookieStoreId, value, containersStorageMap);

            if (newCookieStoreId !== cookieStoreId) {
                for (const group of data.groups) {
                    if (group.newTabContainer === cookieStoreId) {
                        group.newTabContainer = newCookieStoreId;
                    }

                    group.excludeContainersForReOpen = group.excludeContainersForReOpen
                        .map(csId => csId === cookieStoreId ? newCookieStoreId : csId);

                    group.catchTabContainers = group.catchTabContainers
                        .map(csId => csId === cookieStoreId ? newCookieStoreId : csId);
                }
            }
        }
    }

    delete data.containers;

    const allTabs = await Tabs.query({pinned: false}, {
        includeFavIconUrl: true,
        includeThumbnail: true,
    });

    await Tabs.reconcile(data.groups, allTabs);

    if (Array.isArray(data.pinnedTabs)) {
        const currentPinnedTabs = await Tabs.query({pinned: true}, {withSession: false});

        data.pinnedTabs = data.pinnedTabs.filter(tab => {
            tab.pinned = true;
            return !currentPinnedTabs.some(t => t.url === tab.url);
        });

        if (data.pinnedTabs.length) {
            await Tabs.createMultiple(data.pinnedTabs);
        }
    }

    delete data.pinnedTabs;

    let result;

    if (clearAddonDataBeforeRestore) {
        const defaultOptions = JSON.clone(Constants.DEFAULT_OPTIONS);

        result = Object.assign(defaultOptions, data);
    } else {
        result = data;
    }

    await Storage.set(result);

    storage.isBackupRestoring = true;

    await Utils.wait(200);

    browser.runtime.reload(); // reload addon
}

async function clearAddon(reloadAddonOnFinish = true) {
    if (reloadAddonOnFinish) {
        await Browser.actionLoading();
        sendMessageFromBackground('lock-addon');
    }

    removeEvents();

    const [tabs, windows] = await Promise.all([Tabs.query(), Windows.load()]);

    await Promise.all(tabs.map(tab => Cache.removeTabSession(tab.id)));
    await Promise.all(windows.map(win => Cache.removeWindowSession(win.id)));

    await Storage.clear();

    Cache.clear();

    localStorage.clear();

    if (reloadAddonOnFinish) {
        browser.runtime.reload(); // reload addon
    }
}

self.addListenerOnBeforeRequest = addListenerOnBeforeRequest;
self.removeListenerOnBeforeRequest = removeListenerOnBeforeRequest;

// { reason: "update", previousVersion: "3.0.1", temporary: true }
// { reason: "install", temporary: true }
Listeners.runtime.onInstalled.add(async ({reason, previousVersion, temporary}) => {
    const log = logger.start('runtime.onInstalled', {reason, previousVersion, temporary});

    if (temporary) {
        storage.IS_TEMPORARY = true;
        log.log('addon is temp');
    } else if (
        reason === browser.runtime.OnInstalledReason.INSTALL ||
        (
            reason === browser.runtime.OnInstalledReason.UPDATE &&
            Utils.compareNumericVersions(previousVersion, '5.0') < 0
        )
    ) {
        log.log('open welcome');
        await Tabs.create({
            url: Constants.PAGES.HELP.WELCOME,
            active: true,
        }, {skipTrackingCreated: false});
    }

    log.stop();
});

async function init() {
    const log = logger.start(['info', '[init]']);
    startupDebug('init:start');

    try {
        startupDebug('init:load-local-data');
        const {data, error} = await initLocalData();

        if (error) {
            Notification(error);
            throw '';
        }

        const dataChanged = new Set;

        Utils.assignKeys(options, data, Constants.ALL_OPTION_KEYS);
        startupDebug('init:options-loaded', {groups: data.groups?.length ?? 0});

        if (await BrowserSettings.hasPermission()) {
            await BrowserSettings.set(options.browserSettings);
        }

        dataChanged.add(Groups.normalizeContainersInGroups(data.groups));

        if (dataChanged.has(true)) {
            log.log('data was changed, saving data');
            await Storage.set(data);
        }

        let windows = await Windows.load();
        startupDebug('init:windows-loaded', {count: windows.length});

        if (!windows.length) {
            log.error('no windows found');
            storage.notFoundWindowsAddonStoppedWorking = 1;
            // Notification('notFoundWindowsAddonStoppedWorking');
            Listeners.windows.onCreated.add(() => browser.runtime.reload());
            throw '';
        } else if (storage.notFoundWindowsAddonStoppedWorking) {
            log.warn('try run grand restore, attempt:', storage.notFoundWindowsAddonStoppedWorking);

            try {
                await Promise.all(windows.map(win => Windows.GrandRestore(win.id)));
            } catch (e) {
                log.logError('cant grand restore', e);
                if (storage.notFoundWindowsAddonStoppedWorking++ < 10) {
                    browser.runtime.reload();
                } else {
                    await setActionToReloadAddon();
                }
                log.stop();
                return;
            }

            log.info('grand restore finish');

            delete storage.notFoundWindowsAddonStoppedWorking;
        }

        await Windows.tryRestoreMissedTabs(false);

        windows = await Windows.initializeGroups(data.groups, storage.isBackupRestoring);
        startupDebug('init:groups-initialized', {windows: windows.length});

        await Groups.fillHistory(windows);

        let tabs = Utils.flatTabs(windows);

        await Containers.removeUnusedTemporaryContainers(tabs);
        log.log('Containers.removeUnusedTemporaryContainers finish');

        await Tabs.restoreOldExtensionUrls();
        log.log('restoreOldExtensionUrls finish');

        await resetLocalBackupAlarm();
        startupDebug('init:local-backup-alarm-ready');

        await MenusMain.create();
        log.log('MenusMain.create finish');

        addEvents();

        if (Groups.isNeedBlockBeforeRequest(data.groups)) {
            log.log('addListenerOnBeforeRequest');
            addListenerOnBeforeRequest();
        }

        if (storage.isBackupRestoring) {
            delete storage.isBackupRestoring;
            Notification('backupSuccessfullyRestored');
        }

        await Browser.actionLoading(false);

        storage.inited = true;
        startupDebug('init:ready');

        // send message for addon pages if it's open
        sendMessageFromBackground('i-am-back');

        // send message for addon plugins

        log.log('loading groups for creating cache...');
        await Groups.load(null, true, {includeFavIconUrl: true}); // load favIconUrls, speed up first run popup

        log.stop();
    } catch (e) {
        console.error('[STG startup] init:failed', e);
        await setActionToReloadAddon();

        if (e) {
            errorEventHandler.call(log, e);
            log.stopError('with errors');
        } else {
            log.stop();
        }
    }
}

async function setActionToReloadAddon() {
    await Browser.actionAllWindows({
        title: '__MSG_clickHereToReloadAddon__',
        icon: 'icons/exclamation-triangle-yellow.svg',
        popup: '',
        enable: true,
    });

    Listeners.browserAction.onClicked.add(() => browser.runtime.reload());
}

Listeners.extension.onStart.add(async () => {
    startupDebug('extension:onStart');
    await Browser.action({
        title: '__MSG_loading__',
        badgeBackgroundColor: 'transparent',
    });

    // delay startup to avoid errors with extensions "Facebook Container", "Firefox Multi-Account Containers" etc.
    // TransactionInactiveError: A request was placed against a transaction which is currently not active, or which is finished.
    // An unexpected error occurred
    // etc.
    self.setTimeout(init, 200);
});
